// Phase 5B framework: the PROPOSED core rules as pure functions, evaluated exactly over the seeded
// catalog with the validated draw model (../lib/catalog-model.js). Nothing here touches the live game.
//
// Subsystem designs (rods, bait, quests, streak, aquarium, founder, buffs, permits) price themselves
// against castOutcome()/hourly() so every number in Phase 5B comes from one consistent model.
const crypto = require('node:crypto');
const { drawDistribution, FISH, currentValue, catchableFish, LUCKY_ITEM_SHARE } = require('../lib/catalog-model');
const { buildTable } = require('../../../src/engine/rarity');
const { NORMAL_RARITY_TABLE, FOUNDER_RARITY_TABLE, RARITIES, STAT_CAPS } = require('../../../src/engine/balance');
const { normalize } = require('../../../src/engine/rarity');
// Shared assumptions (archetypes, targets, lifecycle, biome levels, gear path) live in assumptions.js
// and are re-exported below; modules import them from here and never redefine them.
const A = require('./assumptions');

// Framework version: every subsystem module reports against this. Bump it whenever a shared value
// below changes, and regenerate every subsystem report (they compute from here; nothing is scaled).
// 5b.1: curve quartic 0.0475 (curve.js). 5b.2: shared values centralised in assumptions.js; Tier 5
// (Lv 60, ~1.8 fish) added to the shared provisional gear path. Curve and all other values unchanged.
// 5b.3: R3 cutover (shared gear path = rods.gearPath()); one shared lifecycle core (lifecycle.js);
// shared DAY, RULES (pinned Lucky items, stochastic durability), BUFFS, EVENTS, attendance and the
// R2 minimum-daily archetype; castOutcome: STAT_CAPS clamp, additive multiChance stat, fish-count
// distribution override, durability rule, Lucky-item split, species override; Mountain Stream value 149.
const FRAMEWORK_VERSION = '5b.3';

// ---------------------------------------------------------------------------------------------
// XP curve: xp(L) = 100·L² + QUARTIC·L⁴. Smooth everywhere (no kink at Lv 20); close to today at low
// levels and steeper as levels rise. Levels never drop: level = max(stored level, curve level).
// QUARTIC is chosen by scripts/economy/5b/curve.js (best fit of the regular player's hours of play to
// the approved windows L20 5-6h, L30 12-15h, L40 24-30h, L50 40-45h on the provisional rod path):
// 0.0475 -> L20 47,600 XP (5.6h), L30 128,475 (13.5h), L40 281,600 (25.5h), L50 546,875 (42.7h).
const CURVE = { base: 100, quartic: 0.0475 };
const xpForLevel = (L, c = CURVE) => c.base * L * L + c.quartic * L ** 4;
/** Closed form: quadratic in x = L². */
function levelForXp(xp, c = CURVE) {
	if (!(xp > 0)) return 1;
	const x = c.quartic > 0 ? (-c.base + Math.sqrt(c.base * c.base + 4 * c.quartic * xp)) / (2 * c.quartic) : xp / c.base;
	return Math.max(1, Math.floor(Math.sqrt(x) + 1e-9));
}

// ---------------------------------------------------------------------------------------------
// Value: expected sale value of a species = BIOME_VALUE × RARITY_VALUE × QUALITY_VALUE × species factor.
// The species factor keeps each fish's identity from today's catalog (its value relative to the other
// fish of the same biome and rarity), clamped so rarity and biome order always hold.
// Size/weight rolls still scale an individual catch around this expectation (trophies stay special).
// Base value of a Common weak fish in each biome (Old Rod average $/fish = 1.40 × this).
// 5b.3: Mountain Stream 143 -> 149 (world design: keeps its step over Swamp inside the live ladder's band).
const BIOME_VALUE = { 'Ocean': 18, 'River': 29, 'Lake': 43, 'Pond': 61, 'Coast': 82, 'Swamp': 107, 'Mountain Stream': 149 };
const RARITY_VALUE = { common: 1, uncommon: 1.6, rare: 3, ultra: 6, giant: 12, legendary: 25, lucky: 50 };
const QUALITY_VALUE = { weak: 1, strong: 1.3 };
const SPECIES_CLAMP = [0.8, 1.25];

const groupMedian = new Map();
for (const f of FISH) {
	const k = `${f.biome}|${f.rarity}`;
	if (!groupMedian.has(k)) {
		const vals = FISH.filter((g) => `${g.biome}|${g.rarity}` === k).map(currentValue).sort((a, b) => a - b);
		groupMedian.set(k, vals[Math.floor(vals.length / 2)] || 1);
	}
}
/** Species identity factor; 1 for species outside today's catalog (e.g. a proposed biome ladder). */
const speciesFactor = (f) => {
	const ratio = currentValue(f) / groupMedian.get(`${f.biome}|${f.rarity}`);
	return Number.isFinite(ratio) ? Math.min(SPECIES_CLAMP[1], Math.max(SPECIES_CLAMP[0], ratio)) : 1;
};
const isStrong = (f) => !(f.qualities || []).includes('weak');
/** Proposed expected value of a catalog fish. */
const proposedValue = (f) => (BIOME_VALUE[f.biome] ?? BIOME_VALUE.Ocean) * RARITY_VALUE[f.rarity] * (isStrong(f) ? QUALITY_VALUE.strong : QUALITY_VALUE.weak) * speciesFactor(f);

// ---------------------------------------------------------------------------------------------
// XP per fish: the 10-25 roll (mean 17) × rarity weight. Rarer fish are worth more XP.
const XP_PER_FISH_MEAN = 17;
const XP_RARITY = { common: 1, uncommon: 1.2, rare: 1.5, ultra: 2, giant: 2.5, legendary: 4, lucky: 6 };

// ---------------------------------------------------------------------------------------------
// Multi-catch (normal players): every cast lands 1 fish; with chance `chance` a second, and each
// further fish (up to MAX_FISH) with chance JACKPOT_CHAIN. Averages stay low; 3-5 fish jackpots happen.
const MULTI = { jackpotChain: 0.35, maxFish: 5 };
function fishDistribution(chance, { jackpotChain = MULTI.jackpotChain, maxFish = MULTI.maxFish } = {}) {
	const dist = new Array(maxFish + 1).fill(0);
	let p = 1;
	dist[1] = 1 - chance;
	p = chance;
	for (let n = 2; n <= maxFish; n++) {
		if (n === maxFish) {
			dist[n] = p;
			break;
		}
		dist[n] = p * (1 - jackpotChain);
		p *= jackpotChain;
	}
	const mean = dist.reduce((s, q, n) => s + q * n, 0);
	return { dist, mean, p3plus: dist.slice(3).reduce((a, b) => a + b, 0), p5: dist[maxFish] };
}
/** Chance needed for a target mean fish per cast. */
function chanceForMean(mean, opts) {
	let lo = 0;
	let hi = 1;
	for (let i = 0; i < 60; i++) {
		const mid = (lo + hi) / 2;
		if (fishDistribution(mid, opts).mean < mean) lo = mid;
		else hi = mid;
	}
	return (lo + hi) / 2;
}

// ---------------------------------------------------------------------------------------------
const COOLDOWN = { fishMs: 5000, minMs: 1500 };
const NORMAL_BASE_LUCKY = normalize(NORMAL_RARITY_TABLE).lucky;
const distCache = new Map();
function cachedDistribution(biome, qualities, table, { itemShare = LUCKY_ITEM_SHARE, fish = null, fishKey = null } = {}) {
	const key = `${biome}|${[...qualities].sort().join(',')}|${RARITIES.map((r) => table[r].toFixed(8)).join(',')}|${itemShare.toFixed(10)}|${fish ? fishKey || fish.map((f) => f.name).join(',') : ''}`;
	if (!distCache.has(key)) distCache.set(key, drawDistribution(biome, qualities, table, { luckyItemShare: itemShare, fish }));
	return distCache.get(key);
}

/** Stats clamped to the engine's STAT_CAPS (as resolveModifiers does); multiChance is clamped to [0, 1]. */
function clampStats(raw) {
	const out = { ...raw };
	for (const [k, cap] of Object.entries(STAT_CAPS)) if (k in out) out[k] = Math.min(cap.max, Math.max(cap.min, out[k]));
	if ('multiChance' in out) out.multiChance = Math.min(1, Math.max(0, out.multiChance));
	return out;
}

/**
 * Share of Lucky rolls that are items. 'engine': today's 20%. 'pinned' (RULES.luckyItems): the item rate
 * per draw stays at the NORMAL base table's rate whatever raises the Lucky tier (gear, bait, Founder
 * table, pity), so Booster Packs stay an Easter egg; the rest of those rolls become Lucky fish.
 */
function luckyItemShare(table, rule = A.RULES.luckyItems) {
	if (rule !== 'pinned' || !(table.lucky > 0)) return LUCKY_ITEM_SHARE;
	return Math.min(LUCKY_ITEM_SHARE, (LUCKY_ITEM_SHARE * NORMAL_BASE_LUCKY) / table.lucky);
}

/** Durability charged by one cast of n fish: 'engine' max(1, ceil(n(1-e))); 'stochastic' n(1-e) in expectation. */
function durabilityCost(n, efficiency, rule = A.RULES.durability) {
	const x = n * (1 - efficiency);
	return rule === 'engine' ? Math.max(1, Math.ceil(x - 1e-12)) : x;
}

/**
 * Expected outcome of one cast under the proposed rules.
 * @param {object} g { biome, qualities, stats: { rareFind, luck, trophyChance, sellBonus, xpBonus, fishingSpeed,
 *   durabilityEfficiency, multiChance }, multiChance (rod), fishDist (array P(n fish), overrides the chain),
 *   multiOpts, table (base rarity table, default normal), sellMult, xpMult, fish (species override),
 *   fishKey, rules ({ luckyItems, durability } overrides of A.RULES) }
 */
function castOutcome(g) {
	const stats = clampStats({ rareFind: 0, luck: 0, trophyChance: 0, sellBonus: 0, xpBonus: 0, fishingSpeed: 0, durabilityEfficiency: 0, multiChance: 0, ...(g.stats || {}) });
	const rules = { ...A.RULES, ...(g.rules || {}) };
	const table = buildTable(g.table || NORMAL_RARITY_TABLE, stats);
	const itemShare = luckyItemShare(table, rules.luckyItems);
	const dist = cachedDistribution(g.biome, g.qualities || ['weak'], table, { itemShare, fish: g.fish || null, fishKey: g.fishKey || null });
	let fishP = 0;
	let itemP = 0;
	let boosterP = 0;
	let value = 0;
	let xpw = 0;
	const rarity = Object.fromEntries(RARITIES.map((r) => [r, 0]));
	for (const d of dist) {
		rarity[d.rarity] += d.p;
		xpw += d.p * XP_RARITY[d.rarity];
		if (d.kind === 'fish') {
			fishP += d.p;
			value += d.p * proposedValue(d.template);
		}
		else {
			itemP += d.p;
			if (d.template.name === 'Booster Pack') boosterP += d.p;
		}
	}
	let fd;
	if (g.fishDist) {
		const total = g.fishDist.reduce((a, b) => a + (b || 0), 0);
		fd = g.fishDist.map((q) => (q || 0) / total);
	}
	else {
		fd = fishDistribution(Math.min(1, (g.multiChance || 0) + stats.multiChance), g.multiOpts).dist;
	}
	const fish = fd.reduce((sum, q, n) => sum + q * n, 0);
	const p3plus = fd.slice(3).reduce((a, b) => a + b, 0);
	const sellMult = (1 + stats.sellBonus) * (g.sellMult || 1);
	const xpMult = (1 + stats.xpBonus) * (g.xpMult || 1);
	return {
		biome: g.biome,
		fishPerCast: fish,
		fishDist: fd,
		jackpot3plus: p3plus,
		jackpot5: fd[fd.length - 1] || 0,
		valuePerFish: (value * sellMult) / Math.max(fishP, 1e-9),
		valuePerCast: fish * value * sellMult,
		xpPerCast: fish * XP_PER_FISH_MEAN * xpw * xpMult,
		cooldownMs: Math.max(COOLDOWN.minMs, Math.round(COOLDOWN.fishMs * (1 - stats.fishingSpeed))),
		durabilityPerCast: fd.reduce((sum, q, n) => sum + (n > 0 ? q * durabilityCost(n, stats.durabilityEfficiency, rules.durability) : 0), 0),
		fishSharePerDraw: fishP,
		itemPerDraw: itemP,
		boosterPerDraw: boosterP,
		itemsPerCast: fish * itemP,
		luckyItemShare: itemShare,
		stats,
		rarity,
		table,
	};
}

/** Per-hour rates at a human cadence (cooldown + reaction overhead seconds). */
function hourly(o, overheadS = A.DESIGN_OVERHEAD_S) {
	const casts = 3600 / (o.cooldownMs / 1000 + overheadS);
	return { casts, xp: casts * o.xpPerCast, cash: casts * o.valuePerCast, fish: casts * o.fishPerCast, durability: casts * o.durabilityPerCast };
}

// ---------------------------------------------------------------------------------------------
// Shared digest: a hash of every shared value (the assumptions above + this file's constants, and the
// designed gear path once GEAR_PATH_SOURCE is 'rods'). Each FRAMEWORK_VERSION pins its digest, so a
// shared value cannot change without a version bump; every subsystem report carries both.
const VERSION_DIGESTS = { '5b.1': '7a3ceb5551f3e41f', '5b.2': '26bbca823c8b2b8b', '5b.3': 'e73d1be6aec26cdd' };
const canonical = (v) => {
	if (Array.isArray(v)) return v.map(canonical);
	if (v && typeof v === 'object') return Object.fromEntries(Object.keys(v).sort().map((k) => [k, canonical(v[k])]));
	return typeof v === 'number' ? Number(v.toPrecision(12)) : v;
};
let digestCache = null;
function sharedValues() {
	const data = Object.fromEntries(Object.entries(A).filter(([, v]) => typeof v !== 'function'));
	data.gearPath = A.gearPath().map((t) => ({
		tier: t.tier, level: t.level, meanFish: t.meanFish, multiChance: t.multiChance ?? null, qualities: t.qualities, stats: t.stats,
		cooldownMs: t.cooldownMs ?? null, maxDurability: t.maxDurability ?? null, repairCost: t.repairCost ?? null,
		crateUnlockLevel: t.crateUnlockLevel ?? null, assemblyCost: t.assembly?.expectedCost ?? null,
	}));
	return { assumptions: data, framework: { CURVE, BIOME_VALUE, RARITY_VALUE, QUALITY_VALUE, SPECIES_CLAMP, XP_PER_FISH_MEAN, XP_RARITY, MULTI, COOLDOWN, NORMAL_RARITY_TABLE, FOUNDER_RARITY_TABLE, STAT_CAPS, LUCKY_ITEM_SHARE } };
}
/** sha256 (first 16 hex) of the canonical shared values. */
function sharedDigest() {
	if (!digestCache) digestCache = crypto.createHash('sha256').update(JSON.stringify(canonical(sharedValues()))).digest('hex').slice(0, 16);
	return digestCache;
}
/** Throws if the shared values no longer match the digest pinned for FRAMEWORK_VERSION. */
function verifyShared() {
	const pinned = VERSION_DIGESTS[FRAMEWORK_VERSION];
	const actual = sharedDigest();
	if (pinned !== actual) throw new Error(`Shared Phase 5B values changed (digest ${actual}, pinned ${pinned} for ${FRAMEWORK_VERSION}): bump FRAMEWORK_VERSION, pin the new digest and regenerate every subsystem report.`);
	return { frameworkVersion: FRAMEWORK_VERSION, sharedDigest: actual };
}
/** Stamp for every subsystem report(): { frameworkVersion, sharedDigest } (verified). */
const stamp = () => verifyShared();

module.exports = {
	...A,
	FRAMEWORK_VERSION, VERSION_DIGESTS, sharedDigest, sharedValues, verifyShared, stamp,
	CURVE, xpForLevel, levelForXp,
	BIOME_VALUE, RARITY_VALUE, QUALITY_VALUE, SPECIES_CLAMP, proposedValue, speciesFactor, isStrong,
	XP_PER_FISH_MEAN, XP_RARITY, MULTI, fishDistribution, chanceForMean,
	COOLDOWN, castOutcome, hourly, clampStats, luckyItemShare, durabilityCost, catchableFish,
	NORMAL_RARITY_TABLE, FOUNDER_RARITY_TABLE,
};
// The shared lifecycle core (lifecycle.js), loaded lazily: it requires this module.
Object.defineProperty(module.exports, 'lifecycle', { enumerable: false, get: () => require('./lifecycle') });
