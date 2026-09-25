// The cast engine.
//
//   castLine(ctx)            -> CastResult   reads game state, decides the whole cast, writes nothing
//   applyCastResult(result)  -> persists it exactly once, awaiting every write
//   recoverPendingCasts()    -> rolls forward casts whose persistence was interrupted
//
// Persistence model (see applyCastResult):
//   1. The CastResult is journaled as a 'pending' Cast document before any game state changes.
//   2. Side documents are written idempotently: new FishData use ids pre-generated in the result,
//      and rod/bait/quest/pond updates are guarded by `appliedCasts` so a retry never re-applies.
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
const { QuestData } = require('../schemas/QuestSchema');
const { Pond } = require('../schemas/PondSchema');
const { Cast } = require('../schemas/CastSchema');
const { WeatherPattern } = require('../class/WeatherPattern');
const { Season } = require('../class/Season');
const { Utils } = require('../class/Utils');
const { rng } = require('./rng');
const { BALANCE_VERSION, BASE, resolveProfile, levelForXp } = require('./balance');

// Rarity re-rolls allowed per draw before falling back (see drawTemplates).
const MAX_DRAW_ATTEMPTS = 25;
const RARITY_ORDER = ['Common', 'Uncommon', 'Rare', 'Ultra', 'Giant', 'Legendary', 'Lucky'];
const APPLIED_CASTS_KEEP = 50;
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
// Fields that belong to a stored document itself and must not be copied into a clone.
const DOC_OWN_FIELDS = ['_id', '__v', 'createdAt', 'updatedAt', 'appliedCasts'];
const copyFields = (doc) => Object.fromEntries(Object.entries(doc).filter(([key]) => !DOC_OWN_FIELDS.includes(key)));

/** Legacy rod/bait capability parsing: first bare number = draws per cast, "N count" = fish per draw. */
function parseCapabilities(capabilities) {
	const numberCapability = capabilities.find((c) => !isNaN(c));
	const countCapability = capabilities.find((c) => typeof c === 'string' && c.toLowerCase().includes('count'));
	const draws = numberCapability ? Math.max(1, Number(numberCapability)) : 1;
	const perDraw = countCapability ? Math.max(1, parseInt(countCapability, 10) || 1) : 1;
	return { draws, perDraw };
}

/**
 * Picks catalog templates for each draw: roll a rarity from the weights, pick an eligible
 * template of that rarity whose qualities match a capability; re-roll the rarity up to
 * MAX_DRAW_ATTEMPTS times, then use the deterministic fallback, else throw NoCatchError.
 */
async function drawTemplates({ draws, capabilities, rarities, weights, biome, weather, season }) {
	const catalog = await FishTemplate.find({ biome, weather: { $in: [weather, 'all'] }, season: { $in: [season, 'all'] }, user: null });
	const matches = (t) => capabilities.some((c) => (t?.qualities || []).includes(c));
	let luckyItems = null;

	const picked = [];
	for (let i = 0; i < draws; i++) {
		let template = null;
		for (let attempt = 0; attempt < MAX_DRAW_ATTEMPTS && !template; attempt++) {
			let draw = await Utils.getWeightedChoice(rarities, weights);
			if (!draw) break;
			draw = capitalize(draw);

			let candidates = catalog.filter((t) => t.rarity === draw);
			if (draw === 'Lucky' && await Utils.getWeightedChoice(['fish', 'item'], [80, 20]) === 'item') {
				if (luckyItems === null) luckyItems = await Item.find({ rarity: draw, user: null });
				// An empty Lucky item pool falls back to Lucky fish instead of crashing.
				if (luckyItems.length > 0) candidates = [rng.pick(luckyItems)];
			}

			const valid = candidates.filter(matches);
			if (valid.length > 0) template = rng.pick(valid);
		}

		if (!template) template = await fallbackTemplate(biome, capabilities);
		if (!template) throw new NoCatchError(`No catchable fish in ${biome} for capabilities [${capabilities.join(', ')}]`);
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
	const profile = resolveProfile(userId);
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

	const user = await UserModel.findOne({ userId: String(userId) });
	if (!user) return failure(base, 'NO_USER', 'Player not found.');

	const pond = channelId ? await Pond.findOne({ id: channelId }) : null;
	if (pond && pond.count <= 0) return failure(base, 'POND_EMPTY', 'The pond is empty!');

	const rodDoc = user.inventory.equippedRod ? await ItemData.findById(user.inventory.equippedRod) : null;
	if (!rodDoc) return failure(base, 'NO_ROD', 'You have no fishing rod equipped.');
	const rod = plain(rodDoc);
	if (rod.state === 'broken') return failure(base, 'ROD_BROKEN', 'Your rod is broken! You can\'t catch any more fish until you repair it.', { rodState: 'broken' });
	if (rod.state === 'destroyed') return failure(base, 'ROD_DESTROYED', 'Your rod is destroyed! You can\'t use it anymore.', { rodState: 'destroyed' });

	const baitDoc = user.inventory.equippedBait ? await ItemData.findById(user.inventory.equippedBait) : null;
	const bait = plain(baitDoc);

	const biomeKey = (user.currentBiome || 'ocean').toLowerCase();
	const biome = capitalize(biomeKey);
	const weatherPattern = await WeatherPattern.getCurrentWeather();
	const weather = capitalize(await weatherPattern.getWeather());
	const season = (await Season.getCurrentSeason())?.season;

	// Odds and capabilities: legacy rod + bait combination (the Phase 3 modifier engine replaces this).
	const rodWeights = rod.weights || {};
	const rarities = Object.keys(rodWeights);
	let weights = Object.values(rodWeights);
	let capabilities = rod.capabilities || [];
	const baitApplies = Boolean(bait && (bait.biomes || []).includes(biomeKey));
	if (baitApplies) {
		capabilities = await Utils.sumCountsInArrays(rod.capabilities || [], bait.capabilities || []);
		weights = await Utils.sumArrays(Object.values(rodWeights), Object.values(bait.weights || {}));
	}
	const { draws, perDraw } = parseCapabilities(capabilities);

	let templates;
	try {
		templates = await drawTemplates({ draws, capabilities, rarities, weights, biome, weather, season });
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
			const size = parseFloat((await Utils.binomialRandomInRange(10, 0.5, t.minSize, t.maxSize)).toFixed(3));
			const weight = parseFloat((await Utils.binomialRandomInRange(10, 0.5, t.minWeight, t.maxWeight)).toFixed(3));
			const value = parseInt(await require('../class/Fish').Fish.calculateSellValue(t.baseValue, size, weight, t.rarity), 10);
			const fishId = new ObjectId().toString();
			const locked = autoLockSpecies.includes(t.name.toLowerCase());
			catches.push({ kind: 'fish', id: fishId, templateId: String(t._id), name: t.name, rarity: t.rarity, type: t.type, count, size, weight, value, qualities: t.qualities || [], biome: t.biome, icon: t.icon, locked, autoLocked: locked });

			const fields = copyFields(t);
			fishDocs.push({
				...fields,
				_id: fishId,
				__t: 'FishData',
				user: String(userId),
				obtained: now.getTime(),
				count,
				size,
				weight,
				value,
				guild: guildId || fields.guild,
				locked,
				castId,
				profile: profile.name,
				balanceVersion: BALANCE_VERSION,
				competitiveEligible: profile.competitiveEligible,
			});
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
		perFish.push(Math.floor(rng.random() * (BASE.xpPerFish.max - BASE.xpPerFish.min) + BASE.xpPerFish.min));
	}
	const baseXp = perFish.reduce((a, b) => a + b, 0);

	const activeBuffs = (await BuffData.find({ user: String(userId), active: true })).map(plain);
	const xpBuff = activeBuffs.find((b) => (b.capabilities || []).includes('xp'));
	const modifiers = [];
	if (xpBuff) modifiers.push({ source: `buff:${xpBuff.name}`, stat: 'xp', multiplier: parseFloat(xpBuff.capabilities[1]) || 1 });
	if (bait) modifiers.push({ source: `bait:${bait.name}`, stat: 'xp', multiplier: Number(bait.multiplier ?? 1) });
	if (profile.multipliers.xp !== 1) modifiers.push({ source: `profile:${profile.name}`, stat: 'xp', multiplier: profile.multipliers.xp });
	const xpMultiplier = modifiers.filter((m) => m.stat === 'xp').reduce((p, m) => p * m.multiplier, 1);
	const catchXp = Math.floor(baseXp * xpMultiplier);

	// Rod and bait consumption.
	const rodAfter = { durability: rod.durability - units, state: rod.state, fishCaught: (rod.fishCaught || 0) + units };
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
		const xp = state.completed ? Math.floor((q.xp || 0) * profile.multipliers.questXp) : 0;
		const cash = state.completed ? Math.floor((q.cash || 0) * profile.multipliers.questCash) : 0;
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
		quests.push({ questId: String(q._id), title: q.title, before: q.progress || 0, after: state.progress, max: q.progressMax, completed: state.completed, xp, cash, rewards });
	}

	const xpTotal = catchXp + questXp;
	const cashTotal = questCash;
	const levelBefore = user.level || 1;
	const levelAfter = levelForXp((user.xp || 0) + xpTotal);

	const pityBefore = {
		castsSinceLegendary: user.pity?.castsSinceLegendary || 0,
		castsSinceLucky: user.pity?.castsSinceLucky || 0,
		gachaSinceHighTier: user.pity?.gachaSinceHighTier || 0,
	};
	const hit = (rarity) => catches.some((c) => c.rarity === rarity);
	const pityAfter = {
		castsSinceLegendary: hit('Legendary') ? 0 : pityBefore.castsSinceLegendary + 1,
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
		rod: { id: String(rod._id), name: rod.name, capabilities: rod.capabilities || [], weights: rodWeights, before: { durability: rod.durability, state: rod.state, fishCaught: rod.fishCaught || 0 }, after: rodAfter },
		bait: bait ? { id: String(bait._id), name: bait.name, applied: baitApplies, before: { count: bait.count }, after: { count: baitAfter }, depleted: baitAfter === 0 } : null,
		buffs: activeBuffs.map((b) => ({ id: String(b._id), name: b.name, capabilities: b.capabilities || [] })),
		draws: { draws, perDraw, capabilities, rarities, weights },
		catches,
		units,
		xp: { perFish, base: baseXp, modifiers, multiplier: xpMultiplier, catch: catchXp, bonus: catchXp - baseXp, quest: questXp, total: xpTotal },
		cash: { quest: questCash, total: cashTotal },
		quests,
		level: { before: levelBefore, after: levelAfter, levelUp: levelAfter > levelBefore },
		pity: { before: pityBefore, after: pityAfter },
		pond: pondResult,
		writes: { fishDocs, grants },
	};
}

// ---------------------------------------------------------------------------------------------
// Persistence

const oid = (id) => (id instanceof ObjectId ? id : new ObjectId(String(id)));
const guardPush = (castId) => ({ appliedCasts: { $each: [castId], $slice: -APPLIED_CASTS_KEEP } });

// How each catalog type is stored when granted (mirrors User.sendToInventory + Utils.clone).
const GRANT_TYPES = {
	rod: { t: 'RodData', array: 'rods', stack: false, extra: { fishCaught: 0 } },
	customrod: { t: 'CustomRodData', array: 'rods', stack: false, extra: { fishCaught: 0 } },
	bait: { t: 'BaitData', array: 'baits', stack: true },
	buff: { t: 'BuffData', array: 'buffs', stack: true },
	gacha: { t: 'GachaData', array: 'gacha', stack: true },
	license: { t: 'LicenseData', array: 'items', stack: 'ifCount' },
	part_rod: { t: 'PartRodData', array: 'items', stack: 'ifCount' },
	part_reel: { t: 'PartReelData', array: 'items', stack: 'ifCount' },
	part_hook: { t: 'PartHookData', array: 'items', stack: 'ifCount' },
	part_handle: { t: 'PartHandleData', array: 'items', stack: 'ifCount' },
	default: { t: 'ItemData', array: 'items', stack: 'ifCount' },
};

/** Grants a catalog item exactly once per grant key (stacks like sendToInventory). */
async function grantItem(userId, grant, session) {
	const opts = session ? { session } : {};
	const items = ItemData.collection;
	const users = UserModel.collection;

	// Already applied (either as a new stack or an increment of an existing one)?
	const done = await items.findOne({ user: userId, appliedCasts: grant.key }, opts);
	if (done) {
		const info = GRANT_TYPES[done.type] || GRANT_TYPES.default;
		await users.updateOne({ userId }, { $addToSet: { [`inventory.${info.array}`]: done._id } }, opts);
		return;
	}

	const template = await Item.collection.findOne({ _id: oid(grant.templateId) }, opts);
	if (!template) return;
	const info = GRANT_TYPES[template.type] || GRANT_TYPES.default;

	if (info.stack) {
		const userDoc = await users.findOne({ userId }, { ...opts, projection: { [`inventory.${info.array}`]: 1 } });
		const owned = userDoc?.inventory?.[info.array] || [];
		const existing = owned.length ? await items.findOne({ _id: { $in: owned }, name: template.name }, opts) : null;
		if (existing && (info.stack === true || existing.count)) {
			await items.updateOne({ _id: existing._id, appliedCasts: { $ne: grant.key } }, { $inc: { count: grant.count }, $push: guardPush(grant.key) }, opts);
			return;
		}
	}

	const fields = copyFields(template);
	const now = new Date();
	try {
		await items.insertOne({ ...fields, ...(info.extra || {}), _id: oid(grant.newId), __t: info.t, user: userId, obtained: Date.now(), count: grant.count, appliedCasts: [grant.key], createdAt: now, updatedAt: now }, opts);
	}
	catch (error) {
		if (error.code !== 11000) throw error;
	}
	await users.updateOne({ userId }, { $addToSet: { [`inventory.${info.array}`]: oid(grant.newId) } }, opts);
}

/** Runs every write of a cast. Each step is idempotent; `fault(step)` lets tests inject failures. */
async function writeCast(result, { session, fault }) {
	const opts = session ? { session } : {};
	const { castId, userId } = result;
	const now = new Date();

	await fault('fish');
	if (result.writes.fishDocs.length > 0) {
		const docs = result.writes.fishDocs.map((d) => ({ ...d, _id: oid(d._id), createdAt: now, updatedAt: now }));
		try {
			await FishData.collection.insertMany(docs, { ...opts, ordered: false });
		}
		catch (error) {
			const errors = error.writeErrors || (error.code ? [error] : []);
			if (!errors.length || errors.some((e) => (e.code ?? e.err?.code) !== 11000)) throw error;
		}
	}

	await fault('rod');
	await ItemData.collection.updateOne(
		{ _id: oid(result.rod.id), appliedCasts: { $ne: castId } },
		{ $set: { durability: result.rod.after.durability, state: result.rod.after.state, updatedAt: now }, $inc: { fishCaught: result.units }, $push: guardPush(castId) },
		opts,
	);

	await fault('bait');
	if (result.bait) {
		await ItemData.collection.updateOne(
			{ _id: oid(result.bait.id), appliedCasts: { $ne: castId } },
			{ $set: { count: result.bait.after.count, updatedAt: now }, $push: guardPush(castId) },
			opts,
		);
	}

	await fault('quests');
	for (const q of result.quests) {
		const set = { progress: q.after, updatedAt: now };
		if (q.completed) Object.assign(set, { status: 'completed', endDate: now.getTime() });
		await QuestData.collection.updateOne({ _id: oid(q.questId), appliedCasts: { $ne: castId } }, { $set: set, $push: guardPush(castId) }, opts);
	}

	await fault('pond');
	if (result.pond) {
		const set = { count: result.pond.after, lastFished: now.getTime(), updatedAt: now };
		if (result.pond.warn) set.warning = true;
		await Pond.collection.updateOne({ id: result.pond.id, appliedCasts: { $ne: castId } }, { $set: set, $push: guardPush(castId) }, opts);
	}

	// Commit point: catches, XP, cash, stats, level and pity in one atomic update.
	await fault('commit');
	const fishIds = result.writes.fishDocs.map((d) => oid(d._id));
	const inc = { xp: result.xp.total, 'inventory.money': result.cash.total, 'stats.fishCaught': result.units };
	for (const c of result.catches) {
		const key = `stats.fishStats.${c.name.toLowerCase()}`;
		inc[key] = (inc[key] || 0) + c.count;
	}
	const set = {
		level: result.level.after,
		'stats.latestFish': fishIds,
		'stats.soldLatestFish': false,
		'pity.castsSinceLegendary': result.pity.after.castsSinceLegendary,
		'pity.castsSinceLucky': result.pity.after.castsSinceLucky,
		updatedAt: now,
	};
	const update = { $inc: inc, $set: set, $push: { 'inventory.fish': { $each: fishIds }, ...guardPush(castId) } };
	if (result.bait?.depleted) {
		set['inventory.equippedBait'] = null;
		update.$pull = { 'inventory.baits': oid(result.bait.id) };
	}
	await UserModel.collection.updateOne({ userId, appliedCasts: { $ne: castId } }, update, opts);

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

/** Completes interrupted casts (optionally for one player). Returns how many were rolled forward. */
async function recoverPendingCasts({ userId } = {}) {
	const query = { status: 'pending' };
	if (userId) query.userId = String(userId);
	const pending = await Cast.find(query).sort({ createdAt: 1 }).lean();
	for (const cast of pending) await applyCastResult(cast.result);
	return pending.length;
}

module.exports = { castLine, applyCastResult, recoverPendingCasts, grantItem, NoCatchError, parseCapabilities, MAX_DRAW_ATTEMPTS };
