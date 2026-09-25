// GameBalance: every tunable gameplay number, versioned.
//
// Every cast records BALANCE_VERSION and the profile it ran under, so historical catches always say
// which rule set produced them. Bump BALANCE_VERSION whenever a number here changes.
// Engine code reads from here; it never hard-codes multipliers.
const config = require('../config');

const BALANCE_VERSION = '3.2.0';

/** Rarity tiers, lowest to highest. Keys match rod/bait `weights` objects. */
const RARITIES = ['common', 'uncommon', 'rare', 'ultra', 'giant', 'legendary', 'lucky'];

/**
 * Which tiers each rarity stat boosts. A stat of +1.0 (+100%) doubles the relative weight of its
 * tiers before the table is normalised.
 *   rareFind     -> Rare, Ultra
 *   luck         -> Legendary, Lucky
 *   trophyChance -> Giant (stand-in until Trophy becomes a variant; Giant stays a rarity for now)
 */
const RARITY_STAT_TIERS = {
	rareFind: ['rare', 'ultra'],
	luck: ['legendary', 'lucky'],
	trophyChance: ['giant'],
};

/** Normal players: today's starter-rod odds (legacy weights 7000/2500/500/100/50/20/1). */
const NORMAL_RARITY_TABLE = { common: 7000, uncommon: 2500, rare: 500, ultra: 100, giant: 50, legendary: 20, lucky: 1 };

/** Founder: explicit target probabilities with the starter rod (percent). */
const FOUNDER_RARITY_TABLE = { common: 32, uncommon: 28, rare: 20, ultra: 10, giant: 5, legendary: 4, lucky: 1 };

const XP_PER_FISH = { min: 10, max: 25 };

const DURABILITY = { costPerFish: 1 };

const COOLDOWN = {
	// Base /fish cooldown; Fishing Speed reduces it, never below minMs.
	fishMs: 5000,
	minMs: 1500,
};

/** Hard bounds on stats so no combination of sources can produce nonsense. */
const STAT_CAPS = {
	luck: { min: -0.9, max: 50 },
	rareFind: { min: -0.9, max: 50 },
	trophyChance: { min: -0.9, max: 50 },
	multiCatch: { min: 0, max: 20 },
	perDraw: { min: 0, max: 20 },
	xpBonus: { min: -0.9, max: 50 },
	sellBonus: { min: -0.9, max: 50 },
	durabilityEfficiency: { min: 0, max: 0.9 },
	fishingSpeed: { min: 0, max: 0.75 },
};

/**
 * Pity. `softStart`: casts without the tier after which each further cast adds `rampPerCast` to
 * the tier group's probability (capped at `maxBonus`). `hard`: the cast that reaches this count is
 * guaranteed one draw from the group. Counters reset only when the tier is actually caught.
 */
const FOUNDER_PITY = {
	legendaryPlus: { counter: 'castsSinceLegendary', tiers: ['legendary', 'lucky'], softStart: 10, rampPerCast: 0.02, maxBonus: 0.4, hard: 25 },
	lucky: { counter: 'castsSinceLucky', tiers: ['lucky'], softStart: 30, rampPerCast: 0.005, maxBonus: 0.25, hard: 75 },
};

/**
 * Founder gacha luck. Phase 3 multiplied every Rare-and-above weight by 3 (Rare/Ultra/Giant/
 * Legendary/Lucky alike). As stats this is Rare Find, Trophy and Luck at least +200% each; Luck is
 * raised to +400% so Legendary/Lucky pulls improve more than Rare/Ultra (see Phase 4 report).
 */
const FOUNDER_GACHA_STATS = { rareFind: 2.0, trophyChance: 2.0, luck: 4.0 };

/**
 * Founder gacha pity, tracked per box: opens without a Legendary+ reward. Rules whose tiers a box
 * cannot award are skipped for that box.
 */
const FOUNDER_GACHA_PITY = {
	legendaryPlus: { counter: 'legendaryPlus', tiers: ['legendary', 'lucky'], softStart: 4, rampPerCast: 0.04, maxBonus: 0.5, hard: 10 },
};

/**
 * Player profiles (hierarchy):
 *   normal  - the intended competitive game. Stays at the pre-V2 baseline until the Phase 5 balance pass.
 *   founder - intentionally overpowered personal profile (FOUNDER_IDS / dev override). Never competitive.
 *   test    - unrestricted development/testing profile (dev override only). Never competitive.
 * Events (EVENTS below) are timed boosts layered on top of whichever profile a player has.
 * `multipliers` are the profile category of the stacking rule; `stats` add to gear stats;
 * `limits` cap multi-catch. Founder tuning is never a target for normal-player balance.
 */
const PROFILES = {
	normal: {
		competitiveEligible: true,
		rarityTable: NORMAL_RARITY_TABLE,
		stats: {},
		multipliers: { xp: 1, sell: 1, questXp: 1, questCash: 1 },
		limits: { maxDraws: 5, maxPerDraw: 3 },
		pity: null,
		gacha: { stats: {}, pity: null },
	},
	founder: {
		competitiveEligible: false,
		rarityTable: FOUNDER_RARITY_TABLE,
		stats: { durabilityEfficiency: 0.75, fishingSpeed: 0.6 },
		// Extra draws rolled per cast instead of a fixed +2: same average (+2.0), natural-looking
		// catches (starter rod: 1-5 fish, mostly 2-4).
		bonusDraws: { 0: 0.10, 1: 0.25, 2: 0.30, 3: 0.25, 4: 0.10 },
		multipliers: { xp: 5, sell: 10, questXp: 5, questCash: 5 },
		limits: { maxDraws: 8, maxPerDraw: 5 },
		pity: FOUNDER_PITY,
		gacha: { stats: FOUNDER_GACHA_STATS, pity: FOUNDER_GACHA_PITY },
	},
	test: {
		competitiveEligible: false,
		rarityTable: NORMAL_RARITY_TABLE,
		stats: { durabilityEfficiency: 0.9, fishingSpeed: 0.75 },
		multipliers: { xp: 1, sell: 1, questXp: 1, questCash: 1 },
		limits: { maxDraws: 20, maxPerDraw: 20 },
		pity: null,
		gacha: { stats: {}, pity: null },
	},
};

/**
 * Timed events: boosts for everyone while active (e.g. a double-XP weekend). Each entry:
 * { name, startsAt, endsAt, stats: {...}, multipliers: { xp, sell, questXp, questCash } }.
 * Event casts stay competitive. Empty until an event is scheduled.
 */
const EVENTS = [];

/** The event active at `now`, if any. */
function activeEvent(now = new Date(), events = EVENTS) {
	return events.find((e) => new Date(e.startsAt) <= now && now < new Date(e.endsAt)) || null;
}

/** Stats each custom-rod part contributes by its rarity (summed over rod, reel, hook and handle). */
const PART_RARITY_STATS = {
	Common: {},
	Uncommon: { rareFind: 0.05 },
	Rare: { rareFind: 0.1, luck: 0.05 },
	Ultra: { rareFind: 0.15, luck: 0.1, trophyChance: 0.1 },
	Legendary: { rareFind: 0.25, luck: 0.2, trophyChance: 0.15, sellBonus: 0.05 },
	Lucky: { rareFind: 0.3, luck: 0.3, trophyChance: 0.2, sellBonus: 0.1 },
};

/** Each 'quick' quality on a rod or part adds this much Fishing Speed. */
const QUICK_FISHING_SPEED = 0.05;

/**
 * Catalog bait translated into the stat model. Qualities come from the item's capabilities and XP
 * Bonus from its legacy `multiplier` field. Rarity stats follow each bait's legacy weights but now
 * actually raise the advertised tiers. Multi-catch keeps today's effective behaviour: the legacy
 * "N count" (fish per draw) worked, the legacy bare numbers (extra draws) never did, so baits give
 * perDraw only. Unknown baits use the mechanical converter.
 */
const BAIT_STATS = {
	'Worm': {},
	'Minnow': { trophyChance: 1.5 },
	'Shrimp': {},
	'Spinner': { perDraw: 1 },
	'Fly': { rareFind: 1.0 },
	'Bloodworm': { rareFind: 1.0 },
	'Lure': { rareFind: 1.0, perDraw: 1 },
	'Magic Lure': { rareFind: 1.5, trophyChance: 1.0, luck: 1.5, perDraw: 1 },
	'Magnet': { luck: 2.0 },
	'Strong Magnet': { luck: 4.0 },
};

/** Level curve: floor(0.1 * sqrt(xp)), minimum 1. */
function levelForXp(xp) {
	return Math.max(Math.floor(0.1 * Math.sqrt(Math.max(0, xp || 0))), 1);
}

/**
 * The profile a player casts under. FOUNDER_IDS decides Founder (DEVELOPER_IDS does not); a
 * developer override on the player (`devOverrides.profile` = 'founder' | 'normal' | 'test') wins.
 */
function resolveProfile(userId, userDoc = null, cfg = config) {
	const override = userDoc?.devOverrides?.profile;
	const founders = cfg.users?.founders || [];
	let name = founders.includes(String(userId)) ? 'founder' : 'normal';
	if (override && PROFILES[override]) name = override;
	return { name, ...PROFILES[name], override: override || null };
}

module.exports = {
	BALANCE_VERSION,
	RARITIES,
	RARITY_STAT_TIERS,
	NORMAL_RARITY_TABLE,
	FOUNDER_RARITY_TABLE,
	XP_PER_FISH,
	DURABILITY,
	COOLDOWN,
	STAT_CAPS,
	FOUNDER_PITY,
	FOUNDER_GACHA_STATS,
	FOUNDER_GACHA_PITY,
	PROFILES,
	PART_RARITY_STATS,
	QUICK_FISHING_SPEED,
	BAIT_STATS,
	EVENTS,
	activeEvent,
	levelForXp,
	resolveProfile,
	// Back-compat for Phase 2 callers.
	BASE: { xpPerFish: XP_PER_FISH },
};
