// GachaEngine.
//
//   openLine(ctx)             -> GachaResult  reads state, decides every slot, writes nothing
//   applyGachaResult(result)  -> persists it exactly once, awaiting every write
//   recoverPendingOpens()     -> rolls forward interrupted opens
//   openBox(ctx)              -> lock + recover + openLine + apply (what /open uses)
//
// Persistence mirrors the cast engine: journal as 'pending', consume the box (guarded), insert fish
// rewards (pre-generated ids), ONE atomic user update (fish ownership, stats, pity, box removal),
// idempotent item grants, mark 'applied'. Transactions are used when MongoDB supports them.
const mongoose = require('mongoose');
const { ObjectId } = mongoose.Types;
const { User: UserModel } = require('../schemas/UserSchema');
const { Fish: FishTemplate } = require('../schemas/FishSchema');
const { Item, ItemData } = require('../schemas/ItemSchema');
const { BuffData } = require('../schemas/BuffSchema');
const { Biome } = require('../schemas/BiomeSchema');
const { GachaOpen } = require('../schemas/GachaOpenSchema');
const { rng } = require('./rng');
const { BALANCE_VERSION, RARITIES, STAT_CAPS, resolveProfile, activeEvent } = require('./balance');
const { buildTable, applyPity, normalize, roll, toPercent } = require('./rarity');
const { boxDefinition } = require('./gachaBoxes');
const { oid, guardPush, grantItem, buildFishDoc, insertFishDocs, rollFishStats } = require('./rewards');
const { withUserLock } = require('./userLock');

const HIGH_TIER = ['legendary', 'lucky'];

class GachaDefinitionError extends Error {
	constructor(message) {
		super(message);
		this.name = 'GachaDefinitionError';
		this.code = 'GACHA_DEFINITION';
	}
}

/** Canonical rarity key ('Rare', 'rare', 'RARE' -> 'rare'); null if unknown. */
function canonicalRarity(rarity) {
	const key = String(rarity || '').trim().toLowerCase();
	return RARITIES.includes(key) ? key : null;
}

const plain = (doc) => (doc && typeof doc.toObject === 'function' ? doc.toObject() : doc);
const rarityIndex = (r) => RARITIES.indexOf(r);

/** Fish that can actually be caught (their biome exists), for fish rewards. */
async function catchableFish() {
	const biomes = await Biome.distinct('name');
	return FishTemplate.find({ user: null, biome: { $in: biomes } }).lean();
}

/**
 * Reward pools per canonical rarity for a definition. Each entry: { kind, template, weight }.
 * Exclusions remove rewards; featured rewards get a higher pick weight within their rarity.
 */
async function buildPools(def) {
	const pools = Object.fromEntries(RARITIES.map((r) => [r, []]));
	const exclude = new Set((def.pool.exclude || []).map((n) => n.toLowerCase()));
	const featured = def.pool.featured || [];
	const weightOf = (name) => featured.filter((f) => f.names.map((n) => n.toLowerCase()).includes(name.toLowerCase())).reduce((w, f) => w * f.weight, 1);

	const items = def.pool.types.length ? await Item.find({ type: { $in: def.pool.types }, user: null }).lean() : [];
	const fish = def.pool.fish ? await catchableFish() : [];
	for (const [kind, list] of [['item', items], ['fish', fish]]) {
		for (const template of list) {
			const rarity = canonicalRarity(template.rarity);
			if (!rarity || exclude.has(template.name.toLowerCase())) continue;
			pools[rarity].push({ kind, template, weight: weightOf(template.name) });
		}
	}
	return pools;
}

function clampRarityStats(stats) {
	const out = {};
	for (const key of ['rareFind', 'luck', 'trophyChance']) {
		const v = Number(stats[key]) || 0;
		out[key] = Math.min(STAT_CAPS[key].max, Math.max(STAT_CAPS[key].min, v));
	}
	return out;
}

const maskBelow = (table, minRarity) => {
	const min = rarityIndex(minRarity);
	return Object.fromEntries(RARITIES.map((r) => [r, rarityIndex(r) >= min ? table[r] : 0]));
};

/**
 * Base per-slot table: the box's weights restricted to rarities that actually have rewards (so a
 * roll can never land on an empty pool - equivalent to the old re-roll, without looping), then the
 * rarity floor. Throws GachaDefinitionError if nothing is left.
 */
function baseTable(def, pools) {
	const available = Object.fromEntries(RARITIES.map((r) => [r, pools[r].length > 0 ? Number(def.rarityTable[r]) || 0 : 0]));
	let weights = available;
	if (def.rarityFloor) {
		const floored = maskBelow(available, def.rarityFloor);
		if (RARITIES.some((r) => floored[r] > 0)) weights = floored;
	}
	if (!RARITIES.some((r) => weights[r] > 0)) throw new GachaDefinitionError(`Box "${def.name}" has no rarity with both a weight and rewards.`);
	return normalize(weights);
}

/** Picks a reward from a rarity pool (featured-weighted), avoiding duplicates when asked. */
function pickReward(pool, taken, def) {
	let candidates = pool;
	if (def.duplicates === 'unique') {
		const fresh = pool.filter((e) => !taken.has(String(e.template._id)));
		if (fresh.length) candidates = fresh;
	}
	return rng.weighted(candidates, candidates.map((e) => e.weight)) || candidates[0];
}

function failure(base, code, message) {
	return { ...base, status: 'failed', failure: { code, message } };
}

/**
 * Decides a complete box opening without writing anything.
 * @param {{ userId, guildId?, boxName, now? }} ctx
 */
async function openLine({ userId, guildId = null, boxName, now = new Date() }) {
	const openId = new ObjectId().toString();
	const user = await UserModel.findOne({ userId: String(userId) });
	const profile = resolveProfile(userId, user);
	const base = { openId, userId: String(userId), guildId, createdAt: now, profile: profile.name, balanceVersion: BALANCE_VERSION, competitiveEligible: Boolean(profile.competitiveEligible) };
	if (!user) return failure(base, 'NO_USER', 'Player not found.');

	const owned = (await ItemData.find({ _id: { $in: user.inventory.gacha || [] } })).map(plain);
	const box = owned.find((b) => b.name.toLowerCase() === String(boxName).trim().toLowerCase() && (b.count || 0) >= 1 && !b.opened);
	if (!box) return failure(base, 'NO_BOX', 'You do not have a box with that name!');

	const def = boxDefinition(box.name, box);
	if (!def) return failure(base, 'UNKNOWN_BOX', 'That box cannot be opened.');
	const pools = await buildPools(def);
	const boxBase = baseTable(def, pools);

	// Modifiers: profile gacha stats + gacha buffs (legacy ['gacha', '1.5'] = +50% to every
	// Rare-and-above tier) + event gacha stats. Stats add, then feed the RarityEngine.
	const buffs = (await BuffData.find({ user: String(userId), active: true })).map(plain)
		.filter((b) => (b.capabilities || [])[0] === 'gacha');
	const sources = [{ source: 'box', name: def.name, id: def.id }, { source: 'profile', name: profile.name, stats: { ...(profile.gacha?.stats || {}) } }];
	const total = { ...(profile.gacha?.stats || {}) };
	for (const buff of buffs) {
		const bonus = (parseFloat(buff.capabilities[1]) || 1) - 1;
		const stats = { rareFind: bonus, trophyChance: bonus, luck: bonus };
		for (const [k, v] of Object.entries(stats)) total[k] = (total[k] || 0) + v;
		sources.push({ source: 'buff', id: String(buff._id), name: buff.name, stats });
	}
	const event = activeEvent(now);
	if (event?.gachaStats) {
		for (const [k, v] of Object.entries(event.gachaStats)) total[k] = (total[k] || 0) + v;
		sources.push({ source: 'event', name: event.name, stats: { ...event.gachaStats } });
	}
	const stats = clampRarityStats(total);
	const modified = buildTable(boxBase, stats);

	// Pity: box rules for everyone + profile rules; counters per box. Rules for tiers this box can
	// never award are skipped.
	const rules = { ...(def.pity || {}), ...(profile.gacha?.pity || {}) };
	const counterKey = (rule) => `${def.id}:${rule.counter}`;
	const pityConfig = Object.fromEntries(Object.entries(rules)
		.filter(([, rule]) => rule.tiers.some((t) => boxBase[t] > 0))
		.map(([name, rule]) => [name, { ...rule, counter: counterKey(rule) }]));
	const counterMap = user.pity?.gacha instanceof Map ? Object.fromEntries(user.pity.gacha) : { ...(user.pity?.gacha || {}) };
	const pityBefore = Object.fromEntries(Object.values(pityConfig).map((r) => [r.counter, counterMap[r.counter] || 0]));
	const pity = applyPity(modified, pityBefore, Object.keys(pityConfig).length ? pityConfig : null);

	// Slots.
	const slots = [];
	const fishDocs = [];
	const grants = [];
	const taken = new Set();
	let sharedRarity = null;
	for (let i = 0; i < def.slots; i++) {
		let table = pity.table;
		const guaranteedSlot = (def.guaranteedSlots || []).find((g) => g.slot === i);
		if (guaranteedSlot) {
			const masked = maskBelow(table, guaranteedSlot.minRarity);
			if (RARITIES.some((r) => masked[r] > 0)) table = normalize(masked);
		}
		const pityGuarantee = i === 0 && pity.guarantee ? pity.guarantee.filter((t) => table[t] > 0) : null;

		let rarity;
		if (def.strategy === 'shared' && sharedRarity) rarity = sharedRarity;
		else rarity = roll(table, rng, pityGuarantee && pityGuarantee.length ? pityGuarantee : null);
		if (def.strategy === 'shared') sharedRarity = rarity;

		// The table only contains rarities with rewards; this guard is for corrupted definitions.
		if (!pools[rarity]?.length) throw new GachaDefinitionError(`Box "${def.name}" rolled ${rarity} with no rewards.`);
		const entry = pickReward(pools[rarity], taken, def);
		taken.add(String(entry.template._id));

		const slot = {
			slot: i,
			baseTable: toPercent(boxBase, 4),
			table: toPercent(table, 4),
			rarity,
			guaranteed: Boolean(guaranteedSlot) || Boolean(pityGuarantee && pityGuarantee.length),
			reward: { kind: entry.kind, templateId: String(entry.template._id), name: entry.template.name, type: entry.template.type, rarity, icon: entry.template.icon, quantity: 1 },
		};

		if (entry.kind === 'fish') {
			const t = entry.template;
			const { size, weight, rawValue } = await rollFishStats(t);
			const sell = profile.multipliers.sell * (event?.multipliers?.sell || 1);
			const sellBase = event?.multipliers?.sell || 1;
			const value = Math.round(rawValue * sell);
			const valueBase = Math.round(rawValue * sellBase);
			const fishId = new ObjectId().toString();
			Object.assign(slot.reward, { id: fishId, size, weight, rawValue, value, valueBase });
			// Box fish were not caught: never competitive, whatever the profile.
			fishDocs.push(buildFishDoc({
				template: t, id: fishId, userId, guildId, count: 1, size, weight, value, valueBase, now,
				meta: { openId, source: 'gacha', profile: profile.name, balanceVersion: BALANCE_VERSION, competitiveEligible: false },
			}));
		}
		else {
			const grant = { key: `${openId}:slot:${i}`, templateId: String(entry.template._id), count: 1, newId: new ObjectId().toString(), reason: 'gacha' };
			grants.push(grant);
			slot.reward.id = grant.newId;
		}
		slots.push(slot);
	}

	const pityAfter = { ...pityBefore };
	for (const rule of Object.values(pityConfig)) {
		const hit = slots.some((s) => rule.tiers.includes(s.rarity));
		pityAfter[rule.counter] = hit ? 0 : (pityBefore[rule.counter] || 0) + 1;
	}

	return {
		...base,
		status: 'ok',
		box: { id: String(box._id), name: def.name, definitionId: def.id, legacy: Boolean(def.legacy), countBefore: box.count, countAfter: box.count - 1, depleted: box.count - 1 <= 0 },
		modifiers: { sources, stats },
		rarity: { base: toPercent(boxBase, 4), modified: toPercent(modified, 4), withPity: toPercent(pity.table, 4) },
		pity: { before: pityBefore, after: pityAfter, applied: pity.applied, guarantee: pity.guarantee },
		slots,
		best: slots.reduce((b, s) => (rarityIndex(s.rarity) > rarityIndex(b) ? s.rarity : b), 'common'),
		writes: { fishDocs, grants },
	};
}

async function writeOpen(result, { session, fault }) {
	const opts = session ? { session } : {};
	const { openId, userId } = result;
	const now = new Date();

	await fault('consume');
	const consumed = await ItemData.collection.updateOne(
		{ _id: oid(result.box.id), appliedCasts: { $ne: openId }, count: { $gte: 1 } },
		{ $inc: { count: -1 }, $set: { updatedAt: now }, $push: guardPush(openId) },
		opts,
	);
	if (consumed.matchedCount === 0) {
		const already = await ItemData.collection.findOne({ _id: oid(result.box.id), appliedCasts: openId }, opts);
		if (!already) throw new Error('The box is no longer available.');
	}

	await fault('fish');
	await insertFishDocs(result.writes.fishDocs, session);

	// Commit point: fish ownership, open stats, pity and box removal in one atomic update.
	await fault('commit');
	const set = { updatedAt: now };
	for (const [key, value] of Object.entries(result.pity.after)) set[`pity.gacha.${key}`] = value;
	const update = {
		$inc: { 'stats.gachaBoxesOpened': 1 },
		$set: set,
		$push: { 'inventory.fish': { $each: result.writes.fishDocs.map((d) => oid(d._id)) }, ...guardPush(openId) },
	};
	if (result.box.depleted) update.$pull = { 'inventory.gacha': oid(result.box.id) };
	await UserModel.collection.updateOne({ userId, appliedCasts: { $ne: openId } }, update, opts);

	await fault('grants');
	for (const grant of result.writes.grants) await grantItem(userId, grant, session);
}

/** Persists a GachaResult exactly once. Safe to call again for the same result (recovery). */
async function applyGachaResult(result, { fault = async () => undefined } = {}) {
	if (result.status !== 'ok') return { applied: false };
	await GachaOpen.updateOne(
		{ _id: result.openId },
		{ $setOnInsert: { userId: result.userId, guildId: result.guildId, result, status: 'pending' } },
		{ upsert: true },
	);
	try {
		const { Aquarium } = require('../class/Aquarium');
		if (await Aquarium.supportsTransactions()) {
			const session = await mongoose.startSession();
			try {
				await session.withTransaction(() => writeOpen(result, { session, fault }));
			}
			finally {
				await session.endSession();
			}
		}
		else {
			await writeOpen(result, { fault });
		}
	}
	catch (error) {
		await GachaOpen.updateOne({ _id: result.openId }, { $inc: { attempts: 1 }, $set: { lastError: String(error.message || error) } }).catch(() => undefined);
		throw error;
	}
	await GachaOpen.updateOne({ _id: result.openId }, { $set: { status: 'applied', appliedAt: new Date() }, $inc: { attempts: 1 } });
	return { applied: true };
}

/** Completes interrupted opens (optionally for one player). Returns how many were rolled forward. */
async function recoverPendingOpens({ userId } = {}) {
	const query = { status: 'pending' };
	if (userId) query.userId = String(userId);
	const pending = await GachaOpen.find(query).sort({ createdAt: 1 }).lean();
	for (const open of pending) await applyGachaResult(open.result);
	return pending.length;
}

/** Opens one box for a player: serialized per player, recovers first, then decides and persists. */
function openBox({ userId, guildId = null, boxName }) {
	return withUserLock(userId, async () => {
		await recoverPendingOpens({ userId });
		const result = await openLine({ userId, guildId, boxName });
		if (result.status === 'ok') await applyGachaResult(result);
		return result;
	});
}

/**
 * Validates every catalog box against the live catalog (bootstrap). Returns problems and the
 * effective Normal base tables for logging.
 */
async function validateBoxes(names) {
	const problems = [];
	const tables = {};
	for (const name of names) {
		const def = boxDefinition(name);
		if (!def) {
			problems.push(`gacha box "${name}" has no Gacha V2 definition`);
			continue;
		}
		try {
			const pools = await buildPools(def);
			tables[name] = toPercent(baseTable(def, pools), 3);
			for (const g of def.guaranteedSlots || []) {
				if (!RARITIES.some((r) => rarityIndex(r) >= rarityIndex(g.minRarity) && pools[r].length)) problems.push(`gacha box "${name}" guarantees ${g.minRarity}+ but has no such rewards`);
			}
		}
		catch (error) {
			problems.push(error.message);
		}
	}
	return { problems, tables };
}

module.exports = { openLine, applyGachaResult, recoverPendingOpens, openBox, validateBoxes, buildPools, baseTable, canonicalRarity, GachaDefinitionError, HIGH_TIER };
