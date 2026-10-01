// The Phase 5B cast engine: castLine5b decides a cast under the 5B rules. cast.js castLine calls it only
// while the 5B release flag is on; with the flag off it is never reached. The result has the same shape
// as today's CastResult, so cast.js applyCastResult persists it (and replays its journal) unchanged.
//
// Step C.1: the 5B curve (levels.js), catch value scaled to the 5B species expectation (b5/value.js) and
// XP per fish weighted by rarity. Later step C systems extend this file only.
const { ObjectId } = require('mongoose').Types;
const { User: UserModel } = require('../schemas/UserSchema');
const { Fish: FishTemplate, FishData } = require('../schemas/FishSchema');
const { Item, ItemData } = require('../schemas/ItemSchema');
const { QuestData } = require('../schemas/QuestSchema');
const { Pond } = require('../schemas/PondSchema');
const { WeatherPattern } = require('../class/WeatherPattern');
const { Season } = require('../class/Season');
const { rng } = require('./rng');
const { BALANCE_VERSION_5B, XP_PER_FISH, NORMAL_RARITY_TABLE, resolveProfile, activeEvent, need5b } = require('./balance');
const { applyPity, roll, toPercent, normalize } = require('./rarity');
const { buildFishDoc, rollFishStats } = require('./rewards');
const { publicXpOf, publicLevelOf } = require('./publicLevel');
const { levelOf, levelWithFloor } = require('./levels');
const { levelOfUserDoc } = require('./levelGate');
const value5b = require('./b5/value');
const rods5b = require('./b5/rods');
const world5b = require('./b5/world');
const bait5b = require('./b5/bait');
const upgrades5b = require('./b5/upgrades');
const quests5b = require('./b5/quests');
const buffs5b = require('./b5/buffs');
const streak5b = require('./b5/streak');
const day5b = require('./b5/day');
const { resolveModifiers5b } = require('./b5/modifiers');
const { rollFishCount } = require('./b5/multicatch');
const { LEGACY_ONLY } = require('./b5/catalog');
const { fallbackTemplate, rewardBreakdown, failure, capitalize, plain, POND_WARNING_AT, NoCatchError, MAX_DRAW_ATTEMPTS } = require('./cast');

/**
 * Share of Lucky rolls that are catalog items (P-LUCKY): the item rate per draw stays at the Normal base
 * table's rate whatever raises the Lucky tier, so Lucky items stay rare; the rest become Lucky fish.
 */
function luckyItemShare(table) {
	const base = need5b().rules.luckyItemShare;
	const normalLucky = normalize(NORMAL_RARITY_TABLE).lucky;
	if (!(table.lucky > 0)) return base;
	return Math.min(base, (base * normalLucky) / table.lucky);
}

/** Today's draw (cast.js drawTemplates) with the pinned Lucky item share. */
async function drawTemplates5b({ draws, qualities, table, guarantee = null, biome, weather, season, questForce = null }) {
	const catalog = await FishTemplate.find({ biome, weather: { $in: [weather, 'all'] }, season: { $in: [season, 'all'] }, user: null });
	const matches = (t) => qualities.some((c) => (t?.qualities || []).includes(c));
	const itemShare = luckyItemShare(table);
	let luckyItems = null;
	const picked = [];
	for (let i = 0; i < draws; i++) {
		let template = null;
		// Quest pity (P-QUESTS-PITY) on the first draw: the chased species, or a Lucky FISH of this biome;
		// never the Lucky item branch. Falls through to the normal draw when nothing forced is catchable.
		if (i === 0 && questForce) {
			const forced = catalog.filter((t) => (questForce.forces === 'species' ? t.name.toLowerCase() === questForce.species : t.rarity === 'Lucky' && t.type === 'fish')).filter(matches);
			if (forced.length) template = rng.pick(forced);
		}
		for (let attempt = 0; attempt < MAX_DRAW_ATTEMPTS && !template; attempt++) {
			const restrict = i === 0 && guarantee ? guarantee : null;
			const drawn = capitalize(roll(table, rng, restrict));
			let candidates = catalog.filter((t) => t.rarity === drawn);
			if (drawn === 'Lucky' && rng.random() < itemShare) {
				if (luckyItems === null) luckyItems = await Item.find({ rarity: drawn, user: null, ...LEGACY_ONLY });
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

	// Access guard (A-PERMITS) before anything else: no roll, durability, bait, pity or pond effect.
	const gateLevel = levelOfUserDoc(user);
	if (!world5b.canFish(gateLevel, user.permits, user.currentBiome || 'ocean')) {
		return failure(base, 'BIOME_LOCKED', `You can't fish the ${world5b.canonBiome(user.currentBiome) || capitalize(user.currentBiome || 'ocean')} yet. Use /biome to pick a biome you have access to.`);
	}

	const pond = channelId ? await Pond.findOne({ id: channelId }) : null;
	if (pond && pond.count <= 0) return failure(base, 'POND_EMPTY', 'The pond is empty!');

	const rodDoc = user.inventory.equippedRod ? await ItemData.findById(user.inventory.equippedRod) : null;
	if (!rodDoc) return failure(base, 'NO_ROD', 'You have no fishing rod equipped.');
	const rod = plain(rodDoc);
	// 5B rod: the Old Rod never breaks; a crafted rod is never destroyed (legacy destroyed = broken, repairable).
	const rodProfile = await rods5b.resolveRod(rod);
	const rodState = rods5b.effectiveState(rod, rodProfile);
	if (rodState === 'broken') return failure(base, 'ROD_BROKEN', 'Your rod is broken! Repair it, or switch to your Old Rod.', { rodState: 'broken' });

	const baitDoc = user.inventory.equippedBait ? await ItemData.findById(user.inventory.equippedBait) : null;
	const bait = plain(baitDoc);

	const biomeKey = (user.currentBiome || 'ocean').toLowerCase();
	const biome = world5b.canonBiome(biomeKey) || capitalize(biomeKey);
	const weatherPattern = await WeatherPattern.getCurrentWeather();
	const weather = capitalize(await weatherPattern.getWeather());
	const season = (await Season.getCurrentSeason())?.season;

	// 5B buffs: read from the user's activations at cast time (endsAt > now), never from the legacy stacks.
	const buffs = buffs5b.castBuffs(plain(user), now.getTime());
	// 5B bait: read by name, only where it works (biome and shop level), one unit per cast (b5/bait.js).
	const baitSrc = bait5b.baitSource(bait, biome, gateLevel);
	const modifiers = resolveModifiers5b({
		profile, rod: rodProfile, bait: baitSrc, buffs, event: activeEvent(now), user: plain(user), now,
		extraSources: [upgrades5b.upgradeSource(user), await require('./b5/aquarium').companionSource(plain(user), now.getTime())].filter(Boolean),
	});
	base.competitiveEligible = modifiers.competitiveEligible;

	const pityBefore = {
		castsSinceLegendary: user.pity?.castsSinceLegendary || 0,
		castsSinceLucky: user.pity?.castsSinceLucky || 0,
		gachaSinceHighTier: user.pity?.gachaSinceHighTier || 0,
	};
	// The public cast has no pity (the Normal profile's); the Founder's pity belongs to its private rolls.
	const pity = applyPity(modifiers.rarity.table, pityBefore, null);
	const { qualities } = modifiers;
	// Fish per cast: the multi-catch chain (each fish is one draw).
	const draws = rollFishCount(modifiers.multi.chance, rng);
	const perDraw = 1;

	// Quests (b5/quests.js): expired dailies/weeklies are set aside; the story pity may force the first draw.
	const questDocs = (await QuestData.find({ user: String(userId), status: 'in_progress' })).map(plain);
	const { states: questStates, expired: questsExpired } = quests5b.prepare(questDocs, now.getTime());
	const questForce = quests5b.questPityForce(questStates, biome);

	let templates;
	try {
		templates = await drawTemplates5b({ draws, qualities, table: pity.table, guarantee: pity.guarantee, biome, weather, season, questForce });
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

	// Durability (P-DURABILITY): n × (1 − efficiency), stochastic rounding, no minimum. The Old Rod is unbreakable;
	// a 5B rod at 0 is broken (repairable, never destroyed).
	const durabilityCost = rodProfile.unbreakable || units === 0 ? 0 : rods5b.durabilityCharge(units, modifiers.durabilityEfficiency, rng);
	const rodAfter = rodProfile.unbreakable
		? { durability: rod.durability, state: rod.state, fishCaught: (rod.fishCaught || 0) + units }
		: { durability: Math.max(0, (rod.durability || 0) - durabilityCost), state: rodState, fishCaught: (rod.fishCaught || 0) + units };
	if (!rodProfile.unbreakable && rodAfter.durability <= 0) rodAfter.state = 'broken';
	// Bait Conservation: one roll per bait use; on success the unit is not used up (the bait still applied).
	const baitSave = upgrades5b.upgradeStats(user).baitSave || 0;
	const baitSaved = bait5b.unitsUsed(baitSrc) > 0 && baitSave > 0 && rng.random() < baitSave;
	const baitUsed = baitSaved ? 0 : bait5b.unitsUsed(baitSrc);
	const baitAfter = bait ? Math.max(0, (bait.count || 0) - baitUsed) : null;

	const rodName = (rod.name || '').toLowerCase();
	quests5b.advance(questStates, catches, { rodName, luck: modifiers.stats.luck });
	const quests = [];
	let questXp = 0;
	let questCash = 0;
	const questBox = await quests5b.boxId();
	for (const state of questStates.filter((s) => s.touched && (s.completed || s.progress !== (s.doc.progress || 0) || s.pityAfter !== s.pityBefore))) {
		const q = state.doc;
		const { terms } = state;
		const xp = state.completed ? Math.floor(terms.xp * modifiers.quest.xp) : 0;
		const cash = state.completed ? Math.floor(terms.cash * modifiers.quest.cash) : 0;
		const xpBase = state.completed ? Math.floor(terms.xp * modifiers.quest.xpWithoutProfile) : 0;
		const cashBase = state.completed ? Math.floor(terms.cash * modifiers.quest.cashWithoutProfile) : 0;
		const rewards = [];
		if (state.completed) {
			const ids = (q.reward || []).filter(Boolean).map(String);
			// A legacy story completion also gets the chapter's boxes it lacks (the greater of stored and current).
			const missingBoxes = terms.legacy && questBox ? Math.max(0, (terms.storyBoxes || 0) - ids.filter((id) => id === String(questBox)).length) : 0;
			for (let b = 0; b < missingBoxes; b++) ids.push(String(questBox));
			for (const rewardId of ids) {
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
			questId: String(q._id), title: q.title, key: terms.key, kind: terms.kind, before: q.progress || 0, after: state.progress, max: terms.progressMax, completed: state.completed, xp, cash, rewards,
			reward: { xp: { base: xpBase, profileBonus: xp - xpBase, final: xp }, cash: { base: cashBase, profileBonus: cash - cashBase, final: cash } },
			...(terms.pity ? { pityBefore: state.pityBefore, pityAfter: state.pityAfter } : {}),
		});
	}
	const questLog = quests5b.completionLog(questStates, user, now.getTime());

	// Streak (P-STREAK-GATE): a successful cast counts toward today's gate; the qualifying cast credits the day
	// and grants its box through the idempotent grant list. Persisted in the commit (writeCast).
	let streak = null;
	if (units > 0) {
		const before = streak5b.readState(user);
		const step = streak5b.onSuccessfulCast(before, day5b.dayIndex(now.getTime()));
		streak = { before, after: step.state, credit: step.credit };
		if (step.credit?.box) {
			const boxRow = await Item.findOne({ name: step.credit.box, user: null }).select('_id').lean();
			if (boxRow) grants.push({ key: `${castId}:streak`, templateId: String(boxRow._id), count: 1, newId: new ObjectId().toString(), reason: 'streak' });
		}
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
		rod: { id: String(rod._id), name: rod.name, type: rod.type, kind: rodProfile.kind, unbreakable: rodProfile.unbreakable, capabilities: rod.capabilities || [], before: { durability: rod.durability, state: rod.state, fishCaught: rod.fishCaught || 0 }, after: rodAfter, durabilityCost },
		bait: bait
			? {
				id: String(bait._id), name: bait.name, applied: baitSrc.applied, consumed: baitUsed, ...(baitSaved ? { saved: true } : {}), before: { count: bait.count }, after: { count: baitAfter }, depleted: baitUsed > 0 && baitAfter === 0,
				...(baitSrc.reason === 'level' ? { levelLocked: true, requiredLevel: baitSrc.requiredLevel } : {}),
				...(baitSrc.reason === 'biome' ? { wrongBiome: true } : {}),
			}
			: null,
		buffs: buffs.list,
		modifiers: { ...modifiers, rarity: { base: toPercent(modifiers.rarity.base, 4), table: toPercent(modifiers.rarity.table, 4) } },
		rarity: { table: toPercent(pity.table, 4), guarantee: pity.guarantee },
		draws: { draws, bonusDraws: 0, perDraw, qualities, multiChance: modifiers.multi.chance, capped: modifiers.multi.capped },
		cooldownMs: modifiers.cooldownMs,
		catches,
		units,
		xp: { rolls: xpRolls, perFish, base: baseXp, multiplier: xpMultiplier, catch: catchXp, bonus: catchXp - baseXp, quest: questXp, total: xpTotal },
		rewards: rewardBreakdown({ catches, catchXp, catchXpWithoutProfile, quests }),
		cash: { quest: questCash, total: cashTotal },
		quests,
		...(questsExpired.length ? { questsExpired } : {}),
		...(questLog.keys.length ? { questLog } : {}),
		...(streak ? { streak } : {}),
		...(questForce ? { questPity: questForce } : {}),
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
