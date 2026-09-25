// PlayerModifiers: one resolved, explainable modifier snapshot per cast.
//
// Sources (each recorded separately in the snapshot): base game, profile, rod, bait, active buffs,
// event, developer overrides (and later pets/aquariums).
//
// Stacking rule (documented, no hidden multiplication):
//   - Stats (luck, rareFind, trophyChance, multiCatch, perDraw, xpBonus, sellBonus,
//     durabilityEfficiency, fishingSpeed) ADD across sources, then are clamped to STAT_CAPS.
//   - Reward multipliers are per category and MULTIPLY across categories:
//       xp   = (1 + gear xpBonus) x (1 + buff xp bonus) x profile.xp x event.xp
//       sell = (1 + gear sellBonus) x profile.sell x event.sell      (cash buffs still apply at sale)
//       quest xp/cash = profile.questXp/questCash x event
//   - Rarity stats feed the RarityEngine (see rarity.js).
const {
	BALANCE_VERSION, RARITIES, NORMAL_RARITY_TABLE, RARITY_STAT_TIERS, XP_PER_FISH, DURABILITY, COOLDOWN,
	STAT_CAPS, PART_RARITY_STATS, QUICK_FISHING_SPEED, BAIT_STATS,
} = require('./balance');
const { buildTable } = require('./rarity');

const STAT_KEYS = Object.keys(STAT_CAPS);
const emptyStats = () => Object.fromEntries(STAT_KEYS.map((k) => [k, 0]));

function addStats(target, stats = {}) {
	for (const key of STAT_KEYS) {
		const v = Number(stats[key]);
		if (Number.isFinite(v)) target[key] += v;
	}
	return target;
}

function clampStats(stats) {
	return Object.fromEntries(STAT_KEYS.map((k) => [k, Math.min(STAT_CAPS[k].max, Math.max(STAT_CAPS[k].min, stats[k] || 0))]));
}

const isNumber = (c) => typeof c === 'string' && /^\d+$/.test(c.trim());
const isCount = (c) => typeof c === 'string' && /^\d+\s*count$/i.test(c.trim());
const isDurability = (c) => typeof c === 'string' && /durability$/i.test(c.trim());

/** Qualities a capability list grants access to (weak/strong/...), excluding numbers and tags. */
function qualitiesOf(capabilities = []) {
	return capabilities.filter((c) => typeof c === 'string' && !isNumber(c) && !isCount(c) && !isDurability(c) && c !== 'quick');
}

/**
 * Mechanical conversion of legacy rarity weights into rarity stats: for each stat's tier group,
 * (group weight / baseline group weight) - 1. Items with the legacy default table get 0.
 */
function statsFromWeights(weights, { additive = false } = {}) {
	if (!weights) return {};
	const stats = {};
	for (const [stat, tiers] of Object.entries(RARITY_STAT_TIERS)) {
		const baseline = tiers.reduce((s, t) => s + NORMAL_RARITY_TABLE[t], 0);
		const value = tiers.reduce((s, t) => s + (Number(weights[t]) || 0), 0);
		const ratio = value / baseline - 1;
		// Legacy bait weights were added on top of the rod, so they can only ever help.
		const stat_ = additive ? Math.max(0, ratio) : ratio;
		if (Math.abs(stat_) > 1e-9) stats[stat] = Number(stat_.toFixed(4));
	}
	return stats;
}

/** Legacy capability numbers: first bare number = draws, "N count" = fish per draw. */
function multiCatchFromCapabilities(capabilities = []) {
	const number = capabilities.find(isNumber);
	const count = capabilities.find(isCount);
	const stats = {};
	if (number && Number(number) > 1) stats.multiCatch = Number(number) - 1;
	if (count && parseInt(count, 10) > 1) stats.perDraw = parseInt(count, 10) - 1;
	return stats;
}

/**
 * Converts a rod (starter, shop or custom) into stats. Custom rods derive rarity stats from the
 * rarity of each part, and Fishing Speed from 'quick' parts. Nothing is written back.
 */
function rodStats(rod, parts = null) {
	const capabilities = rod?.capabilities || [];
	const stats = { ...multiCatchFromCapabilities(capabilities), ...statsFromWeights(rod?.weights) };
	const breakdown = [];

	if (parts && parts.length > 0) {
		let quick = 0;
		for (const part of parts.filter(Boolean)) {
			const partStats = PART_RARITY_STATS[part.rarity] || {};
			addStatsLoose(stats, partStats);
			if ((part.qualities || []).includes('quick')) quick++;
			breakdown.push({ part: part.type, name: part.name, rarity: part.rarity, stats: partStats });
		}
		if (quick > 0) stats.fishingSpeed = (stats.fishingSpeed || 0) + quick * QUICK_FISHING_SPEED;
	}
	else if (capabilities.includes('quick')) {
		stats.fishingSpeed = (stats.fishingSpeed || 0) + QUICK_FISHING_SPEED;
	}

	return { stats, qualities: qualitiesOf(capabilities), parts: breakdown };
}

function addStatsLoose(target, stats) {
	for (const [k, v] of Object.entries(stats)) target[k] = Number(((target[k] || 0) + v).toFixed(4));
}

/** Converts a bait into stats: catalog baits use BAIT_STATS, anything else the mechanical converter. */
function baitStats(bait) {
	if (!bait) return { stats: {}, qualities: [], method: 'none' };
	const capabilities = bait.capabilities || [];
	const known = BAIT_STATS[bait.name];
	const stats = known
		? { ...known }
		: { ...statsFromWeights(bait.weights, { additive: true }), perDraw: multiCatchFromCapabilities(capabilities).perDraw || 0 };
	const multiplier = Number(bait.multiplier ?? 1);
	if (Number.isFinite(multiplier) && multiplier !== 1) stats.xpBonus = Number((multiplier - 1).toFixed(4));
	return { stats, qualities: qualitiesOf(capabilities), method: known ? 'catalog' : 'legacy-weights' };
}

/** Active buffs by capability: ['xp','2.0'] -> +100% XP, ['cash', ...] applies at sale, ['gacha', ...]. */
function buffEffects(buffs = []) {
	const effects = { xp: 0, cash: 0, gacha: 0, list: [] };
	for (const buff of buffs) {
		const [kind, raw] = buff.capabilities || [];
		const value = parseFloat(raw);
		if (!Number.isFinite(value) || !(kind in effects)) continue;
		effects[kind] += value - 1;
		effects.list.push({ id: String(buff._id), name: buff.name, kind, bonus: Number((value - 1).toFixed(4)) });
	}
	return effects;
}

/** Expected draws per cast given gear draws, an optional bonus-draw distribution and the cap. */
function expectedDrawCount(draws, bonusDraws, maxDraws) {
	if (!bonusDraws) return draws;
	const total = Object.values(bonusDraws).reduce((s, p) => s + p, 0);
	return Object.entries(bonusDraws).reduce((s, [extra, p]) => s + Math.min(maxDraws, draws + Number(extra)) * (p / total), 0);
}

/** Draws for one cast: gear draws plus a rolled profile bonus, capped. */
function rollDraws(modifiers, rng) {
	if (!modifiers.bonusDraws) return { draws: modifiers.draws, bonus: 0 };
	const extras = Object.keys(modifiers.bonusDraws);
	const bonus = Number(rng.weighted(extras, extras.map((k) => modifiers.bonusDraws[k])) || 0);
	return { draws: Math.min(modifiers.maxDraws, modifiers.draws + bonus), bonus };
}

/**
 * Resolves the modifier snapshot for one cast.
 * @param {object} input { profile, rod, rodParts, bait, baitApplies, buffs, event, user, now }
 */
function resolveModifiers({ profile, rod, rodParts = null, bait = null, baitApplies = false, buffs = [], event = null, user = null, now = new Date() }) {
	const sources = [{ source: 'base', stats: {}, note: `balance ${BALANCE_VERSION}` }];
	const total = emptyStats();

	addStats(total, profile.stats);
	sources.push({ source: 'profile', name: profile.name, override: profile.override || null, stats: { ...profile.stats }, multipliers: { ...profile.multipliers } });

	const rodResult = rodStats(rod, rodParts);
	addStats(total, rodResult.stats);
	sources.push({ source: 'rod', id: rod ? String(rod._id) : null, name: rod?.name, stats: rodResult.stats, parts: rodResult.parts });

	const baitResult = baitStats(bait);
	// Legacy rule: a bait's catch stats only work in its biomes; its XP bonus always applies.
	const baitApplied = baitApplies ? baitResult.stats : { xpBonus: baitResult.stats.xpBonus || 0 };
	addStats(total, baitApplied);
	if (bait) sources.push({ source: 'bait', id: String(bait._id), name: bait.name, applied: baitApplies, method: baitResult.method, stats: baitApplied });

	const buffsResult = buffEffects(buffs);
	if (buffsResult.list.length) sources.push({ source: 'buff', buffs: buffsResult.list });

	const devLuck = user?.devOverrides?.luck;
	const devLuckActive = Boolean(devLuck && Number.isFinite(devLuck.value) && (!devLuck.expiresAt || new Date(devLuck.expiresAt) > now));
	if (devLuckActive) {
		addStats(total, { luck: devLuck.value });
		sources.push({ source: 'dev', stats: { luck: devLuck.value }, expiresAt: devLuck.expiresAt || null });
	}

	if (event) {
		addStats(total, event.stats);
		sources.push({ source: 'event', name: event.name, stats: { ...event.stats }, multipliers: { ...event.multipliers } });
	}

	const stats = clampStats(total);
	const eventMult = event?.multipliers || {};
	const gearXp = stats.xpBonus;
	// Everything except the profile, so rewards can be split into base / profile bonus / final.
	const xpWithoutProfile = (1 + gearXp) * (1 + buffsResult.xp) * (eventMult.xp || 1);
	const sellWithoutProfile = (1 + stats.sellBonus) * (eventMult.sell || 1);
	const xpMultiplier = xpWithoutProfile * profile.multipliers.xp;
	const sellMultiplier = sellWithoutProfile * profile.multipliers.sell;

	const qualities = [...new Set([...rodResult.qualities, ...(baitApplies ? baitResult.qualities : [])])];
	// Gear draws; a profile may add a random number of bonus draws per cast (rollDraws).
	const draws = Math.min(profile.limits.maxDraws, 1 + Math.floor(stats.multiCatch));
	const bonusDraws = profile.bonusDraws || null;
	const expectedDraws = expectedDrawCount(draws, bonusDraws, profile.limits.maxDraws);
	const perDraw = Math.min(profile.limits.maxPerDraw, 1 + Math.floor(stats.perDraw));
	const table = buildTable(profile.rarityTable, stats);

	return {
		balanceVersion: BALANCE_VERSION,
		profile: profile.name,
		competitiveEligible: Boolean(profile.competitiveEligible) && !devLuckActive,
		sources,
		stats,
		qualities,
		draws,
		bonusDraws,
		maxDraws: profile.limits.maxDraws,
		expectedDraws,
		perDraw,
		xp: { perFish: { ...XP_PER_FISH }, gear: gearXp, buff: buffsResult.xp, profile: profile.multipliers.xp, event: eventMult.xp || 1, withoutProfile: xpWithoutProfile, multiplier: xpMultiplier },
		sell: { gear: stats.sellBonus, profile: profile.multipliers.sell, event: eventMult.sell || 1, withoutProfile: sellWithoutProfile, multiplier: sellMultiplier, cashBuffAtSale: buffsResult.cash },
		quest: {
			xp: profile.multipliers.questXp * (eventMult.questXp || 1),
			cash: profile.multipliers.questCash * (eventMult.questCash || 1),
			xpWithoutProfile: eventMult.questXp || 1,
			cashWithoutProfile: eventMult.questCash || 1,
		},
		gachaLuck: profile.multipliers.gachaLuck * (1 + buffsResult.gacha),
		durabilityCostPerFish: DURABILITY.costPerFish * (1 - stats.durabilityEfficiency),
		cooldownMs: Math.max(COOLDOWN.minMs, Math.round(COOLDOWN.fishMs * (1 - stats.fishingSpeed))),
		rarity: { base: buildTable(profile.rarityTable), table },
	};
}

module.exports = { resolveModifiers, rollDraws, expectedDrawCount, rodStats, baitStats, buffEffects, statsFromWeights, qualitiesOf, RARITIES };
