// Phase 5B shared assumptions: the SINGLE source of truth for every value more than one module uses.
//
// framework.js re-exports everything here, and its FRAMEWORK_VERSION + SHARED_DIGEST cover these
// values. Subsystem modules import them (via framework.js) and must never redefine them.
// check-shared.js enforces that: it scans the modules for local copies and verifies each report
// carries the current version and digest. Subsystem-specific design parameters stay local.
//
// Changing ANY value here means: bump FRAMEWORK_VERSION in framework.js, re-pin its digest, and
// regenerate every subsystem report (they compute at runtime, so nothing is scaled by hand).

// ---------------------------------------------------------------------------------------------
// World: biome progression levels. Mountain Stream (Lv 60) is future content (3 catalog fish today).
const BIOME_ORDER = ['Ocean', 'River', 'Lake', 'Pond', 'Coast', 'Swamp', 'Mountain Stream'];
const BIOME_LEVEL = { 'Ocean': 0, 'River': 10, 'Lake': 20, 'Pond': 30, 'Coast': 40, 'Swamp': 50, 'Mountain Stream': 60 };
const LIVE_BIOMES = BIOME_ORDER.filter((b) => b !== 'Mountain Stream');
/** Highest live biome unlocked at a level. */
const biomeAt = (level, biomes = LIVE_BIOMES) => [...biomes].reverse().find((b) => level >= BIOME_LEVEL[b]);

// ---------------------------------------------------------------------------------------------
// Players: daily play time, reaction overhead per cast (seconds added to the cooldown) and attendance
// (days played per week; 5b.3: every archetype plays every day unless a scenario says otherwise).
const ARCHETYPES = {
	casual: { minutesPerDay: 12.5, overheadS: 7, daysPerWeek: 7 },
	regular: { minutesPerDay: 45, overheadS: 4, daysPerWeek: 7 },
	active: { minutesPerDay: 120, overheadS: 3, daysPerWeek: 7 },
	grinder: { minutesPerDay: 300, overheadS: 2, daysPerWeek: 7 },
};
const REFERENCE_ARCHETYPE = 'regular';
/** Default overhead for per-hour figures that are not tied to an archetype. */
const DESIGN_OVERHEAD_S = ARCHETYPES[REFERENCE_ARCHETYPE].overheadS;
// R2 adversary (one shared definition for quests, streak and buffs): plays every day only until every
// daily system's minimum is met (the streak's play gate and the daily quest), at the reference cadence.
const MINIMUM_DAILY = { name: 'minimumDaily', session: 'minimumDaily', overheadS: DESIGN_OVERHEAD_S, daysPerWeek: 7, maxMinutesPerDay: 120 };

// ---------------------------------------------------------------------------------------------
// Approved progression targets: hours of actual play for the reference (regular) player.
const TARGET_WINDOWS = { 20: [5, 6], 30: [12, 15], 40: [24, 30], 50: [40, 45] };

// ---------------------------------------------------------------------------------------------
// Lifecycle assumptions used while subsystems are designed. At integration they are replaced by the
// designed systems (quests/streak XP, rods' assembly costs); switching is a version bump (R1).
// DAILY and PURCHASE are the provisional placeholders the 5b.1 curve fit used; they are kept only for
// that provenance (curve.js 'provisional' model). The integrated lifecycle uses the designed systems.
const DAILY = { xpPerLevel: 60 };
const PURCHASE = { saveHours: 1.5 };
const LIFECYCLE = { stepH: 1 / 60, maxLevel: 60, milestones: [10, 20, 30, 40, 50, 60] };

// ---------------------------------------------------------------------------------------------
// Time: the DCC day starts at this UTC hour; daily quests and the streak share it (5b.3).
const DAY = { startUtcHour: 0 };
/** The DCC day index of a timestamp (ms). */
const dayIndex = (ms, startUtcHour = DAY.startUtcHour) => Math.floor((ms - startUtcHour * 3600000) / 86400000);

// ---------------------------------------------------------------------------------------------
// Proposed engine rules every model shares (5b.3). Each is a user decision listed in the report; the
// proposal models the recommended option.
const RULES = {
	// Lucky rolls: today an item 20% of the time. Proposed: pinned so the item rate per draw stays at the
	// NORMAL base table's rate whatever raises Lucky (gear, bait, Founder table, pity): Booster Packs stay
	// an Easter egg (decision 12). 'engine' = today's rule.
	luckyItems: 'pinned',
	// Durability per cast: today max(1, ceil(fish x (1 - efficiency))). Proposed (Founder D5): fish x
	// (1 - efficiency) with stochastic rounding and no minimum. Identical at efficiency 0 (all normal rods).
	durability: 'stochastic',
};

// ---------------------------------------------------------------------------------------------
// Buffs (from the buffs design; 5b.3): Double Cash is stamped at CATCH time (decision 8: a buff
// multiplies play, never a stockpile); temporary boosts in one category add their bonuses.
const BUFFS = {
	doubleCashTiming: 'catch',
	durationSeconds: 3600,
	multipliers: { xp: 2, cash: 2 },
	luckyDraw: { bonusSlots: 1, opens: 2 },
	stacking: { sameKind: 'queue', maxQueued: 3, withEvent: 'additive', withGearAndProfile: 'multiply' },
};
// Event budget: buffs an event calendar may grant per 30 days (and no XP/sell event multipliers).
const EVENTS = { buffsPerThirtyDays: { 'Double XP': 0, 'Double Cash': 1, 'Lucky Draw': 1 }, multipliers: null };

// ---------------------------------------------------------------------------------------------
// Gear path. PROVISIONAL is the normal rod path every subsystem prices against during design, in the
// same shape as rods.gearPath(): { tier, key, level, meanFish, qualities, stats }.
// GEAR_PATH_SOURCE selects which path gearPath() returns: 'provisional' now, 'rods' (the designed
// path from rods.js) at integration. Changing it is a shared-assumption change (bump the version).
const PROVISIONAL_GEAR_PATH = [
	{ tier: 0, key: 'old', level: 0, meanFish: 1.0, qualities: ['weak'], stats: {} },
	{ tier: 1, key: 't1', level: 20, meanFish: 1.15, qualities: ['weak', 'strong'], stats: { rareFind: 0.2, luck: 0.1 } },
	{ tier: 2, key: 't2', level: 30, meanFish: 1.3, qualities: ['weak', 'strong'], stats: { rareFind: 0.4, luck: 0.2, trophyChance: 0.1, fishingSpeed: 0.05 } },
	{ tier: 3, key: 't3', level: 40, meanFish: 1.5, qualities: ['weak', 'strong'], stats: { rareFind: 0.6, luck: 0.4, trophyChance: 0.3, fishingSpeed: 0.1 } },
	{ tier: 4, key: 't4', level: 50, meanFish: 1.65, qualities: ['weak', 'strong'], stats: { rareFind: 0.9, luck: 0.6, trophyChance: 0.5, fishingSpeed: 0.15 } },
	// Endgame tier for the Mountain Stream era (added in 5b.2: the brief's "Tier 5 ~1.8" had no shared
	// definition, so modules were inventing their own). Unused below Lv 60, so the curve fit is unchanged.
	{ tier: 5, key: 't5', level: 60, meanFish: 1.8, qualities: ['weak', 'strong'], stats: { rareFind: 1.2, luck: 0.8, trophyChance: 0.7, fishingSpeed: 0.2 } },
];
// 5b.3: R3 cutover (was 'provisional' through 5b.2).
const GEAR_PATH_SOURCE = 'rods';
const TIER_KEYS = PROVISIONAL_GEAR_PATH.map((t) => t.key);

/** The shared gear path (see GEAR_PATH_SOURCE). rods.js is loaded lazily to avoid a require cycle. */
function gearPath() {
	if (GEAR_PATH_SOURCE === 'rods') {
		return require('./rods').gearPath().map((s) => ({ ...s, key: s.tier === 0 ? 'old' : `t${s.tier}` }));
	}
	return PROVISIONAL_GEAR_PATH;
}
/** Best tier a player can hold at a level on a gear path. */
const tierAt = (level, path = gearPath()) => [...path].reverse().find((t) => level >= t.level);
/** The tier a player typically holds while fishing a biome (the tier unlocked at the biome's level). */
const typicalTier = (biome, path = gearPath()) => tierAt(BIOME_LEVEL[biome], path);

module.exports = {
	BIOME_ORDER, BIOME_LEVEL, LIVE_BIOMES, biomeAt,
	ARCHETYPES, REFERENCE_ARCHETYPE, DESIGN_OVERHEAD_S, MINIMUM_DAILY,
	TARGET_WINDOWS,
	DAILY, PURCHASE, LIFECYCLE,
	DAY, dayIndex, RULES, BUFFS, EVENTS,
	PROVISIONAL_GEAR_PATH, GEAR_PATH_SOURCE, TIER_KEYS, gearPath, tierAt, typicalTier,
};
