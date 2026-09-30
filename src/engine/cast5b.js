// The Phase 5B cast engine: castLine5b decides a cast under the 5B rules. cast.js castLine calls it only
// while the 5B release flag is on; with the flag off it is never reached. The result has the same shape
// as today's CastResult, so cast.js applyCastResult persists it (and replays its journal) unchanged.
//
// Step C.1: the 5B curve (levels.js), catch value scaled to the 5B species expectation (b5/value.js) and
// XP per fish weighted by rarity. Later step C systems extend this file only.
const { ObjectId } = require('mongoose').Types;
const { User: UserModel } = require('../schemas/UserSchema');
const { FishData } = require('../schemas/FishSchema');
const { Item, ItemData } = require('../schemas/ItemSchema');
const { BuffData } = require('../schemas/BuffSchema');
const { QuestData } = require('../schemas/QuestSchema');
const { Pond } = require('../schemas/PondSchema');
const { WeatherPattern } = require('../class/WeatherPattern');
const { Season } = require('../class/Season');
const { activeBuffFilter } = require('./buffs');
const { rng } = require('./rng');
const { BALANCE_VERSION_5B, XP_PER_FISH, resolveProfile, activeEvent } = require('./balance');
const { resolveModifiers, rollDraws } = require('./modifiers');
const { applyPity, toPercent } = require('./rarity');
const { buildFishDoc, rollFishStats } = require('./rewards');
const { publicXpOf, publicLevelOf } = require('./publicLevel');
const { levelOf, levelWithFloor } = require('./levels');
const { requiredLevel, meetsLevelRequirement, levelOfUserDoc } = require('./levelGate');
const value5b = require('./b5/value');
const { drawTemplates, questMatches, rewardBreakdown, failure, capitalize, plain, POND_WARNING_AT } = require('./cast');

/** One XP roll per fish unit (today's 10-25 roll), weighted by that unit's rarity and floored per fish. */
function rollCatchXp(catches) {
	const rolls = [];
	const perFish = [];
	for (const c of catches) {
		for (let i = 0; i < c.count; i++) {
			const roll = Math.floor(rng.random() * (XP_PER_FISH.max - XP_PER_FISH.min) + XP_PER_FISH.min);
			rolls.push(roll);
			perFish.push(value5b.fishXp(roll, c.rarity));
		}
	}
	return { rolls, perFish, base: perFish.reduce((a, b) => a + b, 0) };
}

/**
 * Decides a complete cast under the 5B rules without writing to MongoDB.
 * @param {{ userId: string, guildId?: string, channelId?: string, now?: Date }} ctx
 */
async function castLine5b({ userId, guildId = null, channelId = null, now = new Date() }) {
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
		balanceVersion: BALANCE_VERSION_5B,
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
	const baitLocked = Boolean(equippedBait) && !meetsLevelRequirement(levelOfUserDoc(user), equippedBait);
	const bait = baitLocked ? null : equippedBait;

	const biomeKey = (user.currentBiome || 'ocean').toLowerCase();
	const biome = capitalize(biomeKey);
	const weatherPattern = await WeatherPattern.getCurrentWeather();
	const weather = capitalize(await weatherPattern.getWeather());
	const season = (await Season.getCurrentSeason())?.season;

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
	const { draws, bonus: bonusDraws } = rollDraws(modifiers, rng);

	let templates;
	try {
		templates = await drawTemplates({ draws, qualities, table: pity.table, guarantee: pity.guarantee, biome, weather, season });
	}
	catch (error) {
		if (error.code !== 'NO_CATCH') throw error;
		return failure(base, 'NO_CATCH', 'Nothing is biting here right now. Try another biome or bait.');
	}

	const stacks = [];
	for (const template of templates) {
		const existing = stacks.find((s) => String(s.template._id) === String(template._id));
		if (existing) existing.count += perDraw;
		else stacks.push({ template, count: perDraw });
	}

	const autoLockSpecies = user.autoLock?.species
		? user.autoLock.species.map((s) => s.toLowerCase())
		: (await FishData.distinct('name', { _id: { $in: user.inventory.fish }, locked: true })).map((s) => s.toLowerCase());

	const catches = [];
	const fishDocs = [];
	const grants = [];
	for (const { template, count } of stacks) {
		const t = plain(template);
		if (t.type === 'fish') {
			const rolled = await rollFishStats(t);
			const { size, weight } = rolled;
			// The 5B value: today's raw roll scaled once to the species' 5B expectation (b5/value.js).
			const rawValue = value5b.scaleRaw(rolled.rawValue, t);
			const value = Math.round(rawValue * modifiers.sell.multiplier);
			const valueBase = Math.round(rawValue * modifiers.sell.withoutProfile);
			const reward = { base: valueBase, profileBonus: value - valueBase, final: value };
			const fishId = new ObjectId().toString();
			const locked = autoLockSpecies.includes(t.name.toLowerCase());
			catches.push({ kind: 'fish', id: fishId, templateId: String(t._id), name: t.name, rarity: t.rarity, type: t.type, count, size, weight, rawRoll: rolled.rawValue, rawValue, value, reward, qualities: t.qualities || [], biome: t.biome, icon: t.icon, locked, autoLocked: locked });

			fishDocs.push(buildFishDoc({
				template: t, id: fishId, userId, guildId, count, size, weight, value, valueBase, locked, now,
				meta: { castId, profile: profile.name, balanceVersion: BALANCE_VERSION_5B, competitiveEligible: modifiers.competitiveEligible },
			}));
		}
		else {
			const grant = { key: `${castId}:catch:${grants.length}`, templateId: String(t._id), count, newId: new ObjectId().toString(), reason: 'catch' };
			grants.push(grant);
			catches.push({ kind: 'item', id: grant.newId, templateId: String(t._id), name: t.name, rarity: t.rarity, type: t.type, count, qualities: t.qualities || [], icon: t.icon, locked: false, autoLocked: false });
		}
	}

	const units = catches.reduce((sum, c) => sum + c.count, 0);

	// XP: one roll per fish unit, weighted by its rarity and floored per fish; then modifiers once.
	const { rolls: xpRolls, perFish, base: baseXp } = rollCatchXp(catches);
	const xpMultiplier = modifiers.xp.multiplier;
	const catchXp = Math.floor(baseXp * xpMultiplier);
	const catchXpWithoutProfile = Math.floor(baseXp * modifiers.xp.withoutProfile);

	const durabilityCost = units > 0 ? Math.max(1, Math.ceil(units * modifiers.durabilityCostPerFish)) : 0;
	const rodAfter = { durability: rod.durability - durabilityCost, state: rod.state, fishCaught: (rod.fishCaught || 0) + units };
	if (rodAfter.durability <= 0) {
		rodAfter.durability = 0;
		rodAfter.state = (rod.repairs || 0) >= (rod.maxRepairs ?? 3) ? 'destroyed' : 'broken';
	}
	const baitAfter = bait ? Math.max(0, (bait.count || 0) - units) : null;

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
	const levelBefore = levelOf(user);
	const levelAfter = levelWithFloor(user.levelFloor, (user.xp || 0) + xpTotal);
	const publicXpBefore = publicXpOf(user);
	const publicXpGain = catchXpWithoutProfile + quests.reduce((s, q) => s + q.reward.xp.base, 0);
	const publicBefore = publicLevelOf(user);
	const publicAfter = levelWithFloor(user.publicLevelFloor, publicXpBefore + publicXpGain);

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
		modifiers: { ...modifiers, rarity: { base: toPercent(modifiers.rarity.base, 4), table: toPercent(modifiers.rarity.table, 4) } },
		rarity: { table: toPercent(pity.table, 4), guarantee: pity.guarantee },
		draws: { draws, bonusDraws, perDraw, qualities },
		cooldownMs: modifiers.cooldownMs,
		catches,
		units,
		xp: { rolls: xpRolls, perFish, base: baseXp, multiplier: xpMultiplier, catch: catchXp, bonus: catchXp - baseXp, quest: questXp, total: xpTotal },
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

module.exports = { castLine5b, rollCatchXp };
