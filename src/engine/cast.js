// The cast engine.
//
//   castLine(ctx)            -> CastResult   reads game state, decides the whole cast, writes nothing
//   applyCastResult(result)  -> persists it exactly once, awaiting every write
//   recoverPendingCasts()    -> rolls forward casts whose persistence was interrupted
//
// Persistence model (see applyCastResult):
//   1. The CastResult is journaled as a 'pending' Cast document before any game state changes.
//   2. Side documents are written idempotently: new FishData use ids pre-generated in the result,
//      and rod/bait/quest/pond updates are guarded by `appliedOps` (rewards.notApplied) so a retry never re-applies.
//   3. The commit point is ONE atomic update of the user document that adds the catches to the
//      inventory and awards XP, cash, stats, level and pity together. Rewards and catch ownership
//      therefore can never be persisted without each other.
//   4. Item grants (quest rewards, Lucky item catches) follow, idempotently.
//   5. The journal is marked 'applied'. A crash anywhere leaves a 'pending' cast that
//      recoverPendingCasts() completes; on a transaction-capable MongoDB steps 2-4 also run in one
//      transaction.
const mongoose = require('mongoose');
const { ObjectId } = mongoose.Types;
const { User: UserModel } = require('../schemas/UserSchema');
const { Fish: FishTemplate, FishData } = require('../schemas/FishSchema');
const { Item, ItemData } = require('../schemas/ItemSchema');
const { BuffData } = require('../schemas/BuffSchema');
const { activeBuffFilter } = require('./buffs');
const { QuestData } = require('../schemas/QuestSchema');
const { Pond } = require('../schemas/PondSchema');
const { Cast } = require('../schemas/CastSchema');
const { WeatherPattern } = require('../class/WeatherPattern');
const { Season } = require('../class/Season');
const { rng } = require('./rng');
const { BALANCE_VERSION, XP_PER_FISH, resolveProfile, activeEvent } = require('./balance');
const { resolveModifiers, rollDraws } = require('./modifiers');
const { applyPity, roll, toPercent } = require('./rarity');
const { oid, notApplied, guardPush, grantItem, buildFishDoc, rollFishStats, insertFishDocs } = require('./rewards');
const { publicXpOf, publicXpOfResult, publicLevelOf } = require('./publicLevel');
const { levelOf, levelWithFloor } = require('./levels');
const { Utils } = require('../class/Utils');
const { requiredLevel, meetsLevelRequirement, levelOfUserDoc } = require('./levelGate');

// Rarity re-rolls allowed per draw before falling back (see drawTemplates).
const MAX_DRAW_ATTEMPTS = 25;
const RARITY_ORDER = ['Common', 'Uncommon', 'Rare', 'Ultra', 'Giant', 'Legendary', 'Lucky'];
const POND_WARNING_AT = 250;

/** Thrown when a cast cannot produce any fish (misconfigured catalog), instead of looping forever. */
class NoCatchError extends Error {
	constructor(message) {
		super(message);
		this.name = 'NoCatchError';
		this.code = 'NO_CATCH';
	}
}

const capitalize = (s) => (s ? s.charAt(0).toUpperCase() + s.slice(1) : s);
const plain = (doc) => (doc && typeof doc.toObject === 'function' ? doc.toObject() : doc);

/**
 * Picks catalog templates for each draw: roll a rarity from the cast's probability table, pick an
 * eligible template of that rarity whose qualities match; re-roll up to MAX_DRAW_ATTEMPTS times,
 * then use the deterministic fallback, else throw NoCatchError. `guarantee` (pity) restricts the
 * first draw to those tiers for as many attempts as the tiers can be satisfied.
 */
async function drawTemplates({ draws, qualities, table, guarantee = null, biome, weather, season }) {
	const catalog = await FishTemplate.find({ biome, weather: { $in: [weather, 'all'] }, season: { $in: [season, 'all'] }, user: null });
	const matches = (t) => qualities.some((c) => (t?.qualities || []).includes(c));
	let luckyItems = null;

	const picked = [];
	for (let i = 0; i < draws; i++) {
		let template = null;
		for (let attempt = 0; attempt < MAX_DRAW_ATTEMPTS && !template; attempt++) {
			const restrict = i === 0 && guarantee ? guarantee : null;
			const draw = capitalize(roll(table, rng, restrict));

			let candidates = catalog.filter((t) => t.rarity === draw);
			if (draw === 'Lucky' && rng.weighted(['fish', 'item'], [80, 20]) === 'item') {
				if (luckyItems === null) luckyItems = await Item.find({ rarity: draw, user: null });
				// An empty Lucky item pool falls back to Lucky fish instead of crashing.
				if (luckyItems.length > 0) candidates = [rng.pick(luckyItems)];
			}

			const valid = candidates.filter(matches);
			if (valid.length > 0) template = rng.pick(valid);
		}

		if (!template) template = await fallbackTemplate(biome, qualities);
		if (!template) throw new NoCatchError(`No catchable fish in ${biome} for qualities [${qualities.join(', ')}]`);
		picked.push(template);
	}
	return picked;
}

/** Deterministic last resort: lowest-rarity, then alphabetical, year-round biome fish matching a capability. */
async function fallbackTemplate(biome, capabilities) {
	const candidates = await FishTemplate.find({ biome, weather: 'all', season: 'all', user: null }).sort({ name: 1 });
	const eligible = candidates.filter((f) => capabilities.some((c) => (f.qualities || []).includes(c)));
	eligible.sort((a, b) => RARITY_ORDER.indexOf(a.rarity) - RARITY_ORDER.indexOf(b.rarity));
	return eligible[0] || null;
}

/** Legacy quest matching (User.findQuests + the per-fish checks in the old /fish). */
function questMatches(quest, entry, rodName) {
	const t = quest.progressType || {};
	const fish = t.fish || ['any'];
	const rarity = t.rarity || ['any'];
	const qualities = t.qualities || ['any'];
	const name = entry.name.toLowerCase();
	const entryQualities = (entry.qualities || []).map((q) => q.toLowerCase());

	// User.findQuests: fish, rod and every quality of the fish must be allowed.
	const found = (fish.includes('any') || fish.includes(name))
		&& (t.rod === 'any' || t.rod === rodName || t.rod === undefined)
		&& entryQualities.every((q) => qualities.includes('any') || qualities.includes(q));
	if (!found) return { found: false, progresses: false };

	const sizeOk = t.size === undefined || t.size === 'any' || (Number.isFinite(entry.size) && entry.size >= Number(t.size));
	const weightOk = t.weight === undefined || t.weight === 'any' || (Number.isFinite(entry.weight) && entry.weight >= Number(t.weight));
	const progresses = (fish.includes('any') || fish.includes(name))
		&& (rarity.includes('any') || rarity.includes(entry.rarity.toLowerCase()))
		&& (t.rod === 'any' || t.rod === rodName || t.rod === undefined)
		&& (qualities.includes('any') || qualities.some((q) => entryQualities.includes(q)))
		&& sizeOk && weightOk;
	return { found: true, progresses };
}

const part = (base, final) => ({ base, profileBonus: final - base, final });

/** Reconciled reward totals for a cast: base + profileBonus = final for every line. */
function rewardBreakdown({ catches, catchXp, catchXpWithoutProfile, quests }) {
	const fish = catches.filter((c) => c.kind === 'fish');
	const valueBase = fish.reduce((s, c) => s + c.reward.base * c.count, 0);
	const valueFinal = fish.reduce((s, c) => s + c.reward.final * c.count, 0);
	const questXpBase = quests.reduce((s, q) => s + q.reward.xp.base, 0);
	const questXpFinal = quests.reduce((s, q) => s + q.reward.xp.final, 0);
	const questCashBase = quests.reduce((s, q) => s + q.reward.cash.base, 0);
	const questCashFinal = quests.reduce((s, q) => s + q.reward.cash.final, 0);
	return {
		catchXp: part(catchXpWithoutProfile, catchXp),
		questXp: part(questXpBase, questXpFinal),
		xp: part(catchXpWithoutProfile + questXpBase, catchXp + questXpFinal),
		questCash: part(questCashBase, questCashFinal),
		// Sale value of the catch (stored on each fish; paid when sold).
		catchValue: part(valueBase, valueFinal),
	};
}

function failure(base, code, message, extra = {}) {
	return { ...base, status: 'failed', failure: { code, message }, ...extra };
}

/**
 * Decides a complete cast for a player without writing to MongoDB.
 * @param {{ userId: string, guildId?: string, channelId?: string, now?: Date }} ctx
 * @returns {Promise<object>} CastResult (status 'ok' or 'failed')
 */
async function castLine({ userId, guildId = null, channelId = null, now = new Date() }) {
	const castId = new ObjectId().toString();
	const user = await UserModel.findOne({ userId: String(userId) });
	const profile = resolveProfile(userId, user);
	const base = {
		castId,
		userId: String(userId),
		guildId,
		channelId,
		createdAt: now,
		profile: profile.name,
		balanceVersion: BALANCE_VERSION,
		competitiveEligible: profile.competitiveEligible,
	};

	if (!user) return failure(base, 'NO_USER', 'Player not found.');

	const pond = channelId ? await Pond.findOne({ id: channelId }) : null;
	if (pond && pond.count <= 0) return failure(base, 'POND_EMPTY', 'The pond is empty!');

	const rodDoc = user.inventory.equippedRod ? await ItemData.findById(user.inventory.equippedRod) : null;
	if (!rodDoc) return failure(base, 'NO_ROD', 'You have no fishing rod equipped.');
	const rod = plain(rodDoc);
	if (rod.state === 'broken') return failure(base, 'ROD_BROKEN', 'Your rod is broken! You can\'t catch any more fish until you repair it.', { rodState: 'broken' });
	if (rod.state === 'destroyed') return failure(base, 'ROD_DESTROYED', 'Your rod is destroyed! You can\'t use it anymore.', { rodState: 'destroyed' });

	const baitDoc = user.inventory.equippedBait ? await ItemData.findById(user.inventory.equippedBait) : null;
	const equippedBait = plain(baitDoc);
	// Level gate at use time: a bait above the player's real level has no effect (not even its XP
	// bonus) and is not consumed. It stays equipped. Rods are never checked here (equipped rods keep working).
	const baitLocked = Boolean(equippedBait) && !meetsLevelRequirement(levelOfUserDoc(user), equippedBait);
	const bait = baitLocked ? null : equippedBait;

	const biomeKey = (user.currentBiome || 'ocean').toLowerCase();
	const biome = capitalize(biomeKey);
	const weatherPattern = await WeatherPattern.getCurrentWeather();
	const weather = capitalize(await weatherPattern.getWeather());
	const season = (await Season.getCurrentSeason())?.season;

	// One resolved modifier snapshot for the whole cast (profile, rod, bait, buffs, dev, event).
	const rodParts = rod.type === 'customrod' ? (await ItemData.find({ _id: { $in: [rod.rod, rod.reel, rod.hook, rod.handle].filter(Boolean) } })).map(plain) : null;
	const activeBuffs = (await BuffData.find(activeBuffFilter(userId, now))).map(plain);
	const baitApplies = Boolean(bait && (bait.biomes || []).includes(biomeKey));
	const modifiers = resolveModifiers({ profile, rod, rodParts, bait, baitApplies, buffs: activeBuffs, event: activeEvent(now), user: plain(user), now });
	base.competitiveEligible = modifiers.competitiveEligible;

	const pityBefore = {
		castsSinceLegendary: user.pity?.castsSinceLegendary || 0,
		castsSinceLucky: user.pity?.castsSinceLucky || 0,
		gachaSinceHighTier: user.pity?.gachaSinceHighTier || 0,
	};
	const pity = applyPity(modifiers.rarity.table, pityBefore, profile.pity);
	const { perDraw, qualities } = modifiers;
	// Profile bonus draws are rolled per cast (Founder: 1-5 fish with the starter rod, average 3).
	const { draws, bonus: bonusDraws } = rollDraws(modifiers, rng);

	let templates;
	try {
		templates = await drawTemplates({ draws, qualities, table: pity.table, guarantee: pity.guarantee, biome, weather, season });
	}
	catch (error) {
		if (error.code !== 'NO_CATCH') throw error;
		return failure(base, 'NO_CATCH', 'Nothing is biting here right now. Try another biome or bait.');
	}

	// Duplicates of a species stack: every draw adds `perDraw` fish.
	const stacks = [];
	for (const template of templates) {
		const existing = stacks.find((s) => String(s.template._id) === String(template._id));
		if (existing) existing.count += perDraw;
		else stacks.push({ template, count: perDraw });
	}

	// Automatic protection (species rules). Accounts from before autoLock existed fall back to
	// "species they currently have locked", which is what the bootstrap migration records.
	const autoLockSpecies = user.autoLock?.species
		? user.autoLock.species.map((s) => s.toLowerCase())
		: (await FishData.distinct('name', { _id: { $in: user.inventory.fish }, locked: true })).map((s) => s.toLowerCase());

	const catches = [];
	const fishDocs = [];
	const grants = [];
	for (const { template, count } of stacks) {
		const t = plain(template);
		if (t.type === 'fish') {
			const { size, weight, rawValue } = await rollFishStats(t);
			// Sell bonuses (gear, event, profile) are baked into the stored value; cash buffs apply at sale.
			// reward.base = what the same catch is worth without the profile; final = stored value.
			const value = Math.round(rawValue * modifiers.sell.multiplier);
			const valueBase = Math.round(rawValue * modifiers.sell.withoutProfile);
			const reward = { base: valueBase, profileBonus: value - valueBase, final: value };
			const fishId = new ObjectId().toString();
			const locked = autoLockSpecies.includes(t.name.toLowerCase());
			catches.push({ kind: 'fish', id: fishId, templateId: String(t._id), name: t.name, rarity: t.rarity, type: t.type, count, size, weight, rawValue, value, reward, qualities: t.qualities || [], biome: t.biome, icon: t.icon, locked, autoLocked: locked });

			fishDocs.push(buildFishDoc({
				template: t, id: fishId, userId, guildId, count, size, weight, value, valueBase, locked, now,
				meta: { castId, profile: profile.name, balanceVersion: BALANCE_VERSION, competitiveEligible: modifiers.competitiveEligible },
			}));
		}
		else {
			// Lucky draw returned a catalog item: granted after the commit.
			const grant = { key: `${castId}:catch:${grants.length}`, templateId: String(t._id), count, newId: new ObjectId().toString(), reason: 'catch' };
			grants.push(grant);
			catches.push({ kind: 'item', id: grant.newId, templateId: String(t._id), name: t.name, rarity: t.rarity, type: t.type, count, qualities: t.qualities || [], icon: t.icon, locked: false, autoLocked: false });
		}
	}

	const units = catches.reduce((sum, c) => sum + c.count, 0);

	// XP: one base roll per fish actually caught (duplicates included), then modifiers once.
	const perFish = [];
	for (let i = 0; i < units; i++) {
		perFish.push(Math.floor(rng.random() * (XP_PER_FISH.max - XP_PER_FISH.min) + XP_PER_FISH.min));
	}
	const baseXp = perFish.reduce((a, b) => a + b, 0);

	const xpMultiplier = modifiers.xp.multiplier;
	const catchXp = Math.floor(baseXp * xpMultiplier);
	const catchXpWithoutProfile = Math.floor(baseXp * modifiers.xp.withoutProfile);

	// Rod and bait consumption. Durability Efficiency lowers the per-fish cost (at least 1 per cast).
	const durabilityCost = units > 0 ? Math.max(1, Math.ceil(units * modifiers.durabilityCostPerFish)) : 0;
	const rodAfter = { durability: rod.durability - durabilityCost, state: rod.state, fishCaught: (rod.fishCaught || 0) + units };
	if (rodAfter.durability <= 0) {
		rodAfter.durability = 0;
		rodAfter.state = (rod.repairs || 0) >= (rod.maxRepairs ?? 3) ? 'destroyed' : 'broken';
	}
	const baitAfter = bait ? Math.max(0, (bait.count || 0) - units) : null;

	// Quests: progress per catch entry, completion checked after each entry.
	const questDocs = (await QuestData.find({ user: String(userId), status: 'in_progress' })).map(plain);
	const rodName = (rod.name || '').toLowerCase();
	const questStates = questDocs.map((q) => ({ doc: q, progress: q.progress || 0, completed: false, touched: false }));
	for (const entry of catches) {
		for (const state of questStates) {
			if (state.completed) continue;
			const { found, progresses } = questMatches(state.doc, entry, rodName);
			if (!found) continue;
			state.touched = true;
			if (progresses) state.progress += entry.count;
			if (state.progress >= (state.doc.progressMax || 1)) state.completed = true;
		}
	}
	const quests = [];
	let questXp = 0;
	let questCash = 0;
	for (const state of questStates.filter((s) => s.touched && (s.completed || s.progress !== (s.doc.progress || 0)))) {
		const q = state.doc;
		const xp = state.completed ? Math.floor((q.xp || 0) * modifiers.quest.xp) : 0;
		const cash = state.completed ? Math.floor((q.cash || 0) * modifiers.quest.cash) : 0;
		const xpBase = state.completed ? Math.floor((q.xp || 0) * modifiers.quest.xpWithoutProfile) : 0;
		const cashBase = state.completed ? Math.floor((q.cash || 0) * modifiers.quest.cashWithoutProfile) : 0;
		const rewards = [];
		if (state.completed) {
			for (const rewardId of (q.reward || []).filter(Boolean)) {
				const template = await Item.findById(rewardId).select('name').lean();
				if (!template) continue;
				const grant = { key: `${castId}:quest:${q._id}:${rewards.length}`, templateId: String(rewardId), count: 1, newId: new ObjectId().toString(), reason: 'quest' };
				grants.push(grant);
				rewards.push({ templateId: String(rewardId), name: template.name });
			}
		}
		questXp += xp;
		questCash += cash;
		quests.push({
			questId: String(q._id), title: q.title, before: q.progress || 0, after: state.progress, max: q.progressMax, completed: state.completed, xp, cash, rewards,
			reward: { xp: { base: xpBase, profileBonus: xp - xpBase, final: xp }, cash: { base: cashBase, profileBonus: cash - cashBase, final: cash } },
		});
	}

	const xpTotal = catchXp + questXp;
	const cashTotal = questCash;
	// Levels go through max(stored floor, curve) (levels.js): never below the floor, and a level-up only
	// when the curve rises above the level the player already had.
	const levelBefore = levelOf(user);
	const levelAfter = levelWithFloor(user.levelFloor, (user.xp || 0) + xpTotal);
	// Public level: from the base XP the card shows (publicXp). The real level above includes private
	// profile bonuses and must never be what other players see level up.
	const publicXpBefore = publicXpOf(user);
	const publicXpGain = catchXpWithoutProfile + quests.reduce((s, q) => s + q.reward.xp.base, 0);
	const publicBefore = publicLevelOf(user);
	const publicAfter = levelWithFloor(user.publicLevelFloor, publicXpBefore + publicXpGain);

	// Counters reset only when the qualifying tier was actually caught (Legendary+ = Legendary or Lucky).
	const hit = (rarity) => catches.some((c) => c.rarity === rarity);
	const pityAfter = {
		castsSinceLegendary: hit('Legendary') || hit('Lucky') ? 0 : pityBefore.castsSinceLegendary + 1,
		castsSinceLucky: hit('Lucky') ? 0 : pityBefore.castsSinceLucky + 1,
		gachaSinceHighTier: pityBefore.gachaSinceHighTier,
	};

	let pondResult = null;
	if (pond) {
		const after = Math.max(0, pond.count - units);
		pondResult = { id: pond.id, before: pond.count, after, warn: after > 0 && after <= POND_WARNING_AT && !pond.warning };
	}

	return {
		...base,
		status: 'ok',
		environment: { biome, weather, season },
		rod: { id: String(rod._id), name: rod.name, type: rod.type, capabilities: rod.capabilities || [], before: { durability: rod.durability, state: rod.state, fishCaught: rod.fishCaught || 0 }, after: rodAfter, durabilityCost },
		bait: bait
			? { id: String(bait._id), name: bait.name, applied: baitApplies, before: { count: bait.count }, after: { count: baitAfter }, depleted: baitAfter === 0 }
			: (baitLocked
				? { id: String(equippedBait._id), name: equippedBait.name, applied: false, levelLocked: true, requiredLevel: requiredLevel(equippedBait), before: { count: equippedBait.count }, after: { count: equippedBait.count }, depleted: false }
				: null),
		buffs: activeBuffs.map((b) => ({ id: String(b._id), name: b.name, capabilities: b.capabilities || [] })),
		// Resolved modifier snapshot: every source, the summed stats and the resulting multipliers.
		modifiers: { ...modifiers, rarity: { base: toPercent(modifiers.rarity.base, 4), table: toPercent(modifiers.rarity.table, 4) } },
		rarity: { table: toPercent(pity.table, 4), guarantee: pity.guarantee },
		draws: { draws, bonusDraws, perDraw, qualities },
		cooldownMs: modifiers.cooldownMs,
		catches,
		units,
		xp: { perFish, base: baseXp, multiplier: xpMultiplier, catch: catchXp, bonus: catchXp - baseXp, quest: questXp, total: xpTotal },
		// base = without the player's profile (what a normal player would get for the same cast),
		// profileBonus = what the profile added, final = what was actually awarded/stored.
		rewards: rewardBreakdown({ catches, catchXp, catchXpWithoutProfile, quests }),
		cash: { quest: questCash, total: cashTotal },
		quests,
		level: {
			before: levelBefore, after: levelAfter, levelUp: levelAfter > levelBefore,
			public: { xpBefore: publicXpBefore, xpAfter: publicXpBefore + publicXpGain, before: publicBefore, after: publicAfter, levelUp: publicAfter > publicBefore },
		},
		pity: { before: pityBefore, after: pityAfter, applied: pity.applied },
		pond: pondResult,
		writes: { fishDocs, grants },
	};
}

// ---------------------------------------------------------------------------------------------
// Persistence


/** Runs every write of a cast. Each step is idempotent; `fault(step)` lets tests inject failures. */
async function writeCast(result, { session, fault }) {
	const opts = session ? { session } : {};
	const { castId, userId } = result;
	const now = new Date();

	await fault('fish');
	await insertFishDocs(result.writes.fishDocs, session);

	await fault('rod');
	await ItemData.collection.updateOne(
		{ _id: oid(result.rod.id), ...notApplied(castId) },
		{ $set: { durability: result.rod.after.durability, state: result.rod.after.state, updatedAt: now }, $inc: { fishCaught: result.units }, $push: guardPush(castId) },
		opts,
	);

	await fault('bait');
	// A level-locked bait was not used: nothing to write.
	if (result.bait && !result.bait.levelLocked) {
		await ItemData.collection.updateOne(
			{ _id: oid(result.bait.id), ...notApplied(castId) },
			{ $set: { count: result.bait.after.count, updatedAt: now }, $push: guardPush(castId) },
			opts,
		);
	}

	await fault('quests');
	for (const q of result.quests) {
		const set = { progress: q.after, updatedAt: now };
		if (q.completed) Object.assign(set, { status: 'completed', endDate: now.getTime() });
		await QuestData.collection.updateOne({ _id: oid(q.questId), ...notApplied(castId) }, { $set: set, $push: guardPush(castId) }, opts);
	}

	await fault('pond');
	if (result.pond) {
		const set = { count: result.pond.after, lastFished: now.getTime(), updatedAt: now };
		if (result.pond.warn) set.warning = true;
		await Pond.collection.updateOne({ id: result.pond.id, ...notApplied(castId) }, { $set: set, $push: guardPush(castId) }, opts);
	}

	// publicXp self-healing (F4): a document without publicXp (not reached by the migration) starts from
	// its own xp, never from 0. A separate guarded pipeline update in the same session/transaction, just
	// before the commit: a filter clause on the commit itself would drop the whole commit. Idempotent
	// (only a missing field is set, and never once this cast has committed).
	await UserModel.collection.updateOne(
		{ userId, publicXp: { $exists: false }, ...notApplied(castId) },
		[{ $set: { publicXp: { $ifNull: ['$publicXp', { $ifNull: ['$xp', 0] }] } } }],
		opts,
	);

	// Commit point: catches, XP, cash, stats, level and pity in one atomic update.
	await fault('commit');
	const fishIds = result.writes.fishDocs.map((d) => oid(d._id));
	// publicXp moves with xp in the same atomic update (base rewards only; see publicLevel.js).
	const inc = { xp: result.xp.total, publicXp: publicXpOfResult(result), 'inventory.money': result.cash.total, 'stats.fishCaught': result.units };
	for (const c of result.catches) {
		const key = `stats.fishStats.${c.name.toLowerCase()}`;
		inc[key] = (inc[key] || 0) + c.count;
	}
	const set = {
		'stats.latestFish': fishIds,
		'stats.soldLatestFish': false,
		'pity.castsSinceLegendary': result.pity.after.castsSinceLegendary,
		'pity.castsSinceLucky': result.pity.after.castsSinceLucky,
		updatedAt: now,
	};
	// The stored level and the floors only ever rise ($max): a journal written before the floors (3.2.0)
	// may carry a level below the stored one. Journals from before the public level have no level.public.
	const max = { level: result.level.after, levelFloor: result.level.after };
	if (Number.isFinite(result.level.public?.after)) max.publicLevelFloor = result.level.public.after;
	const update = { $inc: inc, $set: set, $max: max, $push: { 'inventory.fish': { $each: fishIds }, ...guardPush(castId) } };
	if (result.bait?.depleted) {
		set['inventory.equippedBait'] = null;
		update.$pull = { 'inventory.baits': oid(result.bait.id) };
	}
	await UserModel.collection.updateOne({ userId, ...notApplied(castId) }, update, opts);

	await fault('grants');
	for (const grant of result.writes.grants) await grantItem(userId, grant, session);
}

/**
 * Persists a CastResult exactly once. Safe to call again for the same result (recovery).
 * @param {object} result CastResult from castLine
 * @param {{ fault?: (step: string) => Promise<void> | void }} [options] test hook
 */
async function applyCastResult(result, { fault = async () => undefined } = {}) {
	if (result.status !== 'ok') return { applied: false };

	await Cast.updateOne(
		{ _id: result.castId },
		{ $setOnInsert: { userId: result.userId, guildId: result.guildId, result, status: 'pending' } },
		{ upsert: true },
	);

	try {
		const { Aquarium } = require('../class/Aquarium');
		if (await Aquarium.supportsTransactions()) {
			const session = await mongoose.startSession();
			try {
				await session.withTransaction(() => writeCast(result, { session, fault }));
			}
			finally {
				await session.endSession();
			}
		}
		else {
			await writeCast(result, { fault });
		}
	}
	catch (error) {
		await Cast.updateOne({ _id: result.castId }, { $inc: { attempts: 1 }, $set: { lastError: String(error.message || error) } }).catch(() => undefined);
		throw error;
	}

	await Cast.updateOne({ _id: result.castId }, { $set: { status: 'applied', appliedAt: new Date() }, $inc: { attempts: 1 } });
	return { applied: true };
}

const logRecoveryFailure = (kind, id, error) => Utils.log(`[RECOVERY] ${kind} ${id} could not be applied and stays pending: ${error?.stack || error?.message || error}`, 'err');

/**
 * Completes interrupted casts (optionally for one player), each in isolation: a journal that fails
 * (corrupt, or from a shape the code cannot apply) is logged with its id and left pending; it never
 * stops the others, the boot or the player's next cast. Returns { recovered, failed: [{ id, error }] }.
 */
async function recoverPendingCastsDetailed({ userId, onFailure = (id, error) => logRecoveryFailure('cast', id, error) } = {}) {
	const query = { status: 'pending' };
	if (userId) query.userId = String(userId);
	const pending = await Cast.find(query).sort({ createdAt: 1 }).lean();
	let recovered = 0;
	const failed = [];
	for (const cast of pending) {
		try {
			if (!cast.result || typeof cast.result !== 'object') throw new Error('journal has no result');
			// A journal whose castId disagrees with its own id would write under another key: refuse it.
			if (String(cast.result.castId) !== String(cast._id)) throw new Error(`journal result.castId ${cast.result.castId} != ${cast._id}`);
			await applyCastResult(cast.result);
			recovered++;
		}
		catch (error) {
			failed.push({ id: String(cast._id), error: String(error?.message || error) });
			await Cast.updateOne({ _id: cast._id }, { $set: { lastError: String(error?.message || error) } }).catch(() => undefined);
			try {
				onFailure(String(cast._id), error);
			}
			catch {
				// Logging never breaks recovery.
			}
		}
	}
	return { recovered, failed };
}

/** Completes interrupted casts (optionally for one player). Returns how many were rolled forward. */
async function recoverPendingCasts(options = {}) {
	return (await recoverPendingCastsDetailed(options)).recovered;
}

/**
 * A player's current fishing stats and odds, exactly as the next cast would use them (profile,
 * every modifier source, summed stats, multipliers, cooldown, rarity table incl. pity).
 * Read-only: runs castLine's decision without persisting it. Basis for a future /stats odds view.
 */
async function fishingStats(userId) {
	const result = await castLine({ userId });
	if (result.status !== 'ok') return { status: 'failed', failure: result.failure, profile: result.profile };
	return {
		status: 'ok',
		profile: result.profile,
		balanceVersion: result.balanceVersion,
		competitiveEligible: result.competitiveEligible,
		environment: result.environment,
		modifiers: result.modifiers,
		odds: result.rarity.table,
		pity: { counters: result.pity.before, applied: result.pity.applied, config: resolveProfile(userId, await UserModel.findOne({ userId: String(userId) }).lean()).pity },
		cooldownMs: result.cooldownMs,
		// Private: the real level (all XP) and the public level other players see (base XP).
		level: { real: result.level.before, public: result.level.public.before, publicXp: result.level.public.xpBefore },
	};
}

module.exports = { castLine, applyCastResult, recoverPendingCasts, recoverPendingCastsDetailed, fishingStats, grantItem, NoCatchError, MAX_DRAW_ATTEMPTS };
