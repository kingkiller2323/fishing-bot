// Phase 5B subsystem: RODS, CRAFTING, CRATES, REPAIRS, OLD ROD. Analysis only: nothing here touches
// the live game, src/ or production data. Every economic number below is computed at runtime from the
// shared framework (./framework.js, version 5b.5) and, for lifecycle figures, from the integrated model
// (./integrate.js on the shared lifecycle core ./lifecycle.js). Only the design parameters in PARAMS are
// hand-set; prices are formulas of stage income, so a framework change regenerates every figure. This
// module never steps time itself: rods is a SYSTEM on the shared core (system()).
//
//   node -e "require('./scripts/economy/5b/rods.js').report()"     (returns the report object)
//   node scripts/economy/5b/rods.js                                  (prints it as JSON)
//   node scripts/economy/5b/render-docs.js                           (regenerates docs/economy/5b/rods.md tables)
//
// Exports (all pure and synchronous unless noted; no database, no randomness):
//   PARAMS                      frozen design parameters (part levels, slot stat families, variants,
//                               durability lives, upkeep share, crate tables, assembly hours, salvage)
//   RARITY_ORDER, SLOTS, CATALOG, ARCHETYPES, TARGETS
//                               part rarities (low -> high), slot -> catalog type, the seeded rod parts
//                               (src/bootstrap/data/rodParts.js), player cadences, approved level windows
//   tierLevel(t), homeBiome(t), stageBiome(t)
//                               level of a tier, biome a tier is built for, biome of the stage before it
//   capRarity(rarity, level)    highest part rarity whose full effect a player of `level` has unlocked
//   partProfile(part, {playerLevel})
//                               one part's contribution under the proposed slot families
//   matchedSet(rarity)          catalog-free balanced part set of one rarity (per slot: the highest
//                               rarity <= `rarity` that exists in the catalog for that slot)
//   referenceSet(tier)          the tier-appropriate set every tier figure is quoted for
//   performance(parts, {playerLevel})
//                               stats, meanFish, multiChance, jackpot odds, cooldown (no durability)
//   craftRod(parts, {playerLevel})
//                               the proposed crafted rod: performance + tier, level requirement,
//                               maxDurability, repairCost (unlimited repairs)
//   baseDurability(rarity), repairCostFor(rarity)
//                               durability base and repair cost by rod-piece rarity (formulas)
//   oldRod()                    the proposed starter rod (unbreakable, weak only, 1 fish)
//   rodOutcome(rod, biome), rodHourly(rod, biome, overheadS)
//                               F.castOutcome / F.hourly for a rod (normal profile)
//   upkeepShare(rod, biome)     repair cost as a share of the fish income the same durability earns
//   legacyCombine(parts), legacyCraft(parts)
//                               TODAY's crafting (mirror of FishingRod.combineQualities + generateStats,
//                               then resolveModifiers): capabilities, level, fish/cast, durability, repair
//   verifyLegacyParity()        ASYNC: the mirror equals the real FishingRod.combineQualities on all combos
//   legacySignature(capabilities), convertLegacyRod(storedRod, partDocs)
//                               converter for EXISTING crafted rods (no data rewrite)
//   evaluateAllCombos()         every catalog part combination under today's and the proposed rules
//   slotBalanceFeatured()       V2 `featured` groups that make each slot type equally likely per rarity
//   crateDefinition(t), crateDefinitions()
//                               proposed Gacha V2 box definitions (+ price: formula of stage income)
//   openOutcomes(def, pityCounter)
//                               every outcome of one open, exactly as the engine decides it
//   crateSlotOdds(t)            per crate slot: P(rarity) and P(slot type)
//   cratesDistribution(t, {need})
//                               exact expected / median / P90 crates to collect the needed parts
//   stageIncome(t), cratePrice(t)
//                               income of the stage before tier t; crate price from it
//   assembly(t)                 crates, $ and hours of stage income to assemble tier t's set, leftover
//                               parts and salvage refund
//   salvageValue(rarity)        cash for salvaging one part of that rarity
//   crateOpenValue(t)           one open of tier crate t: price, expected salvage, Rare+ parts
//   legacyCrate()               a Fishing Crate bought at TODAY's catalog price, opened after release, under
//                               each owned-stock option of P-RODS-FISHING-CRATE (rods.md §7.4; fix C6)
//   catalogSync()               the release catalog sync (catalogRevision PARAMS.id) and startup assertions (§13)
//   legacyDurability()          grandfathered durability over every combination (P-RODS-LEGACY-DURABILITY)
//   validateCratesWithEngine(opens)
//                               ASYNC, opt-in: real Gacha V2 openLine on an in-memory MongoDB (test
//                               helpers, never production) vs cratesDistribution; ENGINE_VALIDATION is
//                               the recorded run the doc quotes
//   gearPath()                  the shared gear path (framework F.gearPath() reads it; R3): per tier
//                               {tier, level, qualities, stats, multiChance, meanFish, cooldownMs,
//                               maxDurability, repairCost, repairCostPerFish, assembly: {price, ...}}
//   system(opts)                this subsystem as a lifecycle.js SYSTEM (fresh object per call): tier
//                               assemblies as 'progression' goals, equip at the tier level, repair
//                               upkeep, salvage refunds (see the system() comment); SYSTEM_DEFAULTS
//   assemblyPlan(path, opts)    the per-tier purchases system() makes (Normal or Founder crate luck)
//   lifecycle(archetype, opts)  the rods view of one INTEGRATED lifecycle (integrate.run; see its comment)
//   SYSTEM_PARITY               constant record: system() vs the retired private loop (commit a83b5f0)
//   DECISIONS                   this design's PROPOSED decisions (joined by decisions.js)
//   report()                    every key number of docs/economy/5b/rods.md, computed (cached)
//   markdownTables()            the generated tables of docs/economy/5b/rods.md (render-docs.js)
const F = require('./framework');
const LC = require('./lifecycle');
const CATALOG = require('../../../src/bootstrap/data/rodParts');
const { baseTable } = require('../../../src/engine/gacha');
const { applyPity, normalize } = require('../../../src/engine/rarity');
const { RARITIES, PROFILES, QUICK_FISHING_SPEED } = require('../../../src/engine/balance');
const { resolveModifiers } = require('../../../src/engine/modifiers');
// Today's Fishing Crate definition, snapshotted at load (validateCratesWithEngine re-registers boxes in-process).
const LEGACY_BOXES = JSON.parse(JSON.stringify({ 'Fishing Crate': require('../../../src/engine/gachaBoxes').BOXES['Fishing Crate'] }));

const deepFreeze = (o) => {
	for (const v of Object.values(o)) if (v && typeof v === 'object') deepFreeze(v);
	return Object.freeze(o);
};

const RARITY_ORDER = ['Common', 'Uncommon', 'Rare', 'Ultra', 'Legendary', 'Lucky'];
const SLOTS = { rod: 'part_rod', reel: 'part_reel', hook: 'part_hook', handle: 'part_handle' };
const SLOT_OF_TYPE = Object.fromEntries(Object.entries(SLOTS).map(([s, t]) => [t, s]));
const rank = (r) => RARITY_ORDER.indexOf(r);
const canon = (r) => RARITY_ORDER.find((x) => x.toLowerCase() === String(r).toLowerCase());

// ---------------------------------------------------------------------------------------------
// Design parameters (the only hand-set numbers in this subsystem).
const PARAMS = deepFreeze({
	id: 'rods-5b',
	craft: {
		// 5b.5 (P-RODS-CUSTOM-LEVEL-RULE): the Rod Workshop opens at Lv 10, with the Fishing Crate (its parts'
		// source) and the first standard rod. A part works at full strength once the player reaches its level
		// (see capRarity); below it, it works at the best rarity the player has unlocked. The rod's requirement
		// is its highest part's level (four Commons: Lv 10, not today's inherited 10 x the summed counts = Lv 40).
		// Every crafted rod catches strong fish.
		minLevel: 10,
		qualities: ['weak', 'strong'],
	},
	// Level at which a part of each rarity works at full strength. The rod's requirement (shown on the
	// rod) is the highest of its four parts; its tier follows from that level.
	partLevel: { Common: 10, Uncommon: 20, Rare: 30, Ultra: 40, Legendary: 50, Lucky: 60 },
	tierOfRarity: { Common: 1, Uncommon: 1, Rare: 2, Ultra: 3, Legendary: 4, Lucky: 5 },
	// The tier-appropriate set every tier figure is quoted for (matchedSet of this rarity).
	referenceRarity: { 1: 'Uncommon', 2: 'Rare', 3: 'Ultra', 4: 'Legendary', 5: 'Lucky' },
	// Each SLOT has its own stat family; magnitudes scale with the part's rarity and ADD across parts
	// (PART_RARITY_STATS semantics: every part contributes by its rarity; now each slot contributes a
	// different family instead of the same uniform bundle).
	slots: {
		rod: {
			family: 'Multi-catch (mean fish per cast) and the durability base',
			meanFish: { Common: 1.10, Uncommon: 1.20, Rare: 1.30, Ultra: 1.50, Legendary: 1.65, Lucky: 1.80 },
		},
		reel: {
			family: 'Fishing speed (cooldown) and trophy/drag (Giant weight)',
			fishingSpeed: { Common: 0, Uncommon: 0.03, Rare: 0.05, Ultra: 0.10, Legendary: 0.15, Lucky: 0.20 },
			trophyChance: { Common: 0, Uncommon: 0.05, Rare: 0.10, Ultra: 0.30, Legendary: 0.50, Lucky: 0.70 },
		},
		hook: {
			family: 'Rarity targeting: Rare Find (Rare/Ultra) and Luck (Legendary/Lucky)',
			rareFind: { Common: 0.10, Uncommon: 0.20, Rare: 0.40, Ultra: 0.60, Legendary: 0.90, Lucky: 1.20 },
			luck: { Common: 0.05, Uncommon: 0.10, Rare: 0.20, Ultra: 0.40, Legendary: 0.60, Lucky: 0.80 },
		},
		handle: {
			family: 'Durability efficiency (casts per life, so upkeep per fish) and clean handling (sell bonus)',
			durabilityMult: { Common: 1.0, Uncommon: 1.1, Rare: 1.25, Ultra: 1.45, Legendary: 1.7, Lucky: 2.0 },
			sellBonus: { Common: 0, Uncommon: 0, Rare: 0.02, Ultra: 0.04, Legendary: 0.06, Lucky: 0.08 },
		},
	},
	// Same-slot, same-rarity parts are SIDE-GRADES: about the same net $/h, a different emphasis (XP pace,
	// Giant or Legendary rate, repair frequency). Tilts follow today's catalog identity: more legacy draws =
	// fast action, more legacy durability = backbone, 'quick' = light retrieve, a reel with an extra legacy
	// draw = trolling. Multipliers apply to that slot's stats; meanDelta is added to mean fish per cast.
	// Speed and Rare Find are worth several times more cash than Trophy or Luck (see report().statValue),
	// so the Trophy/Luck side of each pair gets the larger multiplier.
	variants: {
		'Fiberglass Rod Piece': { label: 'Fast action', meanDelta: 0.02, durability: 0.75 },
		'Graphite Rod Piece': { label: 'Backbone', meanDelta: -0.02, durability: 1.5 },
		'Centerpin Reel': { label: 'Free-spool', fishingSpeed: 1.2, trophyChance: 0.5 },
		'Jigging Reel': { label: 'Heavy drag', fishingSpeed: 0.8, trophyChance: 2.5 },
		'Fly Fishing Reel': { label: 'Light retrieve', fishingSpeed: 1.2, trophyChance: 0.5 },
		'Trolling Reel': { label: 'Trolling drag', fishingSpeed: 0.8, trophyChance: 2.5 },
		'Swimbait Hook': { label: 'Big bait', rareFind: 0.85, luck: 1.5 },
		'Worm Hook': { label: 'Natural bait', rareFind: 1.15, luck: 0.6 },
	},
	// Normal-player multi-catch ceiling (framework endgame mean).
	multi: { ceilingMean: 1.8 },
	durability: {
		// Hours of play (regular cadence) one life of a MATCHED set lasts, by rod-piece rarity. The handle
		// multiplies it. Durability still costs 1 per fish (the engine rule is unchanged).
		lifeHours: { Common: 2.5, Uncommon: 3, Rare: 4, Ultra: 5, Legendary: 6, Lucky: 8 },
		roundTo: 50,
	},
	repair: {
		// Mandatory upkeep: a matched set's repair costs this share of the fish income its durability
		// earns in the tier's home biome. Repair cost follows the rod piece's rarity.
		upkeepShare: 0.04,
		// Crafted rods: unlimited repairs (no destruction); legacy 'destroyed' crafted rods become repairable.
		craftedMaxRepairs: null,
	},
	oldRod: { unbreakable: true, meanFish: 1.0, qualities: ['weak'] },
	crates: {
		slots: 3,
		strategy: 'independent',
		duplicates: 'unique',
		// Featured weights make each slot type equally likely within a rarity (the catalog has 10 reels,
		// 7 rod pieces, 7 hooks and 5 handles; without this the coupon-collector tail is the handle/hook).
		balanceSlots: true,
		tiers: {
			1: { name: 'Fishing Crate', existing: true, unlockLevel: 10, rarityTable: { common: 50, uncommon: 47, rare: 3 }, rarityFloor: null, guaranteed: 'uncommon' },
			2: { name: 'Pro Tackle Crate', unlockLevel: 20, rarityTable: { uncommon: 45, rare: 52, ultra: 3 }, rarityFloor: 'uncommon', guaranteed: 'rare' },
			3: { name: 'Expert Tackle Crate', unlockLevel: 30, rarityTable: { rare: 45, ultra: 52, legendary: 3 }, rarityFloor: 'rare', guaranteed: 'ultra' },
			4: { name: 'Master Tackle Crate', unlockLevel: 40, rarityTable: { ultra: 45, legendary: 54, lucky: 1 }, rarityFloor: 'ultra', guaranteed: 'legendary' },
			5: {
				name: 'Gilded Tackle Crate', unlockLevel: 50, rarityTable: { legendary: 80, lucky: 20 }, rarityFloor: 'legendary', guaranteed: null,
				pity: { lucky: { counter: 'lucky', tiers: ['lucky'], softStart: 3, rampPerCast: 0.1, maxBonus: 0.5, hard: 8 } },
			},
		},
	},
	// Progression purchase: expected cost of assembling tier t's set, in hours of the income of the stage
	// that leads up to it (previous tier's rod in the biome unlocked 10 levels before tier t).
	assemblyHours: { 1: 1.25, 2: 2.5, 3: 4, 4: 6, 5: 8 },
	salvage: {
		// Salvaging a part pays this share of one crate slot of the crate whose guaranteed rarity it is.
		share: 0.25,
		commonOfUncommon: 0.25,
	},
	priceSigDigits: 2,
	// 5b.5 STANDARD RODS (P-RODS-STANDARD-LADDER): shop rods bought with cash, one per biome level, the
	// reference gear path (GEAR_PATH_LADDER 'standard'). Generalists: modest multi-catch (always below the
	// custom set of the same level and the 1.80 normal ceiling), a little of every stat, strong access from
	// the first one. price = priceHours x the income of the stage before the rod (the previous standard rod in
	// the biome unlocked 10 levels earlier, reference cadence), 2 significant digits. Durability: one life lasts
	// lifeHours of regular play; repair = repair.upkeepShare of what that life earns at home (as crafted rods).
	standard: {
		rods: [
			{ tier: 1, name: 'Trusty Rod', role: 'basic', level: 10, meanFish: 1, qualities: ['weak', 'strong'], stats: { rareFind: 0.1, luck: 0.05, trophyChance: 0, fishingSpeed: 0.02, sellBonus: 0 }, lifeHours: 3, priceHours: 0.6 },
			{ tier: 2, name: 'Angler\'s Rod', role: 'better', level: 20, meanFish: 1.15, qualities: ['weak', 'strong'], stats: { rareFind: 0.15, luck: 0.08, trophyChance: 0.05, fishingSpeed: 0.03, sellBonus: 0 }, lifeHours: 3.5, priceHours: 0.75 },
			{ tier: 3, name: 'Pro Angler Rod', role: 'midgame', level: 30, meanFish: 1.28, qualities: ['weak', 'strong'], stats: { rareFind: 0.3, luck: 0.15, trophyChance: 0.08, fishingSpeed: 0.07, sellBonus: 0.01 }, lifeHours: 4, priceHours: 1.9 },
			{ tier: 4, name: 'Expedition Rod', role: 'advanced', level: 40, meanFish: 1.48, qualities: ['weak', 'strong'], stats: { rareFind: 0.45, luck: 0.3, trophyChance: 0.2, fishingSpeed: 0.1, sellBonus: 0.02 }, lifeHours: 5, priceHours: 2.9 },
			{ tier: 5, name: 'Master\'s Rod', role: 'elite', level: 50, meanFish: 1.62, qualities: ['weak', 'strong'], stats: { rareFind: 0.7, luck: 0.45, trophyChance: 0.35, fishingSpeed: 0.15, sellBonus: 0.04 }, lifeHours: 6, priceHours: 4.8 },
			{ tier: 6, name: 'Summit Rod', role: 'endgame', level: 60, meanFish: 1.75, qualities: ['weak', 'strong'], stats: { rareFind: 0.85, luck: 0.55, trophyChance: 0.45, fishingSpeed: 0.14, sellBonus: 0.05 }, lifeHours: 7, priceHours: 6.5 },
		],
		// A standard rod is listed (greyed, "unlocks at Lv X") one stage early so the player can save toward it.
		previewLevels: 10,
		// Custom tier c (crate tier c) competes with the standard rod of the same level (standard tier c + 1).
		customOffset: 1,
	},
	// Owned Fishing Crates at the 5B migration (P-RODS-FISHING-CRATE, user decision: option B). The crate is
	// already delisted (hotfix L5). The migration snapshots each owned stack into an additive legacyCount;
	// /open consumes legacy units first under the OLD Fishing Crate definition; they are never converted and
	// never open as the new T1 part crate. Units acquired after release open under the new definition.
	legacyCrateStock: { option: 'b', marker: 'legacyCount', opensAs: 'legacy-definition-first', converted: false },
});

// ---------------------------------------------------------------------------------------------
// Helpers
// Shared (framework assumptions): live biomes and the biome unlocked at a level.
const MODELLED_BIOMES = F.LIVE_BIOMES;
const biomeForLevel = (L) => F.biomeAt(L);
const tierLevel = (t) => PARAMS.partLevel[PARAMS.referenceRarity[t]];
const homeBiome = (t) => biomeForLevel(tierLevel(t));
const stageBiome = (t) => biomeForLevel(tierLevel(t) - 10);
const TIERS = [1, 2, 3, 4, 5];
const round4 = (x) => Number(x.toFixed(4));
const roundTo = (x, step) => Math.round(x / step) * step;
function nicePrice(x, digits = PARAMS.priceSigDigits) {
	if (!(x > 0)) return 0;
	const p = 10 ** (Math.floor(Math.log10(x)) - digits + 1);
	return Math.round(x / p) * p;
}

/** Highest part rarity (<= rarity) whose full effect a player of `level` has unlocked; null below Lv 20. */
function capRarity(rarity, level = Infinity) {
	for (let i = rank(rarity); i >= 0; i--) if (PARAMS.partLevel[RARITY_ORDER[i]] <= level) return RARITY_ORDER[i];
	return null;
}

/** One part's contribution under the proposed slot families. `part` = { name, type, rarity }. */
function partProfile(part, { playerLevel = Infinity } = {}) {
	const slot = SLOT_OF_TYPE[part.type];
	const rarity = canon(part.rarity);
	if (!slot || !rarity) throw new Error(`Not a rod part: ${part.name} (${part.type}, ${part.rarity})`);
	const eff = capRarity(rarity, playerLevel) || 'Common';
	const v = PARAMS.variants[part.name] || {};
	const S = PARAMS.slots[slot];
	const out = { slot, name: part.name, rarity, effectiveRarity: eff, level: PARAMS.partLevel[rarity], tier: PARAMS.tierOfRarity[rarity], variant: v.label || 'Balanced', stats: {} };
	if (slot === 'rod') out.meanFish = S.meanFish[eff] + (v.meanDelta || 0);
	if (slot === 'reel') out.stats = { fishingSpeed: S.fishingSpeed[eff] * (v.fishingSpeed ?? 1), trophyChance: S.trophyChance[eff] * (v.trophyChance ?? 1) };
	if (slot === 'hook') out.stats = { rareFind: S.rareFind[eff] * (v.rareFind ?? 1), luck: S.luck[eff] * (v.luck ?? 1) };
	if (slot === 'handle') out.stats = { sellBonus: S.sellBonus[eff] };
	// Durability is a property of the physical rod (nominal rarity), never level-capped.
	if (slot === 'rod') out.durabilityVariant = v.durability ?? 1;
	if (slot === 'handle') out.durabilityMult = S.durabilityMult[rarity];
	for (const k of Object.keys(out.stats)) out.stats[k] = round4(out.stats[k]);
	return out;
}

const bySlot = (parts) => {
	const list = Array.isArray(parts) ? parts : Object.values(parts);
	const out = {};
	for (const p of list) out[SLOT_OF_TYPE[p.type]] = p;
	for (const s of Object.keys(SLOTS)) if (!out[s]) throw new Error(`Missing ${s} part`);
	return out;
};

/** Balanced (variant-free) virtual part set of one rarity: per slot, the highest catalog rarity <= it. */
function matchedSet(rarity) {
	const set = {};
	for (const [slot, type] of Object.entries(SLOTS)) {
		const have = new Set(CATALOG.filter((p) => p.type === type).map((p) => canon(p.rarity)));
		let r = rarity;
		while (!have.has(r)) r = RARITY_ORDER[rank(r) - 1];
		set[slot] = { name: `${r} ${slot} (balanced)`, type, rarity: r };
	}
	return set;
}
const referenceSet = (t) => matchedSet(PARAMS.referenceRarity[t]);

/** Performance of a set (no durability): stats, mean fish, multi-catch chance, cooldown. */
function performance(parts, { playerLevel = Infinity } = {}) {
	const s = bySlot(parts);
	const prof = Object.fromEntries(Object.entries(s).map(([k, p]) => [k, partProfile(p, { playerLevel })]));
	const stats = { rareFind: 0, luck: 0, trophyChance: 0, sellBonus: 0, xpBonus: 0, fishingSpeed: 0, durabilityEfficiency: 0 };
	for (const p of Object.values(prof)) for (const [k, v] of Object.entries(p.stats)) stats[k] = round4(stats[k] + v);
	const meanFish = Math.min(PARAMS.multi.ceilingMean, Math.max(1, prof.rod.meanFish));
	const multiChance = meanFish > 1 ? F.chanceForMean(meanFish) : 0;
	const dist = F.fishDistribution(multiChance);
	const topRarity = RARITY_ORDER[Math.max(...Object.values(prof).map((p) => rank(p.rarity)))];
	return {
		parts: prof,
		tier: PARAMS.tierOfRarity[topRarity],
		level: PARAMS.partLevel[topRarity],
		qualities: [...PARAMS.craft.qualities],
		stats,
		meanFish,
		multiChance,
		jackpot3plus: dist.p3plus,
		jackpot5: dist.p5,
		cooldownMs: Math.max(F.COOLDOWN.minMs, Math.round(F.COOLDOWN.fishMs * (1 - stats.fishingSpeed))),
	};
}

const fishPerHour = (perf, overheadS = F.DESIGN_OVERHEAD_S) => (3600 / (perf.cooldownMs / 1000 + overheadS)) * perf.meanFish;

/** Durability base of a rod piece rarity: its matched set lasts lifeHours[rarity] at the design cadence. */
const baseDurabilityCache = new Map();
function baseDurability(rarity) {
	if (!baseDurabilityCache.has(rarity)) {
		const set = matchedSet(rarity);
		const perf = performance(set);
		const handleMult = PARAMS.slots.handle.durabilityMult[set.handle.rarity];
		baseDurabilityCache.set(rarity, (PARAMS.durability.lifeHours[rarity] * fishPerHour(perf)) / handleMult);
	}
	return baseDurabilityCache.get(rarity);
}

/** Repair cost by rod-piece rarity: upkeepShare of what the matched set's durability earns at home. */
const repairCache = new Map();
function repairCostFor(rarity) {
	if (!repairCache.has(rarity)) {
		const set = matchedSet(rarity);
		const perf = performance(set);
		const maxDurability = roundTo(baseDurability(rarity) * PARAMS.slots.handle.durabilityMult[set.handle.rarity], PARAMS.durability.roundTo);
		const o = F.castOutcome({ biome: homeBiome(PARAMS.tierOfRarity[rarity]), qualities: perf.qualities, stats: perf.stats, multiChance: perf.multiChance });
		repairCache.set(rarity, nicePrice(PARAMS.repair.upkeepShare * maxDurability * o.valuePerFish));
	}
	return repairCache.get(rarity);
}

/** The proposed crafted rod for a part set (catalog parts or matchedSet virtual parts). */
function craftRod(parts, { playerLevel = Infinity } = {}) {
	const perf = performance(parts, { playerLevel });
	const s = bySlot(parts);
	const rp = perf.parts.rod;
	const maxDurability = roundTo(baseDurability(rp.rarity) * perf.parts.handle.durabilityMult * rp.durabilityVariant, PARAMS.durability.roundTo);
	return {
		...perf,
		names: Object.values(s).map((p) => p.name),
		rarities: Object.fromEntries(Object.entries(s).map(([k, p]) => [k, canon(p.rarity)])),
		maxDurability,
		lifeHoursRegular: maxDurability / fishPerHour(perf, ARCHETYPES.regular.overheadS),
		repairCost: repairCostFor(rp.rarity),
		maxRepairs: PARAMS.repair.craftedMaxRepairs,
	};
}

/** The proposed starter rod: unbreakable, weak only, one fish per cast, no stats. */
function oldRod() {
	return {
		tier: 0, level: 0, qualities: [...PARAMS.oldRod.qualities], stats: {}, meanFish: PARAMS.oldRod.meanFish, multiChance: 0, jackpot3plus: 0, jackpot5: 0,
		cooldownMs: F.COOLDOWN.fishMs, maxDurability: null, unbreakable: PARAMS.oldRod.unbreakable, repairCost: 0, maxRepairs: null,
	};
}

const rodOutcome = (rod, biome, extra = {}) => F.castOutcome({ biome, qualities: rod.qualities, stats: rod.stats, multiChance: rod.multiChance, ...extra });
const rodHourly = (rod, biome, overheadS = F.DESIGN_OVERHEAD_S) => F.hourly(rodOutcome(rod, biome), overheadS);
/** Repair cost / fish income earned by one durability life (cadence-independent: both are per fish). */
function upkeepShare(rod, biome) {
	if (!rod.maxDurability || !rod.repairCost) return 0;
	return rod.repairCost / (rod.maxDurability * rodOutcome(rod, biome).valuePerFish);
}

// Shared player archetypes (framework assumptions).
const ARCHETYPES = F.ARCHETYPES;

// ---------------------------------------------------------------------------------------------
// STANDARD RODS (5b.5): shop rods bought with cash; the reference gear path (P-RODS-STANDARD-LADDER).
const STANDARD_TIERS = PARAMS.standard.rods.map((r) => r.tier);
const standardCache = new Map();
/** The standard (shop) rod of tier t (1..6), priced from the income of the stage before it. */
function standardRod(t) {
	if (standardCache.has(t)) return standardCache.get(t);
	const d = PARAMS.standard.rods.find((r) => r.tier === t);
	if (!d) throw new Error(`No standard rod tier ${t}`);
	const stats = { rareFind: 0, luck: 0, trophyChance: 0, sellBonus: 0, xpBonus: 0, fishingSpeed: 0, durabilityEfficiency: 0, ...d.stats };
	const meanFish = Math.min(PARAMS.multi.ceilingMean, d.meanFish);
	const multiChance = meanFish > 1 ? F.chanceForMean(meanFish) : 0;
	const dist = F.fishDistribution(multiChance);
	const perf = { meanFish, cooldownMs: Math.max(F.COOLDOWN.minMs, Math.round(F.COOLDOWN.fishMs * (1 - stats.fishingSpeed))) };
	const maxDurability = roundTo(d.lifeHours * fishPerHour(perf), PARAMS.durability.roundTo);
	const home = biomeForLevel(d.level);
	const rod = { tier: t, name: d.name, role: d.role, level: d.level, qualities: [...d.qualities], stats, meanFish, multiChance, jackpot3plus: dist.p3plus, jackpot5: dist.p5, cooldownMs: perf.cooldownMs, maxDurability, maxRepairs: null };
	rod.lifeHoursRegular = maxDurability / fishPerHour(perf, ARCHETYPES.regular.overheadS);
	rod.repairCost = nicePrice(PARAMS.repair.upkeepShare * maxDurability * rodOutcome(rod, home).valuePerFish);
	const prev = t === 1 ? oldRod() : standardRod(t - 1);
	const stage = biomeForLevel(d.level - 10);
	rod.homeBiome = home;
	rod.stageBiome = stage;
	rod.stageIncomePerHour = rodHourly(prev, stage, F.DESIGN_OVERHEAD_S).cash;
	rod.priceHours = d.priceHours;
	rod.price = nicePrice(d.priceHours * rod.stageIncomePerHour);
	rod.previewLevel = Math.max(0, d.level - PARAMS.standard.previewLevels);
	standardCache.set(t, rod);
	return rod;
}
const standardRods = () => STANDARD_TIERS.map(standardRod);

// ---------------------------------------------------------------------------------------------
// Today's rules (for Current -> Proposed and the legacy converter).
const NORMAL = { name: 'normal', ...PROFILES.normal };
/** Synchronous mirror of FishingRod.combineQualities (verifyLegacyParity() checks it against the class). */
function legacyCombine(list) {
	const combined = new Set();
	let numbers = 0;
	let counts = 0;
	let durability = 0;
	for (const part of list) {
		for (const q of part.qualities) {
			if (/^\d+$/.test(q)) numbers += parseInt(q, 10);
			else if (q.includes('count')) counts += parseInt(q.split(' ')[0], 10);
			else if (q.includes('durability')) durability += parseInt(q.split(' ')[0], 10);
			else combined.add(q);
		}
	}
	if (numbers > 0) combined.add(numbers.toString());
	if (counts > 0) combined.add(`${counts} count`);
	if (durability > 0) combined.add(`${durability} durability`);
	return Array.from(combined);
}
/** Today's repair limit on a crafted rod (FishingRod.generateStats: maxRepairs), then it is destroyed. */
const LEGACY_CRAFTED_MAX_REPAIRS = 3;
/** TODAY's crafted rod (FishingRod.generateStats + resolveModifiers for a normal player). */
function legacyCraft(parts) {
	const list = Object.values(bySlot(parts));
	const capabilities = legacyCombine(list);
	let durability = 0;
	let count = 0;
	for (const q of capabilities) {
		if (q.includes('durability')) durability = parseInt(q, 10);
		else if (q.includes('count')) count = parseInt(q, 10);
	}
	const m = resolveModifiers({ profile: NORMAL, rod: { name: 'x', type: 'customrod', capabilities }, rodParts: list.map((p) => ({ ...p })) });
	return { capabilities, level: count * 10, fishPerCast: m.draws * m.perDraw, durability, repairCost: count * 10000, maxRepairs: LEGACY_CRAFTED_MAX_REPAIRS, cooldownMs: m.cooldownMs };
}
/** Async: every catalog combination's capabilities from the real FishingRod.combineQualities equal the mirror's. */
async function verifyLegacyParity() {
	const { FishingRod } = require('../../../src/class/FishingRod');
	let mismatches = 0;
	for (const c of evaluateAllCombos()) {
		const list = c.names.map((n) => CATALOG.find((p) => p.name === n));
		const real = await FishingRod.prototype.combineQualities.call(null, list);
		if (JSON.stringify(real) !== JSON.stringify(legacyCombine(list))) mismatches++;
	}
	return { combos: evaluateAllCombos().length, mismatches };
}

/** What a stored crafted rod's capabilities still say about it (the legacy fingerprint). */
function legacySignature(capabilities = []) {
	const num = capabilities.find((c) => /^\d+$/.test(c)) || '0';
	const count = (capabilities.find((c) => /^\d+\s*count$/i.test(c)) || '0').split(' ')[0];
	const dur = (capabilities.find((c) => /durability$/i.test(c)) || '0').split(' ')[0];
	return `n${num}|c${count}|d${dur}|${capabilities.includes('quick') ? 'q' : '-'}|${capabilities.includes('strong') ? 's' : '-'}`;
}

let combosCache = null;
/** All 2,450 catalog combinations: today's craft and the proposed craft (at the rod's own level). */
function evaluateAllCombos() {
	if (combosCache) return combosCache;
	const byType = (t) => CATALOG.filter((p) => p.type === t);
	const rows = [];
	for (const rod of byType('part_rod')) {
		for (const reel of byType('part_reel')) {
			for (const hook of byType('part_hook')) {
				for (const handle of byType('part_handle')) {
					const set = { rod, reel, hook, handle };
					const legacy = legacyCraft(set);
					const p = craftRod(set);
					const biome = homeBiome(p.tier);
					const o = rodOutcome(p, biome);
					const h = F.hourly(o, ARCHETYPES.regular.overheadS);
					rows.push({
						names: p.names, rarities: p.rarities, variants: Object.fromEntries(Object.entries(p.parts).map(([k, x]) => [k, x.variant])),
						legacy: { level: legacy.level, fishPerCast: legacy.fishPerCast, durability: legacy.durability, repairCost: legacy.repairCost, signature: legacySignature(legacy.capabilities) },
						tier: p.tier, level: p.level, meanFish: p.meanFish, jackpot3plus: p.jackpot3plus, stats: p.stats, cooldownMs: p.cooldownMs,
						maxDurability: p.maxDurability, lifeHoursRegular: p.lifeHoursRegular, repairCost: p.repairCost,
						homeBiome: biome, xpPerHour: h.xp, cashPerHour: h.cash, valuePerFish: o.valuePerFish, upkeepShare: upkeepShare(p, biome),
						oceanCashPerHour: rodHourly(p, 'Ocean').cash,
					});
				}
			}
		}
	}
	combosCache = rows;
	return rows;
}

let legacyIndex = null;
function legacyIndexMap() {
	if (legacyIndex) return legacyIndex;
	legacyIndex = new Map();
	for (const r of evaluateAllCombos()) {
		const cur = legacyIndex.get(r.legacy.signature);
		// Conservative: the weakest catalog combination (power = $/h in Ocean, where every rod can fish)
		// consistent with what is stored; ties go to the lower tier.
		if (!cur || r.oceanCashPerHour < cur.oceanCashPerHour - 1e-9 || (Math.abs(r.oceanCashPerHour - cur.oceanCashPerHour) <= 1e-9 && r.tier < cur.tier)) legacyIndex.set(r.legacy.signature, r);
	}
	return legacyIndex;
}

/**
 * Converter for an EXISTING crafted rod (read-only; nothing is rewritten).
 * A: all four part documents resolve (always, in practice: crafting only decrements part counts) ->
 *    the proposed rules on those parts.
 * B: a part is missing -> the weakest catalog combination with the same legacy fingerprint
 *    (bare-number sum, 'N count', durability, quick, strong).
 * C: unknown fingerprint (admin/custom data) -> a matched Common set.
 * Durability is grandfathered: effective max = max(stored maxDurability, proposed). Repairs are
 * unlimited and priced by the proposed rules; a legacy 'destroyed' crafted rod counts as 'broken'.
 */
function convertLegacyRod(stored, partDocs = null) {
	let method = 'parts';
	let rod;
	if (partDocs && Object.values(partDocs).filter(Boolean).length === 4) {rod = craftRod(partDocs, { playerLevel: stored.playerLevel ?? Infinity });}
	else {
		const hit = legacyIndexMap().get(legacySignature(stored.capabilities || []));
		if (hit) {
			method = 'signature';
			const find = (n) => CATALOG.find((p) => p.name === n);
			rod = craftRod(hit.names.map(find), { playerLevel: stored.playerLevel ?? Infinity });
		}
		else {
			method = 'default';
			rod = craftRod(matchedSet('Common'), { playerLevel: stored.playerLevel ?? Infinity });
		}
	}
	const max = Math.max(Number(stored.maxDurability) || 0, rod.maxDurability);
	return {
		method,
		rod,
		durability: { max, remaining: Math.min(max, Number(stored.durability) || 0) },
		state: stored.state === 'destroyed' ? 'broken' : stored.state || 'mint',
		repairCost: rod.repairCost,
		maxRepairs: PARAMS.repair.craftedMaxRepairs,
	};
}

// ---------------------------------------------------------------------------------------------
// Crates (Gacha V2): pools, featured slot balancing, per-slot odds, expected crates to assemble.
const lower = (r) => String(r).toLowerCase();
const PART_POOLS = Object.fromEntries(RARITIES.map((r) => [r, CATALOG.filter((p) => lower(p.rarity) === r)]));

/** Featured groups that give each slot type an equal share within every rarity (V2 `featured`). */
function slotBalanceFeatured() {
	const weights = new Map();
	for (const r of RARITIES) {
		const pool = PART_POOLS[r];
		if (!pool.length) continue;
		const counts = {};
		for (const p of pool) counts[p.type] = (counts[p.type] || 0) + 1;
		const lcm = Object.values(counts).reduce((a, b) => (a * b) / gcd(a, b), 1);
		for (const p of pool) weights.set(p.name, lcm / counts[p.type]);
	}
	const groups = new Map();
	for (const [name, w] of weights) if (w !== 1) groups.set(w, [...(groups.get(w) || []), name]);
	return [...groups.entries()].sort((a, b) => a[0] - b[0]).map(([weight, names]) => ({ names, weight }));
}
function gcd(a, b) {
	return b ? gcd(b, a % b) : a;
}

const priceCache = new Map();
/** Proposed Gacha V2 definition for a tier crate (price attached separately; see cratePrice). */
function crateDefinition(t) {
	const c = PARAMS.crates.tiers[t];
	return {
		id: c.name.toLowerCase().replace(/[^a-z0-9]+/g, '-'),
		name: c.name,
		slots: PARAMS.crates.slots,
		strategy: PARAMS.crates.strategy,
		pool: { types: Object.values(SLOTS), fish: false, exclude: [], featured: PARAMS.crates.balanceSlots ? slotBalanceFeatured() : [] },
		rarityTable: Object.fromEntries(RARITIES.map((r) => [r, c.rarityTable[r] || 0])),
		rarityFloor: c.rarityFloor,
		guaranteedSlots: c.guaranteed ? [{ slot: 0, minRarity: c.guaranteed }] : [],
		duplicates: PARAMS.crates.duplicates,
		pity: c.pity || null,
		shop: { unlockLevel: c.unlockLevel, existingItem: Boolean(c.existing) },
	};
}

/** Per crate slot i: the rarity table the engine rolls (base, floor, guaranteed-slot mask), and pity. */
function slotTables(def, pityCounter = null) {
	let table = baseTable(def, PART_POOLS);
	let guarantee = null;
	if (def.pity && pityCounter !== null) {
		const cfg = Object.fromEntries(Object.entries(def.pity).map(([k, rule]) => [k, { ...rule }]));
		const counters = Object.fromEntries(Object.values(cfg).map((rule) => [rule.counter, pityCounter]));
		const p = applyPity(table, counters, cfg);
		table = p.table;
		guarantee = p.guarantee;
	}
	return Array.from({ length: def.slots }, (_, i) => {
		let t = table;
		const g = def.guaranteedSlots.find((x) => x.slot === i);
		if (g) {
			const masked = Object.fromEntries(RARITIES.map((r) => [r, RARITIES.indexOf(r) >= RARITIES.indexOf(g.minRarity) ? t[r] : 0]));
			if (RARITIES.some((r) => masked[r] > 0)) t = normalize(masked);
		}
		if (i === 0 && guarantee) {
			const tiers = guarantee.filter((r) => t[r] > 0);
			if (tiers.length) t = normalize(Object.fromEntries(RARITIES.map((r) => [r, tiers.includes(r) ? t[r] : 0])));
		}
		return t;
	});
}

const featuredWeight = (def, name) => (def.pool.featured || []).filter((f) => f.names.includes(name)).reduce((a, f) => a * f.weight, 1);

/**
 * Every outcome of ONE open, exactly as the engine decides it: each slot rolls its rarity from its
 * table (independent strategy), then picks a part of that rarity weighted by `featured`; with
 * duplicates 'unique' a part already taken in this open is skipped while another remains. At most
 * (3 rarities x 6 parts)^3 leaves. Returns [{ p, picks: [{ name, type, rarity }] }].
 */
const outcomeCache = new Map();
function openOutcomes(def, pityCounter = null) {
	const key = `${def.id}|${pityCounter}`;
	if (outcomeCache.has(key)) return outcomeCache.get(key);
	if (def.strategy !== 'independent') throw new Error('only independent slots are modelled');
	const tables = slotTables(def, pityCounter);
	const outcomes = [];
	const rec = (i, p, taken, picks) => {
		if (i === tables.length) {
			outcomes.push({ p, picks });
			return;
		}
		for (const r of RARITIES) {
			const pr = tables[i][r];
			if (!pr) continue;
			let cands = PART_POOLS[r];
			if (def.duplicates === 'unique') {
				const fresh = cands.filter((x) => !taken.has(x.name));
				if (fresh.length) cands = fresh;
			}
			const tw = cands.reduce((a, x) => a + featuredWeight(def, x.name), 0);
			for (const c of cands) rec(i + 1, (p * pr * featuredWeight(def, c.name)) / tw, new Set([...taken, c.name]), [...picks, { name: c.name, type: c.type, rarity: r }]);
		}
	};
	rec(0, 1, new Set(), []);
	outcomeCache.set(key, outcomes);
	return outcomes;
}

/** Per crate slot (exact, incl. 'unique'): P(rarity) and P(slot type). */
function crateSlotOdds(t) {
	const def = crateDefinition(t);
	const outcomes = openOutcomes(def, def.pity ? 0 : null);
	return Array.from({ length: def.slots }, (_, i) => {
		const rarity = {};
		const bySlotType = Object.fromEntries(Object.keys(SLOTS).map((x) => [x, 0]));
		for (const o of outcomes) {
			const pick = o.picks[i];
			rarity[pick.rarity] = (rarity[pick.rarity] || 0) + o.p;
			bySlotType[SLOT_OF_TYPE[pick.type]] += o.p;
		}
		// Unrounded: the doc tables round only at presentation (one rounding step).
		return { slot: i, rarity, bySlotType };
	});
}

/** Slots (and the rarity each needs) to go from tier t-1's set to tier t's set. */
function neededSlots(t) {
	const cur = referenceSet(t);
	const prev = t > 1 ? referenceSet(t - 1) : null;
	return Object.keys(SLOTS).filter((s) => !prev || prev[s].rarity !== cur[s].rarity).map((s) => ({ slot: s, rarity: cur[s].rarity }));
}

/**
 * Crates-until-complete distribution, exact: a Markov chain over (needed slots collected, box pity
 * counter) whose per-open transitions come from openOutcomes (so 'unique', featured weights, the
 * guaranteed slot, the floor and pity are all exactly the engine's rules).
 */
function cratesDistribution(t, { need = neededSlots(t), maxN = 5000 } = {}) {
	const def = crateDefinition(t);
	const rules = Object.values(def.pity || {});
	if (rules.length > 1) throw new Error('one pity rule per box is modelled');
	const rule = rules[0] || null;
	const full = (1 << need.length) - 1;
	const hitMask = (picks) => need.reduce((m, n, j) => (picks.some((x) => SLOT_OF_TYPE[x.type] === n.slot && rank(canon(x.rarity)) >= rank(n.rarity)) ? m | (1 << j) : m), 0);
	// Transition table per pity counter: Map `${mask}|${pityHit}` -> p.
	const trans = new Map();
	const transFor = (c) => {
		if (!trans.has(c)) {
			const agg = new Map();
			for (const o of openOutcomes(def, rule ? c : null)) {
				const k = `${hitMask(o.picks)}|${rule && o.picks.some((x) => rule.tiers.includes(x.rarity)) ? 1 : 0}`;
				agg.set(k, (agg.get(k) || 0) + o.p);
			}
			trans.set(c, [...agg.entries()].map(([k, p]) => ({ mask: Number(k.split('|')[0]), pityHit: k.endsWith('|1'), p })));
		}
		return trans.get(c);
	};
	let state = new Map([['0|0', 1]]);
	const survival = [];
	for (let n = 0; n < maxN; n++) {
		const alive = [...state.entries()].filter(([k]) => Number(k.split('|')[0]) !== full).reduce((a, [, p]) => a + p, 0);
		survival.push(alive);
		if (alive < 1e-12) break;
		const next = new Map();
		for (const [k, p] of state) {
			const [mask, c] = k.split('|').map(Number);
			if (mask === full) continue;
			for (const tr of transFor(c)) {
				const nk = `${mask | tr.mask}|${rule ? (tr.pityHit ? 0 : c + 1) : 0}`;
				next.set(nk, (next.get(nk) || 0) + p * tr.p);
			}
		}
		state = next;
	}
	const expected = survival.reduce((a, b) => a + b, 0);
	const quantile = (q) => survival.findIndex((x) => 1 - x >= q);
	return { expected, median: quantile(0.5), p90: quantile(0.9), need };
}

/** Hourly income of the stage leading up to tier t (previous tier's set in the biome unlocked 10 levels earlier). */
function stageIncome(t) {
	const prev = t === 1 ? oldRod() : craftRod(referenceSet(t - 1));
	return rodHourly(prev, stageBiome(t), F.DESIGN_OVERHEAD_S).cash;
}

/** Crate price: assemblyHours x stage income / expected crates to assemble. */
function cratePrice(t) {
	if (!priceCache.has(t)) priceCache.set(t, nicePrice((PARAMS.assemblyHours[t] * stageIncome(t)) / cratesDistribution(t).expected));
	return priceCache.get(t);
}

function crateDefinitions() {
	return TIERS.map((t) => ({ tier: t, ...crateDefinition(t), price: cratePrice(t), priceFormula: `assemblyHours[${t}] (${PARAMS.assemblyHours[t]} h) x stage income / expected crates` }));
}

/** Cash for salvaging one part of `rarity` (share of one slot of the crate that guarantees that rarity). */
function salvageValue(rarity) {
	const r = canon(rarity);
	if (r === 'Common') return nicePrice(PARAMS.salvage.commonOfUncommon * salvageValue('Uncommon'));
	// The crate of the tier whose reference rarity this is (Uncommon->T1 ... Legendary->T4, Lucky->T5).
	const t = TIERS.find((x) => PARAMS.referenceRarity[x] === r);
	return nicePrice((PARAMS.salvage.share * cratePrice(t)) / PARAMS.crates.slots);
}

const isRarePlus = (r) => RARITIES.indexOf(lower(r)) >= RARITIES.indexOf('rare');
/** One open of the proposed tier crate t (first open for T5's pity): its price, expected salvage and Rare+ parts. */
function crateOpenValue(t) {
	const def = crateDefinition(t);
	const tables = slotTables(def, def.pity ? 0 : null);
	let salvage = 0;
	let rarePlus = 0;
	for (const tab of tables) {
		for (const r of RARITIES) {
			if (!PART_POOLS[r].length) continue;
			salvage += tab[r] * salvageValue(r);
			if (isRarePlus(r)) rarePlus += tab[r];
		}
	}
	return { tier: t, price: cratePrice(t), salvagePerOpen: salvage, rarePlusPartsPerOpen: rarePlus };
}

/** Expected salvage value of everything in one crate, as a share of its price (must stay well below 1). */
function crateSalvageRatio(t) {
	return crateOpenValue(t).salvagePerOpen / cratePrice(t);
}

function assembly(t) {
	const d = cratesDistribution(t);
	const price = cratePrice(t);
	const income = stageIncome(t);
	const def = crateDefinition(t);
	const tables = slotTables(def, def.pity ? 0 : null);
	const partsPerCrate = Object.fromEntries(RARITIES.filter((r) => PART_POOLS[r].length).map((r) => [r, tables.reduce((s, tab) => s + tab[r], 0)]));
	const totalParts = d.expected * def.slots;
	// Leftovers: everything opened minus the parts the set uses (Wald: E[parts] = E[crates] x per crate).
	const salvageAll = RARITIES.reduce((s, r) => s + (partsPerCrate[r] || 0) * d.expected * (PART_POOLS[r].length ? salvageValue(r) : 0), 0);
	const salvageUsed = d.need.reduce((s, x) => s + salvageValue(x.rarity), 0);
	const cost = d.expected * price;
	return {
		tier: t,
		crate: def.name,
		price,
		stageBiome: stageBiome(t),
		stageIncomePerHour: income,
		needs: d.need.map((x) => `${x.rarity} ${x.slot}`),
		expectedCrates: d.expected,
		medianCrates: d.median,
		p90Crates: d.p90,
		expectedCost: cost,
		p90Cost: d.p90 * price,
		hoursOfStageIncome: cost / income,
		p90HoursOfStageIncome: (d.p90 * price) / income,
		expectedParts: totalParts,
		leftoverParts: totalParts - d.need.length,
		salvageRefund: salvageAll - salvageUsed,
		netCostAfterSalvage: cost - (salvageAll - salvageUsed),
		salvageReturnPerCrate: crateSalvageRatio(t),
	};
}

// ---------------------------------------------------------------------------------------------
// Owned and pre-release Fishing Crates (P-RODS-FISHING-CRATE; fixes C6 and the catalog sync of §13).
// The shop sells TODAY's Fishing Crate at its catalog price (src/bootstrap/data/gacha.js; seed.js never
// changes an existing row, so that row is what production serves). /open resolves a box's definition by
// name, so under the proposal every owned crate opens as the T1 part crate. These functions size what a
// crate bought at today's price returns after release under each owned-stock option. Read-only.
const todayCatalogRow = (file, name) => require(`../../../src/bootstrap/data/${file}`).find((x) => x.name === name);
/** Scale for the sizing column: money a player holds today (an analysis setting, not a design parameter). */
const LEGACY_MONEY_UNIT = 1e6;

/** Today's Fishing Crate definition (bait + parts): per-slot rarity table and each rarity pool's part share. */
function legacyCrateTable() {
	const def = LEGACY_BOXES['Fishing Crate'];
	const baits = require('../../../src/bootstrap/data/bait.js').map((b) => ({ ...b, type: 'bait' }));
	const pools = Object.fromEntries(RARITIES.map((r) => [r, [...baits, ...CATALOG].filter((x) => lower(x.rarity) === r && def.pool.types.includes(x.type))]));
	const table = baseTable(def, pools);
	const partShare = Object.fromEntries(RARITIES.filter((r) => pools[r].length).map((r) => [r, pools[r].filter((x) => x.type !== 'bait').length / pools[r].length]));
	return { def, table, partShare };
}

/** One open of TODAY's Fishing Crate, its parts valued with the PROPOSED salvage table (the bait is not valued). */
function legacyCrateOpen() {
	const { def, table, partShare } = legacyCrateTable();
	let parts = 0;
	let rarePlus = 0;
	let salvage = 0;
	for (const [r, share] of Object.entries(partShare)) {
		const p = table[r] * share;
		parts += p;
		if (isRarePlus(r)) rarePlus += p;
		if (PART_POOLS[r].length) salvage += p * salvageValue(r);
	}
	return { slots: def.slots, partsPerOpen: parts * def.slots, rarePlusPartsPerOpen: rarePlus * def.slots, salvagePerOpen: salvage * def.slots };
}

let legacyCrateCache = null;
/**
 * A Fishing Crate bought at today's catalog price and opened after release, under each owned-stock option
 * of P-RODS-FISHING-CRATE: (a) the proposal, owned crates open under the new definition; (b) an additive
 * legacyCount marker set at migration, whose units open first under today's definition; (c) conversion at
 * the price ratio (additively: `exchange` legacy crates per T1 open). Unrounded; cached.
 */
function legacyCrate() {
	if (legacyCrateCache) return legacyCrateCache;
	const row = todayCatalogRow('gacha.js', 'Fishing Crate');
	const paid = row.price;
	const t1 = crateOpenValue(1);
	const legacy = legacyCrateOpen();
	const a1 = assembly(1);
	const priceRatio = paid / t1.price;
	const exchange = Math.ceil(t1.price / paid);
	const crates = Math.floor(LEGACY_MONEY_UNIT / paid);
	const option = (key, label, opensAs, salvage, rarePlus, extra = {}) => ({
		key, label, opensAs, salvagePerCrate: salvage, salvageShareOfPaid: salvage / paid, gainPerCrate: salvage - paid, rarePlusPartsPerCrate: rarePlus,
		perMoneyUnit: { crates, salvage: crates * salvage }, ...extra,
	});
	legacyCrateCache = {
		today: { price: paid, shopItem: Boolean(row.shopItem), level: row.requirements?.level ?? 0 },
		t1: { price: t1.price, unlockLevel: PARAMS.crates.tiers[1].unlockLevel, salvagePerOpen: t1.salvagePerOpen, salvageShareOfPrice: t1.salvagePerOpen / t1.price, rarePlusPartsPerOpen: t1.rarePlusPartsPerOpen },
		legacyDefinition: legacy,
		chosen: PARAMS.legacyCrateStock.option,
		options: [
			option('a', 'owned crates open under the new definition (not chosen)', 'the T1 part crate', t1.salvagePerOpen, t1.rarePlusPartsPerOpen),
			option('b', '**chosen (user)**: an additive `legacyCount` marker (= the stack count at migration), consumed first under today\'s definition; never converted', 'today\'s Fishing Crate (bait + parts)', legacy.salvagePerOpen, legacy.rarePlusPartsPerOpen, { plusBait: true, chosen: true }),
			option('c', 'convert owned crates at the price ratio (not chosen)', 'a fraction of a T1 part crate', priceRatio * t1.salvagePerOpen, priceRatio * t1.rarePlusPartsPerOpen, { priceRatio, exchange, exchangeSalvagePerCrate: t1.salvagePerOpen / exchange }),
		],
		t1Set: { expectedCrates: a1.expectedCrates, atTodayPrice: a1.expectedCrates * paid, atProposedPrice: a1.expectedCost },
		moneyUnit: LEGACY_MONEY_UNIT,
	};
	return legacyCrateCache;
}

/**
 * The release catalog sync (rods.md §13): seed.js inserts missing rows only, so changed fields on EXISTING
 * catalog rows (user: null) need an explicit step guarded by catalogRevision PARAMS.id. Returns the field
 * changes (today's seed row -> after the sync), the rows the seed inserts, and the startup assertions with
 * their outcome on the synced catalog and on today's row (sync skipped).
 */
function catalogSync() {
	const crate = todayCatalogRow('gacha.js', 'Fishing Crate');
	const oldRodRow = todayCatalogRow('rods.js', 'Old Rod');
	const t1 = PARAMS.crates.tiers[1];
	const partTypes = Object.values(SLOTS);
	const L = legacyCrate();
	const maxShare = Math.max(...TIERS.map((t) => crateSalvageRatio(t)));
	return {
		marker: { catalogRevision: PARAMS.id },
		updates: [
			{ row: t1.name, field: 'price', today: crate.price, after: cratePrice(1), source: 'cratePrice(1)', kind: 'usd' },
			{ row: t1.name, field: 'requirements.level', today: crate.requirements?.level ?? null, after: t1.unlockLevel, source: 'the crate\'s unlock level', kind: 'level' },
			{ row: t1.name, field: 'shopItem', today: Boolean(crate.shopItem), after: true, source: 'listed again after C6', kind: 'flag' },
			{ row: t1.name, field: 'capabilities', today: crate.capabilities, after: partTypes, source: 'parts only (display)', kind: 'list' },
			{ row: 'Old Rod', field: 'unbreakable', today: oldRodRow.unbreakable ?? null, after: PARAMS.oldRod.unbreakable, source: 'P-RODS-OLD-ROD', kind: 'flag' },
		],
		inserts: [
			...standardRods().map((r) => ({ row: `${r.name} (type rod)`, price: r.price, level: r.level, shopItem: true })),
			...TIERS.filter((t) => !PARAMS.crates.tiers[t].existing).map((t) => ({ row: PARAMS.crates.tiers[t].name, price: cratePrice(t), level: PARAMS.crates.tiers[t].unlockLevel, shopItem: true })),
		],
		assertions: [
			{ check: `${t1.name} \`price\` = \`cratePrice(1)\` (baked into balance.js)`, kind: 'usd', synced: { value: cratePrice(1), expected: cratePrice(1) }, stale: { value: crate.price, expected: cratePrice(1) } },
			{ check: `${t1.name} \`requirements.level\` = its unlock level`, kind: 'level', synced: { value: t1.unlockLevel, expected: t1.unlockLevel }, stale: { value: crate.requirements?.level ?? null, expected: t1.unlockLevel } },
			{ check: 'Every tier crate: expected salvage per open below the price charged', kind: 'share', synced: { value: maxShare, expected: 1 }, stale: { value: L.options[0].salvageShareOfPaid, expected: 1 } },
			{ check: 'Old Rod `unbreakable`', kind: 'flag', synced: { value: PARAMS.oldRod.unbreakable, expected: true }, stale: { value: oldRodRow.unbreakable ?? null, expected: true } },
		],
	};
}

let legacyDurabilityCache = null;
/** Grandfathered durability (P-RODS-LEGACY-DURABILITY) over every catalog combination, unrounded. */
function legacyDurability() {
	if (legacyDurabilityCache) return legacyDurabilityCache;
	const combos = evaluateAllCombos();
	legacyDurabilityCache = {
		durabilityRatio: spread(combos.map((c) => c.legacy.durability / c.maxDurability)),
		upkeepShareHome: spread(combos.map((c) => c.repairCost / (Math.max(c.legacy.durability, c.maxDurability) * c.valuePerFish))),
		upkeepShareHomeRule: spread(combos.map((c) => c.upkeepShare)),
	};
	return legacyDurabilityCache;
}

/**
 * ASYNC, opt-in (not used by report()): replays `opens` real Gacha V2 decisions (openLine) per tier crate
 * on an in-memory MongoDB (test helpers, like scripts/economy/gacha-ev.js; never production) with the
 * proposed definitions registered in-process only, and compares crates-to-complete with
 * cratesDistribution. Tiers 1-4 (tier 5 has box pity, which needs persisted opens).
 */
async function validateCratesWithEngine(opens = 3000, tiers = [1, 2, 3, 4]) {
	const { startDb, stopDb } = require('../../../test/helpers/db');
	const { quiet, restore } = require('../../../test/helpers/quiet');
	const { bootstrap } = require('../../../src/bootstrap');
	const { BOXES } = require('../../../src/engine/gachaBoxes');
	const { openLine } = require('../../../src/engine/gacha');
	const { ItemData } = require('../../../src/schemas/ItemSchema');
	const { User } = require('../../../src/schemas/UserSchema');
	quiet();
	const out = {};
	try {
		await startDb();
		await bootstrap();
		for (const t of tiers) {
			const def = crateDefinition(t);
			BOXES[def.name] = { ...def };
			const userId = `rods-validate-${t}`;
			const box = await ItemData.collection.insertOne({ name: def.name, type: 'gacha', rarity: 'Common', description: 'validation', count: 1e9, user: userId, __t: 'GachaData', capabilities: [], weights: {} });
			await User.collection.insertOne({ userId, inventory: { gacha: [box.insertedId], fish: [], rods: [], baits: [], items: [], buffs: [], quests: [] }, pity: {}, xp: 0, level: 1 });
			const need = neededSlots(t);
			const byName = new Map(CATALOG.map((x) => [x.name, x]));
			let have = new Set();
			let n = 0;
			const runs = [];
			for (let i = 0; i < opens; i++) {
				const res = await openLine({ userId, boxName: def.name });
				if (res.status !== 'ok') throw new Error(JSON.stringify(res.failure));
				n++;
				for (const slot of res.slots) {
					const part = byName.get(slot.reward.name);
					for (const x of need) if (SLOT_OF_TYPE[part.type] === x.slot && rank(canon(slot.rarity)) >= rank(x.rarity)) have.add(x.slot);
				}
				if (have.size === need.length) {
					runs.push(n);
					n = 0;
					have = new Set();
				}
			}
			const mean = runs.reduce((a, b) => a + b, 0) / runs.length;
			const se = Math.sqrt(runs.reduce((a, b) => a + (b - mean) ** 2, 0) / (runs.length - 1) / runs.length);
			const exact = cratesDistribution(t).expected;
			out[def.name] = { exact: round4(exact), engine: round4(mean), se: round4(se), z: round4((mean - exact) / se), completions: runs.length, opens };
		}
	}
	finally {
		await stopDb().catch(() => undefined);
		restore();
	}
	return out;
}

// ---------------------------------------------------------------------------------------------
// The designed gear paths. gearPath('standard') is the shared path every Phase 5B model uses (framework
// F.gearPath() with GEAR_PATH_LADDER 'standard'; R3). Each step carries its `purchase` (what the rods system
// buys to hold it), so system() is path-agnostic:
//   'standard'  Old Rod + the six standard rods (Lv 10-60), bought in the shop with cash (5b.5 reference)
//   'custom'    Old Rod + the Lv 10 standard rod + the five crafted reference sets (Lv 20-60), assembled from tier
//               crates (the custom variant: the same 7 steps, crafted from Lv 20)
//   'crafted5b4' the 5b.4 reference path (Old Rod + crafted T1-T5); kept for the 5b.4 -> 5b.5 delta table only
const oldRodStep = () => ({ ...oldRod(), label: 'Old Rod', name: 'Old Rod', kind: 'starter', unlockLevel: 0, crateUnlockLevel: 0, homeBiome: 'Ocean', assembly: null, upkeepShareHome: 0, lifeHoursRegular: null, price: 0, purchase: null });
function standardStep(t, tier = t) {
	const rod = standardRod(t);
	return {
		tier,
		label: `${rod.name} (standard, ${rod.role})`,
		name: rod.name, kind: 'standard', role: rod.role,
		level: rod.level, unlockLevel: rod.level, crateUnlockLevel: null, homeBiome: rod.homeBiome,
		qualities: rod.qualities, stats: rod.stats, multiChance: rod.multiChance, meanFish: rod.meanFish, jackpot3plus: rod.jackpot3plus, jackpot5: rod.jackpot5,
		cooldownMs: rod.cooldownMs, maxDurability: rod.maxDurability, lifeHoursRegular: rod.lifeHoursRegular, repairCost: rod.repairCost,
		repairCostPerFish: rod.repairCost / rod.maxDurability, maxRepairs: rod.maxRepairs, upkeepShareHome: upkeepShare(rod, rod.homeBiome),
		price: rod.price, assembly: null,
		purchase: { kind: 'shop', item: rod.name, cost: rod.price, unlockLevel: rod.level },
	};
}
function craftedStep(c, tier = c) {
	const rod = craftRod(referenceSet(c));
	const a = assembly(c);
	return {
		tier,
		label: `Custom T${c} (${setName(referenceSet(c))})`,
		name: `Custom T${c}`, kind: 'custom', customTier: c,
		level: rod.level, unlockLevel: rod.level, crateUnlockLevel: PARAMS.crates.tiers[c].unlockLevel, homeBiome: homeBiome(c),
		qualities: rod.qualities, stats: rod.stats, multiChance: rod.multiChance, meanFish: rod.meanFish, jackpot3plus: rod.jackpot3plus, jackpot5: rod.jackpot5,
		cooldownMs: rod.cooldownMs, maxDurability: rod.maxDurability, lifeHoursRegular: rod.lifeHoursRegular, repairCost: rod.repairCost,
		repairCostPerFish: rod.repairCost / rod.maxDurability, maxRepairs: rod.maxRepairs, upkeepShareHome: upkeepShare(rod, homeBiome(c)),
		price: null,
		assembly: { crate: a.crate, price: a.price, expectedCrates: a.expectedCrates, p90Crates: a.p90Crates, expectedCost: a.expectedCost, hoursOfStageIncome: a.hoursOfStageIncome },
		purchase: { kind: 'assembly', crateTier: c, item: a.crate, cost: a.expectedCost, crates: a.expectedCrates, unlockLevel: PARAMS.crates.tiers[c].unlockLevel, salvage: a.salvageRefund },
	};
}
const LADDERS = ['standard', 'custom', 'crafted5b4'];
const pathCache = new Map();
function gearPath(ladder = 'standard') {
	if (!LADDERS.includes(ladder)) throw new Error(`Unknown ladder ${ladder} (${LADDERS.join(', ')})`);
	if (!pathCache.has(ladder)) {
		let steps;
		if (ladder === 'standard') steps = [oldRodStep(), ...STANDARD_TIERS.map((t) => standardStep(t))];
		else if (ladder === 'custom') steps = [oldRodStep(), standardStep(1), ...TIERS.map((c) => craftedStep(c, c + PARAMS.standard.customOffset))];
		else steps = [oldRodStep(), ...TIERS.map((c) => craftedStep(c))];
		pathCache.set(ladder, steps);
	}
	return pathCache.get(ladder).map((s) => ({ ...s }));
}
/** The custom variant's path (same 7 steps as the standard ladder; crafted from Lv 20). */
const customPath = () => gearPath('custom');

// Approved target windows (shared framework assumption).
const TARGETS = F.TARGET_WINDOWS;
// Lifecycle analysis settings (not design parameters): the optional integrate.run variants whose rod
// timing the report checks, and the stress probe's shares of fishing income spent outside the model.
const LIFECYCLE_VARIANTS = { 'custom rods': { rods: 'custom' }, 'upgrades: none': { upgrades: 'none' }, 'upgrades: greedy': { upgrades: 'greedy' }, 'bait: cash': { bait: 'cash' }, 'bait: xp': { bait: 'xp' }, 'aquarium': { aquarium: true } };
const STRESS_SHARES = [0.5, 0.7, 0.8, 0.9];

/**
 * Engine check RECORD (constant): validateCratesWithEngine(8000) replays real Gacha V2 openLine decisions
 * per crate on an in-memory MongoDB (test helpers; definitions registered in-process only; nothing
 * persisted). The engine RNG is unseeded, so each run differs within sampling error. This is the run made
 * at the final 5B migration (framework 5b.4, 2026-09-26; about 100 s); `exact` is the function's own
 * round4(cratesDistribution(t).expected) at that run, and report() recomputes it so the doc flags the
 * record as stale if a crate definition or the part catalog changes.
 */
const ENGINE_VALIDATION = deepFreeze({
	opens: 8000,
	framework: '5b.4',
	crates: [
		{ tier: 1, exactAtRun: 3.8735, engine: 3.8378, se: 0.0395, z: -0.9032, completions: 2084 },
		{ tier: 2, exactAtRun: 3.7689, engine: 3.7928, se: 0.037, z: 0.6442, completions: 2109 },
		{ tier: 3, exactAtRun: 3.6937, engine: 3.7452, se: 0.0366, z: 1.406, completions: 2135 },
		{ tier: 4, exactAtRun: 3.6561, engine: 3.6756, se: 0.0344, z: 0.5653, completions: 2176 },
	],
});

// ---------------------------------------------------------------------------------------------
// Rods as a SYSTEM on the shared lifecycle core (lifecycle.js; contract in its header and in
// integrate.js): gear purchases (tier assemblies), equipping, repair upkeep and salvage refunds. This
// module never steps time itself; every lifecycle figure below comes from integrate.run (or
// LC.simulate on the same reference systems) at the current framework version.
const SYSTEM_NAME = 'rods';
/** What the integrated model runs by default: salvage on (decision P-RODS-SALVAGE), Founder crate luck on. */
const SYSTEM_DEFAULTS = deepFreeze({ salvage: true, founderCrates: true });

/** Repair cost per durability point of a gear-path step (0 for the unbreakable Old Rod). */
const repairPerPoint = (step) => (step && step.maxDurability && step.repairCost ? step.repairCost / step.maxDurability : 0);

/**
 * Purchase plan on a gear path: per step, what the rods system buys to hold it (step.purchase). A standard
 * rod is one shop purchase (its price, available at its level). A custom step is the assembly of its tier's
 * reference set from tier crates (assembly(c): expected crates and cost; the Founder profile uses
 * founder.founderCrates(c), the same price with the Founder's crate luck), available from the crate's unlock
 * level, with, when `salvage` is on, the refund for salvaging every leftover part.
 */
function assemblyPlan(path, { profile = 'normal', salvage = SYSTEM_DEFAULTS.salvage } = {}) {
	const plan = [null];
	for (let i = 1; i < path.length; i++) {
		const step = path[i];
		const p = step.purchase;
		if (!p) throw new Error(`gear path step ${i} (${step.label || step.key}) has no purchase: rods.system() needs a rods gear path`);
		if (p.kind === 'shop') {
			plan.push({ tier: i, kind: 'shop', item: p.item, crate: null, price: p.cost, crates: 0, cost: p.cost, unlockLevel: p.unlockLevel, level: step.level, salvage: 0 });
			continue;
		}
		const c = p.crateTier;
		const a = assembly(c);
		let crates = p.crates;
		let cost = p.cost;
		let refund = p.salvage ?? a.salvageRefund;
		if (profile === 'founder') {
			const fc = require('./founder').founderCrates(c).founder;
			refund = Math.max(0, a.salvageRefund + a.salvageReturnPerCrate * a.price * (fc.expected - a.expectedCrates));
			crates = fc.expected;
			cost = fc.expectedCost;
		}
		plan.push({ tier: i, kind: 'assembly', customTier: c, item: p.item, crate: p.item, price: a.price, crates, cost, unlockLevel: p.unlockLevel, level: step.level, salvage: salvage ? refund : 0 });
	}
	return plan;
}

/**
 * The rods SYSTEM (lifecycle.js hooks). Per-run state lives in state.sys.rods only. Path-agnostic: it buys
 * each step's `purchase` of ctx.path (the standard ladder in the reference loop; the custom path in the
 * custom variant, integrate.run variant.rods 'custom').
 *   goals     the next step's purchase: category 'progression', priority LC.PRIORITY.rod, cost = the shop
 *             price or the expected assembly cost, available from its unlock level (gate level); ledger item =
 *             the rod's name or the crate's name. buy() records ownership, pays any salvage refund (cash
 *             source 'salvage') and equips at once if the gate level already reaches the step.
 *   on        'levelUp': equips the owned step once the gate level reaches its level (it fishes from the
 *             next step). Emits 'assembly' { tier, kind, item, crates, cost, level } on each purchase (rods and
 *             tier crates carry no buffs, so no 'box' event).
 *   onCasts   repairs: spend('upkeep', 'repairs', durability used this step x the equipped step's repair
 *             cost per durability point); the Old Rod is unbreakable (0).
 * @param {object} opts { salvage: salvage every leftover part on assembly (default SYSTEM_DEFAULTS),
 *   founderCrates: price the Founder's assemblies with its crate luck (default SYSTEM_DEFAULTS) }
 */
function system(opts = {}) {
	const { salvage = SYSTEM_DEFAULTS.salvage, founderCrates = SYSTEM_DEFAULTS.founderCrates } = opts;
	const own = (state) => state.sys[SYSTEM_NAME];
	function plan(state, ctx) {
		const s = own(state);
		const profile = founderCrates && state.profile === 'founder' ? 'founder' : 'normal';
		if (!s.plan || s.planProfile !== profile) {
			s.plan = assemblyPlan(ctx.path, { profile, salvage });
			s.planProfile = profile;
		}
		return s.plan;
	}
	function equip(state, ctx) {
		const s = own(state);
		while (state.equippedTier < s.owned && ctx.gateLevel() >= ctx.path[state.equippedTier + 1].level) {
			state.equippedTier++;
			const L = state.ledger;
			s.equips[state.equippedTier] = {
				hours: +state.h.toFixed(4), day: state.day + 1, level: ctx.gateLevel(),
				fishingCash: L.cash.fishing || 0, repairs: L.spend.upkeep.repairs || 0, assemblies: s.spent, salvage: L.cash.salvage || 0,
			};
		}
	}
	return {
		name: SYSTEM_NAME,
		init(state) {
			state.sys[SYSTEM_NAME] = { owned: state.equippedTier, plan: null, planProfile: null, bought: {}, equips: {}, spent: 0 };
		},
		/** The next purchase (for other systems' reserves, e.g. upgrades.js): { tier, item, cost, unlockLevel } or null. */
		nextPurchase(state, ctx) {
			return plan(state, ctx)[own(state).owned + 1] || null;
		},
		goals(state, ctx) {
			const s = own(state);
			const next = plan(state, ctx)[s.owned + 1];
			if (!next) return [];
			return [{
				id: `rods:T${next.tier}`, item: next.item, category: 'progression', priority: LC.PRIORITY.rod, cost: next.cost,
				available: ctx.gateLevel() >= next.unlockLevel,
				buy(st, c) {
					s.owned = next.tier;
					s.spent += next.cost;
					s.bought[next.tier] = { hours: +st.h.toFixed(4), day: st.day + 1, level: c.gateLevel(), kind: next.kind, item: next.item, crates: next.crates, cost: next.cost, salvage: next.salvage };
					if (next.salvage > 0) c.addCash('salvage', next.salvage);
					c.emit('assembly', { tier: next.tier, kind: next.kind, item: next.item, crate: next.crate, crates: next.crates, cost: next.cost, level: c.gateLevel() });
					equip(st, c);
				},
			}];
		},
		onCasts(state, ctx, { rates }) {
			const perPoint = repairPerPoint(ctx.path[rates.tier]);
			if (perPoint > 0 && rates.durability > 0) ctx.spend('upkeep', 'repairs', rates.durability * perPoint);
		},
		on(event, payload, state, ctx) {
			if (event === 'levelUp') equip(state, ctx);
		},
	};
}

/**
 * Parity RECORD (a constant: the loop it compared against is deleted). Before the final Phase 5B
 * migration this module had its own private lifecycle loop (the old rods.lifecycle(), placeholder daily
 * XP). validateSystem() compared system() on the shared core with it; these are that function's results
 * at commit a83b5f0 (framework 5b.4, digest d9e4938f85074918). The old loop and validateSystem() were
 * retired afterwards: every lifecycle number now comes from the integrated model.
 */
const SYSTEM_PARITY = deepFreeze({
	commit: 'a83b5f0',
	framework: '5b.4',
	method: 'LC.simulate with rods.system({ salvage: false }) + LC.provisionalDaily() vs the retired rods.lifecycle() (same placeholder XP model), every archetype plus regular with 30% and casual with 50% of fish income spent elsewhere; hours compared step-exact',
	cases: 6,
	tolerance: 0.005,
	maxRelativeDifference: 0.0033,
	worst: 'grinder T1 equip hours',
	exactMilestones: '24/36',
	maxEquipShiftSteps: 2,
	replay: { equipTiming: 'afterCasts', exactMilestones: '36/36', maxRelativeDifference: 0, exact: true },
	cause: 'equip timing only: the old loop equipped a tier in the purchase block of the step after its level was reached; the system equips on the levelUp event (the rod is owned and the level reached), so level-gated tiers start one step earlier. Replaying the old timing on the core was exact.',
});

/** Stress probe (not a game system): spends `share` of each step's fishing income on purchases outside the model. */
function otherSpendProbe(share) {
	return {
		name: 'otherSpendProbe',
		onCasts(state, ctx, { rates }) {
			if (share > 0) ctx.spend('optional', 'other (stress probe)', share * rates.cash);
		},
	};
}

const sumValues = (o) => Object.values(o || {}).reduce((a, b) => a + b, 0);
// A purchase made at the first purchase pass after a level-up lands one core step (1 minute) after the
// milestone: that is not a wait for cash (world.js labels permits the same way). An analysis setting.
const PASS_LAG_H = 0.02;
const lifecycleCache = new Map();
/**
 * The rods view of ONE integrated lifecycle at the current framework version. Default: integrate.run with
 * the reference loop (standard rods + world + quests + streak + buffs + upgrades under F.UPGRADE_POLICY) and
 * `variant` (rods 'custom' | upgrades policy | bait / aquarium / founder, see integrate.js). With
 * `otherSpendShare` > 0: LC.simulate on the same reference systems plus a stress probe spending that share of
 * each step's fishing income elsewhere. `ladder` 'crafted5b4' runs the 5b.4 reference path (crafted T1-T5,
 * no upgrades) on today's model, for the 5b.4 -> 5b.5 delta. Money figures are read at the Lv 60 milestone
 * snapshot (the Lv 60 rod is bought right after it). Cached. Returns {
 *   reached   { L: { hours, day, fishingXpShare } }            each milestone level
 *   equips    { i: { name, level, hours, day, delayHours } }   hour step i starts fishing; delay after its level
 *   bought    { i: { hours, level, day, kind, item, crates, cost, salvage } }
 *   stages    { i: { from, to, hours, income, fishing } }     income earned in the 10 levels before step i
 *   totals    { income, gross (fishing), repairs, rods (shop + assemblies), upgrades, salvage, shares, saved... }
 *   path, hours, days, systems }
 */
function lifecycle(arch, { variant = null, otherSpendShare = 0, ladder = null } = {}) {
	const key = JSON.stringify([arch, variant, otherSpendShare, ladder]);
	if (lifecycleCache.has(key)) return lifecycleCache.get(key);
	const I = require('./integrate');
	let r;
	let path;
	if (ladder === 'crafted5b4') {
		path = gearPath('crafted5b4');
		r = I.run({ archetype: arch, variant: { ...(variant || {}), upgrades: 'none' }, gearPath: path });
	}
	else if (otherSpendShare > 0) {
		path = F.gearPath();
		r = { ...LC.simulate({ archetype: arch, systems: [...I.referenceSystems(), otherSpendProbe(otherSpendShare)] }), systems: [...I.REFERENCE, 'otherSpendProbe'] };
	}
	else {
		path = variant && variant.rods === 'custom' ? customPath() : F.gearPath();
		r = I.run({ archetype: arch, variant: variant || {} });
	}
	const ms = r.gate === 'public' ? r.publicMilestones : r.milestones;
	const s = r.sys[SYSTEM_NAME];
	const reached = {};
	for (const [L, m] of Object.entries(ms)) {
		if (!/^\d+$/.test(L) || !m.ledger) continue;
		reached[L] = { hours: m.hours, day: m.day, fishingXpShare: round4((m.ledger.xp.fishing || 0) / sumValues(m.ledger.xp)) };
	}
	const equips = {};
	for (const [i, e] of Object.entries(s.equips)) {
		const step = path[Number(i)];
		const atLevel = reached[step.level];
		// Bought at the first purchase pass after the level-up (one model step): no wait for cash.
		const d = atLevel ? Math.max(0, e.hours - atLevel.hours) : null;
		equips[i] = { name: step.name, level: e.level, hours: e.hours, day: e.day, delayHours: d === null ? null : d <= PASS_LAG_H ? 0 : round4(d) };
	}
	const stages = {};
	for (let i = 1; i < path.length; i++) {
		const [from, to] = [ms[path[i].level - 10], ms[path[i].level]];
		if (!from?.ledger || !to?.ledger) continue;
		stages[i] = {
			name: path[i].name, from: path[i].level - 10, to: path[i].level, hours: to.hours - from.hours,
			income: sumValues(to.ledger.cash) - sumValues(from.ledger.cash),
			fishing: (to.ledger.cash.fishing || 0) - (from.ledger.cash.fishing || 0),
		};
	}
	// Money to the Lv 60 milestone (the last recorded one if the run stops earlier), counting the Lv 60 rod as
	// bought on arrival: whether the run's stop comes before that purchase pass depends on the day's timing
	// (daily XP credited at day end), so every run is read the same way.
	const top = ms[F.LIFECYCLE.maxLevel] || ms[Math.max(...Object.keys(ms).filter((k) => /^\d+$/.test(k)).map(Number))];
	const led = top.ledger;
	const atTop = top === ms[F.LIFECYCLE.maxLevel];
	const boughtByTop = (x) => (led.spend.progression || {})[x.purchase.item] > 0;
	const pendingTop = atTop ? path.slice(1).filter((x) => x.level === F.LIFECYCLE.maxLevel && x.purchase?.kind === 'shop' && !boughtByTop(x)).reduce((acc, x) => acc + x.purchase.cost, 0) : 0;
	const income = sumValues(led.cash);
	const fishing = led.cash.fishing || 0;
	const repairs = led.spend.upkeep.repairs || 0;
	const rodSpend = Object.entries(led.spend.progression || {}).filter(([k]) => !k.startsWith('permit:')).reduce((a, [, v]) => a + v, 0) + pendingTop;
	const upgradeSpend = Object.entries(led.spend.optional || {}).filter(([k]) => k.startsWith('upgrade:')).reduce((a, [, v]) => a + v, 0);
	const permitSpend = Object.entries(led.spend.progression || {}).filter(([k]) => k.startsWith('permit:')).reduce((a, [, v]) => a + v, 0);
	const cat = Object.fromEntries(Object.entries(led.spend).map(([c, items]) => [c, sumValues(items)]));
	cat.progression = (cat.progression || 0) + pendingTop;
	const out = {
		archetype: typeof arch === 'string' ? arch : arch.name, variant, otherSpendShare, ladder, systems: r.systems,
		path: path.map((x) => ({ tier: x.tier, name: x.name, kind: x.kind, level: x.level })),
		reached, equips, bought: { ...s.bought }, stages,
		totals: {
			income, gross: fishing, repairs, rods: rodSpend, upgrades: upgradeSpend, permits: permitSpend, salvage: led.cash.salvage || 0,
			repairShare: repairs / fishing, repairShareOfIncome: repairs / income, rodShareOfIncome: rodSpend / income, upgradeShareOfIncome: upgradeSpend / income,
			categoryShares: Object.fromEntries(Object.entries(cat).map(([c, v]) => [c, v / income])),
			saved: top.money - pendingTop, savedShare: (top.money - pendingTop) / income, lv60RodOnArrival: pendingTop,
			minMoney: r.final.minMoney, finalMoney: r.final.money,
		},
		hours: r.hours, days: r.days,
		// Raw pieces other views read (upgrades.js): the world's permit summary and the upgrades system's log.
		permits: require('./world').permitSummary(r),
		upgradesBought: r.sys.upgrades ? r.sys.upgrades.bought.filter((b) => b.hours <= top.hours) : [],
		upgradeLevels: r.sys.upgrades ? { ...r.sys.upgrades.levels } : null,
	};
	lifecycleCache.set(key, out);
	return out;
}

/** Hours to each approved window level against its window (regular player by default). */
const inTarget = (reached) => Object.fromEntries(Object.entries(TARGETS).map(([L, [lo, hi]]) => [L, { hours: reached[L]?.hours ?? null, window: [lo, hi], ok: reached[L] ? reached[L].hours >= lo && reached[L].hours <= hi : false }]));

// ---------------------------------------------------------------------------------------------
const r0 = (x) => Math.round(x);
const quant = (arr, q) => {
	const s = [...arr].sort((a, b) => a - b);
	return s[Math.min(s.length - 1, Math.floor(q * (s.length - 1) + 0.5))];
};
const spread = (arr) => ({ min: Math.min(...arr), median: quant(arr, 0.5), max: Math.max(...arr) });
const maxRarity = (rarities) => RARITY_ORDER[Math.max(...Object.values(rarities).map(rank))];

/**
 * The 5b.4 published record (constant; docs/economy/PHASE5B_REPORT.md at framework 5b.4, digest
 * d9e4938f85074918, before the standard ladder): the delta table quotes it next to today's numbers.
 */
const RECORD_5B4 = deepFreeze({
	framework: '5b.4', digest: 'd9e4938f85074918',
	regularHours: { 10: 1.18, 20: 5.27, 30: 12.58, 40: 25.13, 50: 43.65, 60: 69.77 },
	fishPerCast: { 0: 1, 10: 1, 20: 1.2, 30: 1.3, 40: 1.5, 50: 1.65, 60: 1.8 },
	firstRodLevel: 20,
	savedShare: [0.699, 0.749],
	progressionShare: [0.235, 0.265],
	upkeepShare: [0.016, 0.036],
	rodCosts: { 20: 18980, 30: 79147, 40: 195766, 50: 511855, 60: 1159742 },
});

function buildReport() {
	const combos = evaluateAllCombos();
	const path = gearPath();
	const crafted = gearPath('crafted5b4');
	const custom = customPath();

	// Slot families at each rarity (balanced variants), as a table.
	const slotTable = RARITY_ORDER.map((r) => {
		const set = matchedSet(r);
		const prof = Object.fromEntries(Object.entries(set).map(([k, p]) => [k, partProfile(p)]));
		return {
			rarity: r, level: PARAMS.partLevel[r], tier: PARAMS.tierOfRarity[r],
			rod: { meanFish: PARAMS.slots.rod.meanFish[r], baseDurability: r0(baseDurability(r)), repairCost: repairCostFor(r), multiChance: F.chanceForMean(PARAMS.slots.rod.meanFish[r]) },
			reel: { fishingSpeed: PARAMS.slots.reel.fishingSpeed[r], trophyChance: PARAMS.slots.reel.trophyChance[r] },
			hook: { rareFind: PARAMS.slots.hook.rareFind[r], luck: PARAMS.slots.hook.luck[r] },
			handle: { durabilityMult: PARAMS.slots.handle.durabilityMult[r], sellBonus: PARAMS.slots.handle.sellBonus[r] },
			matchedSetUses: Object.fromEntries(Object.entries(prof).map(([k, p]) => [k, p.rarity])),
		};
	});

	// Per-step rates for every modelled biome: the standard ladder (reference), then the custom reference sets.
	const rates = [...path, ...crafted.slice(1)].map((s) => ({
		tier: s.tier, label: s.label, name: s.name, kind: s.kind, homeBiome: s.homeBiome,
		byBiome: Object.fromEntries(MODELLED_BIOMES.map((b) => {
			const o = rodOutcome(s, b);
			const hr = F.hourly(o, F.DESIGN_OVERHEAD_S);
			return [b, { fishPerCast: o.fishPerCast, valuePerFish: o.valuePerFish, xpPerHour: hr.xp, cashPerHour: hr.cash, upkeepShare: upkeepShare(s, b) }];
		})),
	}));

	// All combos.
	const hist = {};
	for (const c of combos) hist[c.meanFish.toFixed(2)] = (hist[c.meanFish.toFixed(2)] || 0) + 1;
	const legacyHist = {};
	for (const c of combos) legacyHist[c.legacy.fishPerCast] = (legacyHist[c.legacy.fishPerCast] || 0) + 1;
	const ceiling = combos.filter((c) => c.meanFish >= PARAMS.multi.ceilingMean - 1e-9).length;
	const perTier = {};
	for (const t of TIERS) {
		const rows = combos.filter((c) => c.tier === t);
		const ref = crafted[t];
		const refH = rodHourly(ref, homeBiome(t));
		perTier[t] = {
			combos: rows.length,
			level: tierLevel(t),
			homeBiome: homeBiome(t),
			meanFish: spread(rows.map((c) => c.meanFish)),
			jackpot3plus: spread(rows.map((c) => c.jackpot3plus)),
			rareFind: spread(rows.map((c) => c.stats.rareFind)),
			luck: spread(rows.map((c) => c.stats.luck)),
			trophyChance: spread(rows.map((c) => c.stats.trophyChance)),
			fishingSpeed: spread(rows.map((c) => c.stats.fishingSpeed)),
			sellBonus: spread(rows.map((c) => c.stats.sellBonus)),
			lifeHoursRegular: spread(rows.map((c) => c.lifeHoursRegular)),
			xpPerHour: spread(rows.map((c) => r0(c.xpPerHour))),
			cashPerHour: spread(rows.map((c) => r0(c.cashPerHour))),
			cashVsReference: spread(rows.map((c) => c.cashPerHour / refH.cash)),
			xpVsReference: spread(rows.map((c) => c.xpPerHour / refH.xp)),
			upkeepShareHome: spread(rows.map((c) => c.upkeepShare)),
			legacyLevel: spread(rows.map((c) => c.legacy.level)),
			legacyFishPerCast: spread(rows.map((c) => c.legacy.fishPerCast)),
		};
	}
	// Level bypass check: best rod usable at each level, today vs proposed (fish per cast).
	const bestAtLevel = Object.fromEntries([20, 30, 40, 50, 60].map((L) => [L, {
		todayFishPerCast: Math.max(...combos.filter((c) => c.legacy.level <= L).map((c) => c.legacy.fishPerCast)),
		proposedMeanFish: Math.max(...combos.filter((c) => c.level <= L).map((c) => c.meanFish)),
		proposedBestCashPerHour: r0(Math.max(...combos.filter((c) => c.level <= L).map((c) => rodHourly(craftRod(c.names.map((n) => CATALOG.find((p) => p.name === n))), biomeForLevel(L)).cash))),
	}]));

	// Specialties: variants of the same slot at the same rarity, in the home biome (reference set otherwise).
	const specialty = (rod, t) => {
		const o = rodOutcome(rod, homeBiome(t));
		const hr = F.hourly(o, F.DESIGN_OVERHEAD_S);
		return { xp: hr.xp, cash: hr.cash, net: hr.cash * (1 - upkeepShare(rod, homeBiome(t))), giant: o.rarity.giant * o.fishPerCast, legendaryPlus: (o.rarity.legendary + o.rarity.lucky) * o.fishPerCast, jackpot: rod.jackpot3plus };
	};
	const specialties = [];
	for (const name of Object.keys(PARAMS.variants)) {
		const part = CATALOG.find((p) => p.name === name);
		const slot = SLOT_OF_TYPE[part.type];
		const t = PARAMS.tierOfRarity[canon(part.rarity)];
		const rod = craftRod({ ...matchedSet(canon(part.rarity)), [slot]: part });
		const base = craftRod(matchedSet(canon(part.rarity)));
		const v = specialty(rod, t);
		const b = specialty(base, t);
		specialties.push({
			part: name, rarity: part.rarity, slot, variant: PARAMS.variants[name].label, biome: homeBiome(t),
			xpVsBalanced: v.xp / b.xp, cashVsBalanced: v.cash / b.cash, netCashVsBalanced: v.net / b.net,
			giantsVsBalanced: v.giant / b.giant, legendaryPlusVsBalanced: v.legendaryPlus / b.legendaryPlus,
			jackpot3plus: v.jackpot, lifeVsBalanced: rod.maxDurability / base.maxDurability,
		});
	}
	// Marginal value of each stat on the tier-3 reference in its home biome (why the variant multipliers differ).
	const statValue = (() => {
		const ref = craftRod(referenceSet(3));
		const b = homeBiome(3);
		const base = rodHourly(ref, b);
		const bump = (mod) => {
			const stats = { ...ref.stats, ...mod(ref.stats) };
			const h = rodHourly({ ...ref, stats, cooldownMs: Math.max(F.COOLDOWN.minMs, Math.round(F.COOLDOWN.fishMs * (1 - stats.fishingSpeed))) }, b);
			return { xp: h.xp / base.xp - 1, cash: h.cash / base.cash - 1 };
		};
		return {
			biome: b,
			'fishingSpeed +0.02': bump((x) => ({ fishingSpeed: x.fishingSpeed + 0.02 })),
			'rareFind +0.2': bump((x) => ({ rareFind: x.rareFind + 0.2 })),
			'trophyChance +0.2': bump((x) => ({ trophyChance: x.trophyChance + 0.2 })),
			'luck +0.2': bump((x) => ({ luck: x.luck + 0.2 })),
			'sellBonus +0.02': bump((x) => ({ sellBonus: x.sellBonus + 0.02 })),
		};
	})();

	// Legacy converter calibration.
	const idx = legacyIndexMap();
	const sigGroups = new Map();
	for (const c of combos) sigGroups.set(c.legacy.signature, [...(sigGroups.get(c.legacy.signature) || []), c]);
	let exactTier = 0;
	let underTier = 0;
	let overTier = 0;
	let overPower = 0;
	for (const c of combos) {
		const pick = idx.get(c.legacy.signature);
		if (pick.tier === c.tier) exactTier++;
		else if (pick.tier < c.tier) underTier++;
		else overTier++;
		if (pick.oceanCashPerHour > c.oceanCashPerHour + 1e-9) overPower++;
	}
	const legacySamples = (() => {
		// Today's "Custom (Rare parts)" representative rod as stored by generateStats.
		const names = ['Graphite Rod Piece', 'Jigging Reel', 'Treble Hook', 'EVA Handle'];
		const parts = Object.fromEntries(names.map((n) => CATALOG.find((p) => p.name === n)).map((p) => [SLOT_OF_TYPE[p.type], p]));
		const legacy = legacyCraft(parts);
		const stored = { capabilities: legacy.capabilities, durability: 4200, maxDurability: legacy.durability, repairCost: legacy.repairCost, requirements: { level: legacy.level }, state: 'destroyed' };
		const view = (c) => ({ method: c.method, tier: c.rod.tier, level: c.rod.level, meanFish: c.rod.meanFish, stats: c.rod.stats, cooldownMs: c.rod.cooldownMs, durability: c.durability, state: c.state, repairCost: c.repairCost, repairs: 'unlimited' });
		const lowLevel = craftRod(referenceSet(4), { playerLevel: 35 });
		return {
			stored: { parts: names, capabilities: legacy.capabilities, legacyLevel: legacy.level, legacyFishPerCast: legacy.fishPerCast, legacyRepairCost: legacy.repairCost, durability: `4200/${legacy.durability}`, state: 'destroyed' },
			pathA: view(convertLegacyRod(stored, parts)),
			pathB: view(convertLegacyRod(stored, null)),
			pathC: view(convertLegacyRod({ capabilities: ['weak', '99', '9 count', '123 durability'], durability: 50, maxDurability: 123, state: 'broken' }, null)),
			levelCap: { rod: 'Tier 4 Legendary set', playerLevel: 35, performsAs: Object.fromEntries(Object.entries(lowLevel.parts).map(([k, x]) => [k, x.effectiveRarity])), meanFish: lowLevel.meanFish, stats: lowLevel.stats, requirementShown: lowLevel.level },
		};
	})();

	// Crates.
	const crates = crateDefinitions().map((d) => ({ ...d, slotOdds: crateSlotOdds(d.tier) }));
	const assemblies = TIERS.map(assembly);
	const entryT1 = (() => {
		// Budget T1: a Common-or-better part in every slot from Fishing Crates (a matched Common set).
		const d = cratesDistribution(1, { need: Object.keys(SLOTS).map((x) => ({ slot: x, rarity: 'Common' })) });
		const rod = craftRod(matchedSet('Common'));
		return { expectedCrates: d.expected, p90Crates: d.p90, expectedCost: d.expected * cratePrice(1), hoursOfStageIncome: (d.expected * cratePrice(1)) / stageIncome(1), meanFish: rod.meanFish, cashPerHourLake: rodHourly(rod, 'Lake').cash };
	})();
	const salvage = Object.fromEntries(RARITY_ORDER.map((r) => [r, salvageValue(r)]));

	// Today's crate, Old Rod and crafted-rod rules (for Current -> Proposed), read from the catalog and engine.
	const today = (() => {
		const oldRodLegacy = todayCatalogRow('rods.js', 'Old Rod');
		const crateItem = todayCatalogRow('gacha.js', 'Fishing Crate');
		const { def, table, partShare: shareOf } = legacyCrateTable();
		let partShare = 0;
		let rarePlusPart = 0;
		for (const [r, share] of Object.entries(shareOf)) {
			partShare += table[r] * share;
			if (isRarePlus(r)) rarePlusPart += table[r] * share;
		}
		return {
			oldRod: { maxDurability: oldRodLegacy.maxDurability, repairCost: oldRodLegacy.repairCost, maxRepairs: oldRodLegacy.maxRepairs },
			fishingCrate: { price: crateItem.price, slots: def.slots, partShare, rarePlusPartPerSlot: rarePlusPart, duplicates: def.duplicates },
			quickFishingSpeed: QUICK_FISHING_SPEED,
			crafted: {
				level: spread(combos.map((c) => c.legacy.level)), fishPerCast: spread(combos.map((c) => c.legacy.fishPerCast)),
				durability: spread(combos.map((c) => c.legacy.durability)), repairCost: spread(combos.map((c) => c.legacy.repairCost)), maxRepairs: LEGACY_CRAFTED_MAX_REPAIRS,
			},
		};
	})();

	// Integrated lifecycle (current framework): every archetype on the reference loop (standard rods +
	// upgrades), the optional variants (custom rods, upgrade policies, bait, aquarium), the other-spend stress
	// probe, and the 5b.4 ladder on today's model (the delta table).
	const PLAYERS = Object.keys(ARCHETYPES);
	const life = Object.fromEntries(PLAYERS.map((k) => [k, lifecycle(k)]));
	const steps = path.slice(1).map((x) => x.tier);
	// The Lv 60 rod is bought right after the run's Lv 60 stop in some runs (left out when not reached).
	const maxDelay = (v) => {
		const d = v.path.slice(1).filter((x) => v.equips[x.tier] || x.level < F.LIFECYCLE.maxLevel).map((x) => v.equips[x.tier]?.delayHours ?? null);
		return d.includes(null) ? null : Math.max(...d);
	};
	const variantMaxDelay = Object.fromEntries(PLAYERS.map((k) => [k, Object.fromEntries(Object.entries(LIFECYCLE_VARIANTS).map(([name, variant]) => [name, maxDelay(lifecycle(k, { variant }))]))]));
	const stressDelays = Object.fromEntries(PLAYERS.map((k) => [k, Object.fromEntries(STRESS_SHARES.map((sh) => {
		const v = lifecycle(k, { otherSpendShare: sh });
		return [sh, Object.fromEntries(steps.map((t) => [t, v.equips[t]?.delayHours ?? null]))];
	}))]));
	const lifeRow = (v) => ({
		reached: v.reached, equips: v.equips,
		bought: Object.fromEntries(Object.entries(v.bought).map(([t, b]) => [t, { hours: b.hours, level: b.level, day: b.day, kind: b.kind, item: b.item, crates: +b.crates.toFixed(2), cost: r0(b.cost), salvage: r0(b.salvage) }])),
		totals: { ...v.totals },
		maxTierDelayHours: maxDelay(v), hours: v.hours, days: v.days,
	});
	// Each standard rod's price against the income the regular player earns in the stage before it.
	const stageShare = path.slice(1).map((step) => {
		const st = life.regular.stages[step.tier];
		return st ? { tier: step.tier, name: step.name, stage: `Lv ${st.from}-${st.to}`, hours: st.hours, income: st.income, fishing: st.fishing, cost: step.price, shareOfIncome: step.price / st.income, shareOfFishing: step.price / st.fishing } : { tier: step.tier, name: step.name, stage: null };
	});
	// Time to afford each standard rod from the archetype's own stage income (previous rod, stage biome, net of repairs).
	const standard = standardRods().map((rod) => {
		const prev = rod.tier === 1 ? oldRod() : standardRod(rod.tier - 1);
		const home = rodHourly(rod, rod.homeBiome);
		return {
			tier: rod.tier, name: rod.name, role: rod.role, level: rod.level, previewLevel: rod.previewLevel, qualities: rod.qualities, stats: rod.stats,
			meanFish: rod.meanFish, jackpot3plus: rod.jackpot3plus, jackpot5: rod.jackpot5, cooldownMs: rod.cooldownMs,
			maxDurability: rod.maxDurability, lifeHoursRegular: rod.lifeHoursRegular, repairCost: rod.repairCost, upkeepShareHome: upkeepShare(rod, rod.homeBiome),
			price: rod.price, priceHours: rod.priceHours, stageBiome: rod.stageBiome, stageIncomePerHour: rod.stageIncomePerHour, homeBiome: rod.homeBiome,
			homeCashPerHour: home.cash, homeXpPerHour: home.xp, homeCashVsPrevious: home.cash / rodHourly(prev, rod.homeBiome).cash,
			timeToAfford: Object.fromEntries(PLAYERS.map((k) => {
				const h = F.hourly(rodOutcome(prev, rod.stageBiome), ARCHETYPES[k].overheadS);
				const net = h.cash - repairPerPoint(prev.maxDurability ? { maxDurability: prev.maxDurability, repairCost: prev.repairCost } : null) * h.durability;
				const hours = rod.price / net;
				return [k, { hours, sessions: hours / (ARCHETYPES[k].minutesPerDay / 60) }];
			})),
		};
	});
	// Custom vs standard at the same level (custom tier c competes with standard tier c + customOffset).
	const customRelation = TIERS.map((c) => {
		const cs = custom[c + PARAMS.standard.customOffset];
		const st = path[c + PARAMS.standard.customOffset];
		const biome = cs.homeBiome;
		const hc = rodHourly(cs, biome);
		const hs = rodHourly(st, biome);
		const a = assembly(c);
		const net = (x, h) => h.cash * (1 - upkeepShare(x, biome));
		return {
			customTier: c, level: cs.level, biome, standard: st.name, custom: cs.label,
			meanFish: { standard: st.meanFish, custom: cs.meanFish }, stats: { standard: st.stats, custom: cs.stats },
			cashPerHour: { standard: hs.cash, custom: hc.cash }, xpPerHour: { standard: hs.xp, custom: hc.xp }, netCashPerHour: { standard: net(st, hs), custom: net(cs, hc) },
			cost: { standard: st.price, customExpected: a.expectedCost, customP90: a.p90Cost, customNetOfSalvage: a.netCostAfterSalvage, crates: a.expectedCrates, crate: a.crate },
			life: { standard: st.lifeHoursRegular, custom: cs.lifeHoursRegular }, repair: { standard: st.repairCost, custom: cs.repairCost },
			// Hours of the custom set's extra net $/h to earn back its extra net cost.
			paybackHours: (a.netCostAfterSalvage - st.price) / (net(cs, hc) - net(st, hs)),
		};
	});
	// Custom builds per tier from the real catalog (every combination of that tier): the best at each goal.
	const BUILDS = {
		'Rare Hunter': (c) => c.stats.rareFind + c.stats.luck,
		'Trophy Hunter': (c) => c.stats.trophyChance,
		'Speed': (c) => c.stats.fishingSpeed,
		'Workhorse (durability)': (c) => c.lifeHoursRegular,
		'Volume': (c) => c.meanFish,
		'Best $/h': (c) => c.cashPerHour,
	};
	const customBuilds = TIERS.map((c) => {
		const rows = combos.filter((x) => x.tier === c);
		const st = path[c + PARAMS.standard.customOffset];
		const stH = rodHourly(st, homeBiome(c));
		const pick = (f) => rows.reduce((best, x) => (f(x) > f(best) + 1e-12 || (Math.abs(f(x) - f(best)) <= 1e-12 && x.cashPerHour > best.cashPerHour) ? x : best), rows[0]);
		return {
			customTier: c, level: tierLevel(c), biome: homeBiome(c), standard: st.name, standardMeanFish: st.meanFish, standardStats: st.stats, standardLife: st.lifeHoursRegular,
			builds: Object.fromEntries(Object.entries(BUILDS).map(([name, f]) => {
				const x = pick(f);
				return [name, { parts: x.names, meanFish: x.meanFish, stats: x.stats, lifeHoursRegular: x.lifeHoursRegular, cashVsStandard: x.cashPerHour / stH.cash, xpVsStandard: x.xpPerHour / stH.xp, level: x.level }];
			})),
		};
	});
	// Custom level rule: today's inherited requirement vs the proposed rule, by the parts' highest rarity.
	const levelRule = RARITY_ORDER.filter((r) => combos.some((c) => rank(maxRarity(c.rarities)) === rank(r))).map((r) => {
		const rows = combos.filter((c) => maxRarity(c.rarities) === r);
		const pure = rows.filter((c) => Object.values(c.rarities).every((x) => x === r));
		return { rarity: r, combos: rows.length, proposed: PARAMS.partLevel[r], todayLevel: spread(rows.map((c) => c.legacy.level)), matchedTodayLevel: pure.length ? spread(pure.map((c) => c.legacy.level)) : null };
	});
	// 5b.4 -> 5b.5 delta: the 5b.4 ladder (crafted T1-T5, no upgrades) on today's model, every archetype.
	const life4 = Object.fromEntries(PLAYERS.map((k) => [k, lifecycle(k, { ladder: 'crafted5b4' })]));
	const lifeNone = Object.fromEntries(PLAYERS.map((k) => [k, lifecycle(k, { variant: { upgrades: 'none' } })]));
	const lifeCustom = Object.fromEntries(PLAYERS.map((k) => [k, lifecycle(k, { variant: { rods: 'custom' } })]));
	const I = require('./integrate');
	return {
		...F.stamp(),
		params: PARAMS.id,
		curve: { ...F.CURVE },
		today,
		slotFamilies: Object.fromEntries(Object.entries(PARAMS.slots).map(([k, v]) => [k, v.family])),
		slotTable,
		gearPath: path.map((s) => ({
			tier: s.tier, label: s.label, name: s.name, kind: s.kind, price: s.price, unlockLevel: s.unlockLevel, level: s.level, crateUnlockLevel: s.crateUnlockLevel, homeBiome: s.homeBiome, qualities: s.qualities, stats: s.stats,
			meanFish: s.meanFish, multiChance: s.multiChance, jackpot3plus: s.jackpot3plus, jackpot5: s.jackpot5, cooldownMs: s.cooldownMs,
			maxDurability: s.maxDurability, lifeHoursRegular: s.lifeHoursRegular, repairCost: s.repairCost, repairCostPerFish: s.repairCostPerFish === undefined ? 0 : s.repairCostPerFish, upkeepShareHome: s.upkeepShareHome,
			assembly: s.assembly && { ...s.assembly },
		})),
		rates,
		combos: {
			total: combos.length,
			meanFishHistogram: hist,
			atCeiling: { count: ceiling, share: ceiling / combos.length, ceilingMean: PARAMS.multi.ceilingMean, levels: spread(combos.filter((c) => c.meanFish >= PARAMS.multi.ceilingMean - 1e-9).map((c) => c.level)) },
			today: { fishPerCastHistogram: legacyHist, atCap15: { count: combos.filter((c) => c.legacy.fishPerCast >= 15).length, share: combos.filter((c) => c.legacy.fishPerCast >= 15).length / combos.length } },
			perTier,
			bestAtLevel,
		},
		specialties,
		statValue,
		upkeep: {
			rule: `repairCost(rod-piece rarity) = ${PARAMS.repair.upkeepShare} x matched-set maxDurability x its $/fish at home; unlimited repairs`,
			byTierHome: [...path.slice(1), ...crafted.slice(1)].map((s) => ({ tier: s.tier, name: s.name, kind: s.kind, homeBiome: s.homeBiome, repairCost: s.repairCost, maxDurability: s.maxDurability, lifeHoursRegular: s.lifeHoursRegular, shareHome: s.upkeepShareHome, repairCostInMinutesOfHomeIncome: (s.repairCost / rodHourly(s, s.homeBiome).cash) * 60 })),
			oldRod: 'unbreakable: no upkeep, no replacement, no soft-lock',
			// What today's Old Rod repair (catalog rods.js) would cost under the proposed value model, as a share
			// of Old Rod income: the sink the unbreakable rule gives up.
			oldRodLegacyRepairShare: Object.fromEntries(MODELLED_BIOMES.map((b) => [b, today.oldRod.repairCost / (today.oldRod.maxDurability * rodOutcome(oldRod(), b).valuePerFish)])),
		},
		crates: crates.map((c) => ({ tier: c.tier, name: c.name, price: c.price, unlockLevel: c.shop.unlockLevel, existingItem: c.shop.existingItem, rarityTable: c.rarityTable, rarityFloor: c.rarityFloor, guaranteedSlots: c.guaranteedSlots, duplicates: c.duplicates, pity: c.pity, featured: c.pool.featured, slotOdds: c.slotOdds })),
		assembly: assemblies.map((a) => ({ ...a })),
		customPath: custom.map((s) => ({ tier: s.tier, name: s.name, kind: s.kind, level: s.level, meanFish: s.meanFish, stats: s.stats, maxDurability: s.maxDurability, repairCost: s.repairCost, cost: s.purchase ? s.purchase.cost : 0 })),
		crafted5b4Path: crafted.map((s) => ({ tier: s.tier, name: s.name, level: s.level, meanFish: s.meanFish, cost: s.purchase ? s.purchase.cost : 0 })),
		entryT1,
		salvage,
		legacyCrate: legacyCrate(),
		catalogSync: catalogSync(),
		engineValidation: { ...ENGINE_VALIDATION, exactNow: Object.fromEntries(ENGINE_VALIDATION.crates.map((c) => [c.tier, round4(cratesDistribution(c.tier).expected)])) },
		legacyConverter: {
			signatures: sigGroups.size,
			uniqueSignatures: [...sigGroups.values()].filter((g) => g.length === 1).length,
			signatureTierExact: exactTier / combos.length,
			signatureTierUnder: underTier / combos.length,
			signatureTierOver: overTier / combos.length,
			signaturePowerOver: overPower / combos.length,
			samples: legacySamples,
			// Grandfathered durability: legacy maxDurability / proposed, and the resulting upkeep at home.
			grandfathered: legacyDurability(),
		},
		standard,
		customRelation,
		customBuilds,
		levelRule,
		lifecycle: {
			method: `integrated model at framework ${F.FRAMEWORK_VERSION}: integrate.run (${I.REFERENCE_NOTE}); variants ${Object.keys(LIFECYCLE_VARIANTS).join(', ')}; stress = the same reference systems plus a probe spending a share of each step's fishing income elsewhere; 5b.4 = the crafted T1-T5 ladder without upgrades on today's model`,
			regular: { ...lifeRow(life.regular), targets: inTarget(life.regular.reached) },
			archetypes: Object.fromEntries(PLAYERS.map((k) => [k, lifeRow(life[k])])),
			noUpgrades: Object.fromEntries(PLAYERS.map((k) => [k, { ...lifeRow(lifeNone[k]), targets: inTarget(lifeNone[k].reached) }])),
			customVariant: Object.fromEntries(PLAYERS.map((k) => [k, { ...lifeRow(lifeCustom[k]), targets: inTarget(lifeCustom[k].reached) }])),
			ladder5b4: Object.fromEntries(PLAYERS.map((k) => [k, { ...lifeRow(life4[k]), targets: inTarget(life4[k].reached) }])),
			variantMaxDelay,
			stressDelays,
			rodShareOfStage: stageShare,
		},
		record5b4: RECORD_5B4,
		integration: {
			system: SYSTEM_NAME,
			defaults: { ...SYSTEM_DEFAULTS },
			ledger: { cash: ['salvage'], spend: { upkeep: ['repairs'], progression: [...standardRods().map((r) => r.name), ...TIERS.map((t) => PARAMS.crates.tiers[t].name)] } },
			parity: SYSTEM_PARITY,
		},
	};
}

let reportCache = null;
/** Every key number, computed from framework.js and the integrated model (synchronous; cached per process). */
function report() {
	if (!reportCache) reportCache = buildReport();
	return reportCache;
}

// ---------------------------------------------------------------------------------------------
// Proposed design decisions (join decisions.js's registry). Status is only ever 'proposed': the user
// approves. `get` reads the value this module runs; decisions.verify() checks it equals `expected`.
const listOf = (o, f = (v) => v) => Object.entries(o).map(([k, v]) => `${k} ${f(v)}`).join(', ');
const DECISIONS = [
	{
		id: 'P-RODS-TIER', status: 'proposed',
		title: 'A crafted rod\'s tier is the tier of its highest-rarity part; the requirement it shows is that part\'s level',
		modelled: `tierOfRarity: ${listOf(PARAMS.tierOfRarity, (t) => `T${t}`)}`,
		alternatives: ['today: requirement 10 x the summed "N count" qualities, while bare-number draws cost no level (the level bypass)', 'tier from the rod piece alone'],
		source: 'rods design', why: 'part rarity finally matters and no combination can bypass its level',
		get: () => PARAMS.tierOfRarity, expected: { Common: 1, Uncommon: 1, Rare: 2, Ultra: 3, Legendary: 4, Lucky: 5 },
	},
	{
		id: 'P-RODS-LEVEL-CAP', status: 'proposed',
		title: 'Part level caps: a part works at full strength from its level; below it, it performs at the best rarity the player has unlocked',
		modelled: `partLevel: ${listOf(PARAMS.partLevel, (L) => `Lv ${L}`)}; e.g. a Legendary part at Lv 35 performs as ${capRarity('Legendary', 35)}`,
		alternatives: ['a strict equip gate at the tier level', 'no cap (today)'],
		source: 'rods design', why: 'one rule covers new crafts, existing rods, jackpot parts and admin grants; parts can still be collected and crafted early',
		get: () => ({ partLevel: PARAMS.partLevel, legendaryAtLv35: capRarity('Legendary', 35) }),
		expected: { partLevel: { Common: 10, Uncommon: 20, Rare: 30, Ultra: 40, Legendary: 50, Lucky: 60 }, legendaryAtLv35: 'Rare' },
	},
	{
		id: 'P-RODS-CRAFT', status: 'proposed',
		title: 'The Rod Workshop (crafting) opens at Lv 10 with the first standard rod and the Fishing Crate; every crafted rod catches weak and strong fish',
		modelled: `minLevel ${PARAMS.craft.minLevel}; qualities ${PARAMS.craft.qualities.join(' + ')}`,
		alternatives: ['today: no crafting level; strong access only from part qualities (an all-Common rod is weak-only)', '5b.4: Lv 20 (crafting was the only rod path, the first crafted rod the Lv 20 milestone)'],
		source: 'rods design (5b.5: standard/custom split)', why: 'crafting is the optional depth path from the moment its input (the Fishing Crate) is sold; the reference player does not need it',
		get: () => PARAMS.craft, expected: { minLevel: 10, qualities: ['weak', 'strong'] },
	},
	{
		id: 'P-RODS-MEAN-FISH', status: 'proposed',
		title: 'The rod piece sets mean fish per cast by rarity (framework multi-catch chain), capped at the endgame ceiling',
		modelled: `meanFish: ${listOf(PARAMS.slots.rod.meanFish)}; ceiling ${PARAMS.multi.ceilingMean}`,
		alternatives: ['today: draws x per-draw (4-15 fish per cast, most combinations at the 15 cap)', 'other per-rarity means inside the approved ~1.0 to 1.5-1.8 band'],
		source: 'rods design (approved direction A-MULTICATCH; the numbers are proposed)', why: 'progression-based, probabilistic multi-catch with rare 3-5 fish jackpots; removes the 16x cliff',
		get: () => ({ meanFish: PARAMS.slots.rod.meanFish, ceilingMean: PARAMS.multi.ceilingMean }),
		expected: { meanFish: { Common: 1.1, Uncommon: 1.2, Rare: 1.3, Ultra: 1.5, Legendary: 1.65, Lucky: 1.8 }, ceilingMean: 1.8 },
	},
	{
		id: 'P-RODS-SLOT-FAMILIES', status: 'proposed',
		title: 'Per-slot stat families that add across parts: reel = speed + trophy; hook = Rare Find + Luck; handle = durability multiplier + sell bonus',
		modelled: Object.entries(PARAMS.slots).map(([k, v]) => `${k}: ${v.family}`).join('; '),
		alternatives: ['today: PART_RARITY_STATS, the same bundle for every part of a rarity, plus speed per quick part'],
		source: 'rods design', why: 'rods differ by specialty instead of by volume',
		get: () => ({ reel: { fishingSpeed: PARAMS.slots.reel.fishingSpeed, trophyChance: PARAMS.slots.reel.trophyChance }, hook: { rareFind: PARAMS.slots.hook.rareFind, luck: PARAMS.slots.hook.luck }, handle: { durabilityMult: PARAMS.slots.handle.durabilityMult, sellBonus: PARAMS.slots.handle.sellBonus } }),
		expected: {
			reel: { fishingSpeed: { Common: 0, Uncommon: 0.03, Rare: 0.05, Ultra: 0.10, Legendary: 0.15, Lucky: 0.20 }, trophyChance: { Common: 0, Uncommon: 0.05, Rare: 0.10, Ultra: 0.30, Legendary: 0.50, Lucky: 0.70 } },
			hook: { rareFind: { Common: 0.10, Uncommon: 0.20, Rare: 0.40, Ultra: 0.60, Legendary: 0.90, Lucky: 1.20 }, luck: { Common: 0.05, Uncommon: 0.10, Rare: 0.20, Ultra: 0.40, Legendary: 0.60, Lucky: 0.80 } },
			handle: { durabilityMult: { Common: 1.0, Uncommon: 1.1, Rare: 1.25, Ultra: 1.45, Legendary: 1.7, Lucky: 2.0 }, sellBonus: { Common: 0, Uncommon: 0, Rare: 0.02, Ultra: 0.04, Legendary: 0.06, Lucky: 0.08 } },
		},
	},
	{
		id: 'P-RODS-VARIANTS', status: 'proposed',
		title: 'Same-slot, same-rarity catalog parts become named side-grade variants (about the same net $/h, a different emphasis)',
		modelled: Object.entries(PARAMS.variants).map(([k, v]) => `${k}: ${v.label}`).join('; '),
		alternatives: ['identical parts within a rarity (today, apart from legacy numbers)'],
		source: 'rods design', why: 'collecting variants is an aspirational goal that is not pay-to-win; tilts follow each part\'s identity in today\'s catalog',
		get: () => PARAMS.variants,
		expected: {
			'Fiberglass Rod Piece': { label: 'Fast action', meanDelta: 0.02, durability: 0.75 },
			'Graphite Rod Piece': { label: 'Backbone', meanDelta: -0.02, durability: 1.5 },
			'Centerpin Reel': { label: 'Free-spool', fishingSpeed: 1.2, trophyChance: 0.5 },
			'Jigging Reel': { label: 'Heavy drag', fishingSpeed: 0.8, trophyChance: 2.5 },
			'Fly Fishing Reel': { label: 'Light retrieve', fishingSpeed: 1.2, trophyChance: 0.5 },
			'Trolling Reel': { label: 'Trolling drag', fishingSpeed: 0.8, trophyChance: 2.5 },
			'Swimbait Hook': { label: 'Big bait', rareFind: 0.85, luck: 1.5 },
			'Worm Hook': { label: 'Natural bait', rareFind: 1.15, luck: 0.6 },
		},
	},
	{
		id: 'P-RODS-DURABILITY', status: 'proposed',
		title: 'Durability sized in hours of play: a matched set lasts lifeHours by rod-piece rarity; the handle multiplies it; still 1 durability per fish',
		modelled: `lifeHours: ${listOf(PARAMS.durability.lifeHours, (h) => `${h} h`)}; rounded to ${PARAMS.durability.roundTo}`,
		alternatives: ['today: the sum of the parts\' durability qualities'],
		source: 'rods design', why: 'upkeep frequency is a property of play time, not an arbitrary number; a better handle means fewer repairs',
		get: () => PARAMS.durability, expected: { lifeHours: { Common: 2.5, Uncommon: 3, Rare: 4, Ultra: 5, Legendary: 6, Lucky: 8 }, roundTo: 50 },
	},
	{
		id: 'P-RODS-REPAIR', status: 'proposed',
		title: 'Unlimited repairs for crafted rods; repair cost = a fixed share of what the matched set\'s durability earns in its home biome (by rod-piece rarity)',
		modelled: `upkeepShare ${PARAMS.repair.upkeepShare}; maxRepairs ${PARAMS.repair.craftedMaxRepairs === null ? 'unlimited' : PARAMS.repair.craftedMaxRepairs}`,
		alternatives: ['today: 10,000 x count, a fixed repair limit, then the rod is destroyed', 'another upkeep share'],
		source: 'rods design (user decision 10: modest mandatory upkeep)', why: 'predictable upkeep sized to income; a forced re-purchase of a whole progression purchase is not modest',
		get: () => PARAMS.repair, expected: { upkeepShare: 0.04, craftedMaxRepairs: null },
	},
	{
		id: 'P-RODS-OLD-ROD', status: 'proposed',
		title: 'The Old Rod is unbreakable (weak only, one fish, no stats); no free replacements',
		modelled: `unbreakable ${PARAMS.oldRod.unbreakable}; meanFish ${PARAMS.oldRod.meanFish}; qualities ${PARAMS.oldRod.qualities.join(', ')}`,
		alternatives: ['a cheap repair', 'today: finite durability, a paid repair and a free replacement once destroyed'],
		source: 'rods design', why: 'ends the free-replacement loop and the $0 soft-lock; the fallback that keeps crafted-rod owners fishing must never block play',
		get: () => PARAMS.oldRod, expected: { unbreakable: true, meanFish: 1, qualities: ['weak'] },
	},
	{
		id: 'P-RODS-LEGACY-RODS', status: 'proposed',
		title: 'Existing crafted rods: read-time converter (no data rewrite); a destroyed crafted rod counts as broken',
		modelled: 'parts resolve -> the proposed rules on the same parts (fingerprint fallback that never over-estimates power); state destroyed -> broken (repairable); stored durability: P-RODS-LEGACY-DURABILITY',
		alternatives: ['keep the legacy capabilities driving existing rods (their fish per cast and the level bypass stay)', 'a one-time rewrite of every crafted rod to the new rules (a data migration; decision 13 asks for none)'],
		source: 'rods design (user decision 13: non-destructive)', why: 'no player document is rewritten; rods lost to the old repair limit and to bug C1 come back',
		get: () => ({ destroyedBecomes: convertLegacyRod({ capabilities: [], maxDurability: 1e6, durability: 5, state: 'destroyed' }).state }),
		expected: { destroyedBecomes: 'broken' },
	},
	{
		// Split out of P-RODS-LEGACY-RODS so the durability perk is decided on its own numbers (getters: computed on read).
		id: 'P-RODS-LEGACY-DURABILITY', status: 'proposed',
		title: 'Existing crafted rods keep their stored max durability (grandfathered); repairs at the proposed cost',
		get modelled() {
			const g = legacyDurability();
			return `effective max durability = max(stored, rule): legacy max / proposed ${rng3(g.durabilityRatio, (x) => `${+x.toFixed(2)}x`)} (min-median-max over every catalog combination); upkeep at home ${rng3(g.upkeepShareHome, (x) => pct(x))} of fish income, against ${rng3(g.upkeepShareHomeRule, (x) => pct(x))} for the same parts under the rule`;
		},
		get alternatives() {
			return [`rescale legacy durability to the new pool through an additive condition field (upkeep at home as under the rule: ${rng3(legacyDurability().upkeepShareHomeRule, (x) => pct(x))})`];
		},
		source: 'rods design (user decision 13: non-destructive; split from P-RODS-LEGACY-RODS)', why: 'the stored durability is part of what the player owns; the perk lowers upkeep (cash) only, never catch rates or leaderboards',
		get: () => ({ maxDurability: convertLegacyRod({ capabilities: [], maxDurability: 1e6, durability: 5, state: 'broken' }).durability.max === 1e6 ? 'stored' : 'rule' }),
		expected: { maxDurability: 'stored' },
	},
	{
		id: 'P-RODS-CRATE-PRICE', status: 'proposed',
		title: 'Crate prices as hours of stage income: assembling tier t\'s set costs assemblyHours[t] of the previous stage\'s income in expectation',
		modelled: `assemblyHours: ${listOf(PARAMS.assemblyHours, (h) => `${h} h`)}; price = hours x stage income / E[crates], ${PARAMS.priceSigDigits} significant digits`,
		alternatives: ['fixed prices', 'other hour budgets'],
		source: 'rods design', why: 'one progression purchase per tier, bought during the stage before it; prices regenerate with any framework change',
		get: () => ({ assemblyHours: PARAMS.assemblyHours, priceSigDigits: PARAMS.priceSigDigits }), expected: { assemblyHours: { 1: 1.25, 2: 2.5, 3: 4, 4: 6, 5: 8 }, priceSigDigits: 2 },
	},
	{
		id: 'P-RODS-CRATES', status: 'proposed',
		title: 'Tier part crates (Gacha V2): independent slots, unique duplicates, slot-balanced featured weights, rarity floors, a guaranteed slot 0, Lucky pity on T5; each unlocks one stage early',
		modelled: TIERS.map((t) => `${PARAMS.crates.tiers[t].name} (Lv ${PARAMS.crates.tiers[t].unlockLevel}, floor ${PARAMS.crates.tiers[t].rarityFloor || 'none'}, slot 0 >= ${PARAMS.crates.tiers[t].guaranteed || 'none'}${PARAMS.crates.tiers[t].pity ? ', pity' : ''})`).join('; '),
		alternatives: ['one crate for every tier', 'no floors or guarantees (coupon-collector tail)'],
		source: 'rods design', why: 'a tier-appropriate set in a few crates with a bounded tail; the next tier\'s parts appear rarely as exciting, level-capped pulls',
		get: () => PARAMS.crates,
		expected: {
			slots: 3, strategy: 'independent', duplicates: 'unique', balanceSlots: true,
			tiers: {
				1: { name: 'Fishing Crate', existing: true, unlockLevel: 10, rarityTable: { common: 50, uncommon: 47, rare: 3 }, rarityFloor: null, guaranteed: 'uncommon' },
				2: { name: 'Pro Tackle Crate', unlockLevel: 20, rarityTable: { uncommon: 45, rare: 52, ultra: 3 }, rarityFloor: 'uncommon', guaranteed: 'rare' },
				3: { name: 'Expert Tackle Crate', unlockLevel: 30, rarityTable: { rare: 45, ultra: 52, legendary: 3 }, rarityFloor: 'rare', guaranteed: 'ultra' },
				4: { name: 'Master Tackle Crate', unlockLevel: 40, rarityTable: { ultra: 45, legendary: 54, lucky: 1 }, rarityFloor: 'ultra', guaranteed: 'legendary' },
				5: { name: 'Gilded Tackle Crate', unlockLevel: 50, rarityTable: { legendary: 80, lucky: 20 }, rarityFloor: 'legendary', guaranteed: null, pity: { lucky: { counter: 'lucky', tiers: ['lucky'], softStart: 3, rampPerCast: 0.1, maxBonus: 0.5, hard: 8 } } },
			},
		},
	},
	{
		// Numbers come from legacyCrate() (rods.md §7.4); getters compute them on read, never at module load.
		// USER-CHOSEN option (b) (Phase 5B decision set): what the model records and runs.
		id: 'P-RODS-FISHING-CRATE', status: 'proposed',
		title: 'Fishing Crate: delisted now (hotfix L5); at the 5B migration owned units are snapshotted into an additive legacyCount and open under the OLD Fishing Crate definition first; never converted, never opened as the new T1 part crate',
		get modelled() {
			const L = legacyCrate();
			const b = L.options[1];
			return `option (b) (user choice): legacyCount = the stack count at migration (additive, idempotent); /open takes legacy units first with today's definition: ${usd(b.salvagePerCrate)} of expected part salvage per crate (${b.salvageShareOfPaid.toFixed(2)}x the ${usd(L.today.price)} paid) plus its bait; units acquired after release open as ${crateDefinition(1).name} (T1 part crate, ${usd(cratePrice(1))})`;
		},
		get alternatives() {
			const L = legacyCrate();
			const [a, , c] = L.options;
			return [
				`(a) owned crates open under the new definition: ${usd(a.salvagePerCrate)} of salvage per crate, ${a.salvageShareOfPaid.toFixed(2)}x the price paid (an arbitrage on stock bought at today's price)`,
				`(c) convert owned crates at the price ratio (${c.priceRatio.toFixed(3)} of a T1 crate each; ${c.exchange} owned crates per T1 open from a legacyCount marker)`,
			];
		},
		source: 'rods design; user decision (option b)',
		why: 'what a player bought opens as what they bought; no arbitrage, no conversion of player data (additive marker only)',
		get: () => ({ name: crateDefinition(1).name, existing: Boolean(PARAMS.crates.tiers[1].existing), types: crateDefinition(1).pool.types, ownedStock: PARAMS.legacyCrateStock }),
		expected: { name: 'Fishing Crate', existing: true, types: ['part_rod', 'part_reel', 'part_hook', 'part_handle'], ownedStock: { option: 'b', marker: 'legacyCount', opensAs: 'legacy-definition-first', converted: false } },
	},
	{
		id: 'P-RODS-SALVAGE', status: 'proposed',
		title: 'Duplicate parts salvage for cash; the integrated model salvages every leftover part on assembly (default on)',
		modelled: `salvage = ${PARAMS.salvage.share} of one slot of the crate that guarantees the rarity (Common: ${PARAMS.salvage.commonOfUncommon} of Uncommon); system default salvage ${SYSTEM_DEFAULTS.salvage}`,
		alternatives: ['no salvage (duplicates stay dead inventory)', 'model salvage off (the conservative case)'],
		source: 'rods design', why: 'duplicates are never worthless, while a crate\'s full salvage stays far below its proposed price (no arbitrage at the proposed prices; crates bought at today\'s price are the exception, P-RODS-FISHING-CRATE)',
		get: () => ({ ...PARAMS.salvage, systemDefault: SYSTEM_DEFAULTS.salvage }), expected: { share: 0.25, commonOfUncommon: 0.25, systemDefault: true },
	},
	{
		id: 'P-RODS-STANDARD-LADDER', status: 'proposed',
		title: 'Standard rods: six shop rods bought with cash, one per biome level (Lv 10-60), generalists with modest multi-catch below the custom set of the same level and the 1.80 ceiling',
		get modelled() {
			return standardRods().map((r) => `${r.name} (${r.role}, Lv ${r.level}): ${r.meanFish.toFixed(2)} fish, ${statsLine(r.stats)} RF/Luck/Trophy/Speed/Sell, ${n0(r.maxDurability)} durability, repair ${usd(r.repairCost)}`).join('; ');
		},
		alternatives: ['VF-style volume ladder (fish per cast escalating to 3-10; rejected: 1.80 ceiling)', 'fewer standard rods (Lv 20/40/60 only)', 'no standard rods (5b.4: crafting is the only rod path)'],
		source: 'rods design (user direction: Virtual Fisher\'s progression skeleton, modest multi-catch)', why: 'a player who never crafts gets a clear save -> buy ladder; power comes from a mix of fish, speed, rarity, trophy and sturdiness, never above the ceiling',
		get: () => PARAMS.standard.rods.map((r) => ({ name: r.name, level: r.level, meanFish: r.meanFish, qualities: r.qualities, stats: r.stats, lifeHours: r.lifeHours })),
		expected: [
			{ name: 'Trusty Rod', level: 10, meanFish: 1, qualities: ['weak', 'strong'], stats: { rareFind: 0.1, luck: 0.05, trophyChance: 0, fishingSpeed: 0.02, sellBonus: 0 }, lifeHours: 3 },
			{ name: 'Angler\'s Rod', level: 20, meanFish: 1.15, qualities: ['weak', 'strong'], stats: { rareFind: 0.15, luck: 0.08, trophyChance: 0.05, fishingSpeed: 0.03, sellBonus: 0 }, lifeHours: 3.5 },
			{ name: 'Pro Angler Rod', level: 30, meanFish: 1.28, qualities: ['weak', 'strong'], stats: { rareFind: 0.3, luck: 0.15, trophyChance: 0.08, fishingSpeed: 0.07, sellBonus: 0.01 }, lifeHours: 4 },
			{ name: 'Expedition Rod', level: 40, meanFish: 1.48, qualities: ['weak', 'strong'], stats: { rareFind: 0.45, luck: 0.3, trophyChance: 0.2, fishingSpeed: 0.1, sellBonus: 0.02 }, lifeHours: 5 },
			{ name: 'Master\'s Rod', level: 50, meanFish: 1.62, qualities: ['weak', 'strong'], stats: { rareFind: 0.7, luck: 0.45, trophyChance: 0.35, fishingSpeed: 0.15, sellBonus: 0.04 }, lifeHours: 6 },
			{ name: 'Summit Rod', level: 60, meanFish: 1.75, qualities: ['weak', 'strong'], stats: { rareFind: 0.85, luck: 0.55, trophyChance: 0.45, fishingSpeed: 0.14, sellBonus: 0.05 }, lifeHours: 7 },
		],
	},
	{
		id: 'P-RODS-STANDARD-PRICES', status: 'proposed',
		title: 'Standard rod prices from stage income: priceHours x the $/h of the previous standard rod in the biome opened 10 levels earlier (2 significant digits)',
		get modelled() {
			return standardRods().map((r) => `${r.name} ${r.priceHours} h = ${usd(r.price)}`).join(', ');
		},
		alternatives: ['the 5b.4 assembly budgets (1.25/2.5/4/6/8 h: custom and standard would cost the same)', 'fixed prices'],
		source: 'rods design', why: 'each rod is a real save goal inside its stage yet already affordable when its level arrives (no rod waits for cash for any archetype); the balanced custom set costs more for more power',
		get: () => standardRods().map((r) => r.price), expected: [5100, 13000, 57000, 140000, 390000, 880000],
	},
	{
		id: 'P-RODS-REFERENCE-LADDER', status: 'proposed',
		title: 'The reference player uses the STANDARD ladder (framework GEAR_PATH_LADDER); custom rods are an optional variant',
		get modelled() {
			return `F.GEAR_PATH_LADDER '${F.GEAR_PATH_LADDER}' (F.gearPath() = the standard ladder); custom variant = integrate.run variant.rods 'custom'`;
		},
		alternatives: ['custom sets as the reference (5b.4; makes crafting the mandatory onboarding path)'],
		source: 'rods design', why: 'the curve windows must hold for the player who never crafts; the custom player then runs ahead, as an optimisation path should',
		get: () => F.GEAR_PATH_LADDER, expected: 'standard',
	},
	{
		id: 'P-RODS-CUSTOM-RELATION', status: 'proposed',
		title: 'Custom vs standard: custom tier c (Lv 20-60) competes with the standard rod of the same level; the balanced custom set carries a little more fish and more Rare Find/Luck/Trophy, costs more (with crate variance); specialised builds trade balance for one goal',
		get modelled() {
			const r = report().customRelation;
			return r.map((c) => `Lv ${c.level}: ${c.standard} ${c.meanFish.standard.toFixed(2)} fish / ${usd(c.cost.standard)} vs custom ${c.meanFish.custom.toFixed(2)} fish / ${usd(c.cost.customNetOfSalvage)} net of salvage (${rel(c.netCashPerHour.custom / c.netCashPerHour.standard)} net $/h)`).join('; ');
		},
		alternatives: ['custom always strictly stronger in every stat (removes the standard rod\'s sturdiness/speed identity)', 'custom = standard power with cosmetic choice only'],
		source: 'rods design (user direction: custom can beat or specialise beyond the store rod at the same stage)', why: 'crafting stays worth it for optimisers without being mandatory: its edge is a few percent, bought with more cash, crate luck and effort',
		get: () => ({ customOffset: PARAMS.standard.customOffset, ceilingMean: PARAMS.multi.ceilingMean }), expected: { customOffset: 1, ceilingMean: 1.8 },
	},
	{
		id: 'P-RODS-CUSTOM-LEVEL-RULE', status: 'proposed',
		title: 'Custom rod level requirement = the highest part\'s rarity level (Common Lv 10 ... Lucky Lv 60), replacing the inherited 10 x the summed "N count"; parts above the player\'s level work at the best rarity unlocked',
		get modelled() {
			return `partLevel ${listOf(PARAMS.partLevel, (x) => `Lv ${x}`)}; four seeded Commons: Lv ${PARAMS.partLevel.Common} (seeded catalog today: Lv ${rng(report().levelRule[0].todayLevel, (x) => x)})`;
		},
		alternatives: ['keep 10 x summed counts (a matched Legendary set needs Lv 70 today; bare-number draws bypass it)', 'the rod piece alone sets the requirement'],
		source: 'rods design (live rod gates are held until this is decided)', why: 'the requirement reads from the rarity the player sees, matches the standard ladder\'s levels and cannot be bypassed',
		get: () => ({ partLevel: PARAMS.partLevel, fourCommons: craftRod(matchedSet('Common')).level }), expected: { partLevel: { Common: 10, Uncommon: 20, Rare: 30, Ultra: 40, Legendary: 50, Lucky: 60 }, fourCommons: 10 },
	},
	{
		id: 'P-SHOP-LAYOUT', status: 'proposed',
		title: 'Shop tabs Rods | Bait | Upgrades | Supplies | Aquarium | Special (a tab with no valid item for the player is hidden); crafting moves to its own Rod Workshop (parts, tier crates, craft, salvage)',
		modelled: 'layout and flow only (rods.md §5); not simulated',
		alternatives: ['today: one paged list + Fishing Rod | Bait | Other buttons', 'a single select menu with categories'],
		source: 'rods design (user direction)', why: 'every tab has something the player can act on; the Rods tab shows the next rod and the $ still needed',
	},
	{
		id: 'P-RODS-C1-REFUND', status: 'proposed',
		title: 'Refund crafted-rod repair charges lost to bug C1 where Interaction analytics identify them',
		modelled: 'not modelled: a one-off guarded migration keyed by Interaction id, only after approval',
		alternatives: ['no refund'],
		source: 'rods design', why: 'players paid for repairs that never applied',
	},
];

// ---------------------------------------------------------------------------------------------
// Generated doc tables: docs/economy/5b/rods.md blocks (render-docs.js). Every number comes from report().
const mdTable = (headers, rows) => [`| ${headers.join(' | ')} |`, `| ${headers.map(() => '---').join(' | ')} |`, ...rows.map((r) => `| ${r.join(' | ')} |`)].join('\n');
const n0 = (x) => Math.round(x).toLocaleString('en-US');
const usd = (x) => `$${n0(x)}`;
const signedUsd = (x) => `${Math.round(x) < 0 ? '−' : '+'}${usd(Math.abs(x))}`;
const times = (x, d = 2) => `${x.toFixed(d)}×`;
const pct = (x, d = 1) => `${(x * 100).toFixed(d)}%`;
/** Signed relative change of a ratio (1.015 -> +1.5%). */
const rel = (ratio, d = 1) => {
	const v = +((ratio - 1) * 100).toFixed(d);
	return `${v > 0 ? '+' : v < 0 ? '−' : ''}${Math.abs(v).toFixed(d)}%`;
};
const hrs = (x, d = 2) => `${x.toFixed(d)} h`;
// Ranges collapse when the ends print the same (values are unrounded until they are printed).
const rng = (s, f) => (f(s.min) === f(s.max) ? f(s.min) : `${f(s.min)}–${f(s.max)}`);
const rng3 = (s, f) => (f(s.min) === f(s.max) ? f(s.min) : `${f(s.min)}–${f(s.median)}–${f(s.max)}`);
const minMax = (arr, f) => rng({ min: Math.min(...arr), max: Math.max(...arr) }, f);
const tilt = (v) => [
	v.meanDelta !== undefined && `${v.meanDelta > 0 ? '+' : '−'}${Math.abs(v.meanDelta)} fish`, v.durability && `×${v.durability} life`,
	v.fishingSpeed && `speed ×${v.fishingSpeed}`, v.trophyChance && `trophy ×${v.trophyChance}`, v.rareFind && `Rare Find ×${v.rareFind}`, v.luck && `Luck ×${v.luck}`,
].filter(Boolean).join(', ');
/** 'Uncommon set', or 'Lucky rod + Legendary reel/hook/handle' when the catalog lacks a rarity in a slot. */
const setName = (set) => {
	const groups = [...new Set(Object.values(set).map((p) => p.rarity))].map((r) => `${r} ${Object.keys(set).filter((k) => set[k].rarity === r).join('/')}`);
	return groups.length === 1 ? `${Object.values(set)[0].rarity} set` : groups.join(' + ');
};
const statsLine = (s) => ['rareFind', 'luck', 'trophyChance', 'fishingSpeed', 'sellBonus'].map((k) => Math.round((s[k] || 0) * 100)).join(' / ') + '%';

function markdownTables() {
	const R = report();
	const gp = R.gearPath;
	const refs = gp.slice(1);
	const asm = R.assembly;
	const L = R.lifecycle;
	const reg = L.regular;
	const PLAYERS = Object.keys(L.archetypes);
	const out = {};

	// Headline figures for the summary.
	const LCR = R.legacyCrate;
	const ceilingLv = R.combos.atCeiling.levels;
	const regWindows = Object.entries(reg.targets);
	const allDelays = [...PLAYERS.map((k) => L.archetypes[k].maxTierDelayHours), ...PLAYERS.flatMap((k) => Object.values(L.variantMaxDelay[k]))];
	const ST = R.standard;
	const CR = R.customRelation;
	const common = R.levelRule.find((x) => x.rarity === 'Common');
	const noneWin = Object.entries(L.noUpgrades.regular.targets);
	out['rods-headline'] = mdTable(['Figure', 'Value', 'Detail'], [
		['Standard (shop) ladder, mean fish per cast', `Old Rod ${gp[0].meanFish.toFixed(2)} → ${refs.map((s) => `${s.name} ${s.meanFish.toFixed(2)}`).join(' → ')}`, 'Standard ladder'],
		['Standard rod prices (Lv 10 → Lv 60)', refs.map((s) => usd(s.price)).join(' / '), 'Standard ladder'],
		['Custom reference sets, mean fish per cast (Lv 20–60)', `${CR.map((c) => c.meanFish.custom.toFixed(2)).join(' / ')} (the ${R.combos.atCeiling.ceilingMean} normal ceiling is reached only by a Lv 60 custom rod)`, 'Custom vs standard'],
		['Custom set vs the standard rod of the same level', `net $/h ${minMax(CR.map((c) => c.netCashPerHour.custom / c.netCashPerHour.standard), (x) => rel(x))}, for ${minMax(CR.map((c) => c.cost.customNetOfSalvage / c.cost.standard), times)} the standard price (net of salvage)`, 'Custom vs standard'],
		['Custom rod level requirement', `highest part's level: four Commons Lv ${common.proposed} (seeded catalog today: Lv ${rng(common.todayLevel, (x) => x)}); ${listOf(PARAMS.partLevel, (x) => `Lv ${x}`)}`, 'Custom level rule'],
		['Every crafted rod, mean fish per cast', `${minMax(Object.keys(R.combos.meanFishHistogram).map(Number), (x) => x.toFixed(2))}; ${pct(R.combos.atCeiling.share)} of combinations at the ceiling (Lv ${rng(ceilingLv, (x) => x)} only); today ${pct(R.combos.today.atCap15.share)} at the 15-fish cap`, 'All combinations'],
		['Mandatory upkeep in the home biome (standard rods)', minMax(refs.map((s) => s.upkeepShareHome), (x) => pct(x)), 'Upkeep'],
		['Repairs over the whole lifecycle (integrated)', `${minMax(PLAYERS.map((k) => L.archetypes[k].totals.repairShare), (x) => pct(x))} of fishing income, every archetype`, 'Integrated lifecycle'],
		['Rods as a share of all income to Lv 60 (integrated)', `${minMax(PLAYERS.map((k) => L.archetypes[k].totals.rodShareOfIncome), (x) => pct(x))} (5b.4 crafted ladder on today's model: ${minMax(PLAYERS.map((k) => L.ladder5b4[k].totals.rodShareOfIncome), (x) => pct(x))})`, 'Delta vs 5b.4'],
		['Owned Fishing Crates at release (`P-RODS-FISHING-CRATE`, user choice (b))', `delisted now; owned units snapshotted into \`legacyCount\` and opened first under the OLD definition: ${usd(LCR.options[1].salvagePerCrate)} expected part salvage per crate (${times(LCR.options[1].salvageShareOfPaid)} the ${usd(LCR.today.price)} paid) plus its bait; never converted`, 'Owned crates'],
		['Regular player (integrated, reference: standard rods + upgrades)', `${regWindows.map(([lv, w]) => `L${lv} ${hrs(w.hours)}`).join(', ')}; ${regWindows.every(([, w]) => w.ok) ? 'every approved window met' : 'a window is MISSED'}`, 'Integrated lifecycle'],
		['Regular player who never buys an upgrade', `${noneWin.map(([lv, w]) => `L${lv} ${hrs(w.hours)}`).join(', ')}; ${noneWin.every(([, w]) => w.ok) ? 'every approved window met' : 'a window is MISSED'}`, 'Integrated lifecycle'],
		['Rod upgrades waiting for cash (every archetype; reference loop and every variant)', allDelays.every((d) => d === 0) ? 'none: every rod fishes from the step its level is reached' : `up to ${hrs(Math.max(...allDelays.filter((d) => d !== null)))} (${PLAYERS.flatMap((k) => Object.entries(L.variantMaxDelay[k]).filter(([, d]) => d > 0).map(([n, d]) => `${k} ${n} ${hrs(d)}`)).join('; ') || 'reference loop'})`, 'Affordability'],
	]);

	// Current -> Proposed.
	const T = R.today;
	const hist = Object.entries(R.combos.meanFishHistogram).sort((a, b) => Number(a[0]) - Number(b[0]));
	const specialtyNet = Math.max(...R.specialties.map((s) => Math.abs(s.netCashVsBalanced - 1)));
	const crateRow = (t) => `${R.crates[t - 1].name} (T${t}) ${usd(R.crates[t - 1].price)}`;
	out['rods-current-proposed'] = mdTable(['Item', 'Current', 'Proposed', 'Rationale'], [
		['Buying a rod', 'The shop\'s **Fishing Rod** button lists catalog rods with `shopItem: true`; the only rod in the catalog is the Old Rod (`shopItem: false`), so **no rod can be bought**. Better rods come only from crafting', `**Six standard rods in the shop's Rods tab**, one per biome level: ${refs.map((s) => `${s.name} (Lv ${s.level}, ${usd(s.price)})`).join(', ')}. Priced from the income of the stage before each (${refs.map((s) => `${s.priceHours} h`).join(' / ')})`, 'A player who never crafts has a clear save → buy ladder (user direction: Virtual Fisher\'s skeleton).'],
		['Fish per cast', `crafted: draws × per-draw, ${rng(T.crafted.fishPerCast, (x) => x)}. **${n0(R.combos.today.atCap15.count)} of ${n0(R.combos.total)} combinations (${pct(R.combos.today.atCap15.share)}) at the 15-fish cap**`, `Standard: ${refs.map((s) => s.meanFish.toFixed(2)).join(', ')}. Crafted: the rod piece sets the mean (${hist.map(([m]) => m).join(', ')}, variants included). **${n0(R.combos.atCeiling.count)} combinations (${pct(R.combos.atCeiling.share)}) at the ${R.combos.atCeiling.ceilingMean} ceiling**, all Lv ${rng(ceilingLv, (x) => x)}; no normal rod exceeds it`, 'Approved ceiling 1.80 (A-MULTICATCH). Removes the cliff.'],
		['Crafting', 'The only way to a better rod', `**Rod Workshop** (its own menu, from Lv ${PARAMS.craft.minLevel}): the optional depth path. A custom set beats or specialises beyond the standard rod of its level (custom vs standard table)`, 'Crafting stays the deeper optimisation path, not mandatory onboarding.'],
		['Custom level requirement', `10 × Σ "N count" (Lv ${rng(T.crafted.level, (x) => x)}). Bare-number draws cost no level: the best rod usable at Lv 20 lands ${R.combos.bestAtLevel[20].todayFishPerCast} fish, at Lv 30 ${R.combos.bestAtLevel[30].todayFishPerCast}`, `The highest part's level (${listOf(PARAMS.partLevel, (x) => `Lv ${x}`)}); tier = that part's tier. **Level cap:** a part performs at the best rarity the player has unlocked`, 'Part rarity matters and nothing bypasses its level. Existing rods need no gate or data change.'],
		['Part stats', `\`PART_RARITY_STATS\`: the same bundle for every part of a rarity, summed; +${pct(T.quickFishingSpeed, 0)} speed per \`quick\``, 'Each slot has its own stat family, scaled by rarity and summed (slot table)', 'Rods differ by specialty, not volume.'],
		['Same-rarity parts', 'Identical apart from legacy numbers', `${Object.keys(PARAMS.variants).length} named **side-grade variants**: net $/h within ±${(specialtyNet * 100).toFixed(1)}% of the balanced part (specialties table)`, 'Collecting variants is aspirational, not pay-to-win.'],
		['Strong access', 'Union of part qualities: an all-Common rod is weak-only', `Every standard rod from the ${refs[0].name} and every crafted rod catches weak + strong`, 'The first purchase unlocks strong fish.'],
		['Durability', `Crafted: sum of part durabilities, ${rng(T.crafted.durability, n0)}`, `Sized in hours of regular play: standard ${refs.map((s) => n0(s.maxDurability)).join(' / ')} (${minMax(refs.map((s) => s.lifeHoursRegular), (x) => x.toFixed(1))} h); crafted: rod-piece base × handle × variant (${minMax(Object.values(PARAMS.durability.lifeHours), (x) => x)} h for a matched set)`, 'Upkeep is sized in hours of play.'],
		['Repair cost', `10,000 × Σcount (${rng(T.crafted.repairCost, usd)}); ${T.crafted.maxRepairs} repairs, then destroyed. **Crafted-rod repair is broken (C1).**`, `${pct(PARAMS.repair.upkeepShare, 0)} of what one durability life earns at home. Standard: ${refs.map((s) => usd(s.repairCost)).join(' / ')}; crafted by rod-piece rarity: ${R.slotTable.map((s) => usd(s.rod.repairCost)).join(' / ')}. **Unlimited repairs.** A legacy \`destroyed\` crafted rod counts as broken`, 'Modest, predictable upkeep (decision 10); no forced re-purchase.'],
		['Old Rod', `${n0(T.oldRod.maxDurability)} durability, ${usd(T.oldRod.repairCost)} repair, free replacement once destroyed; soft-lock at $0`, `**Unbreakable.** ${PARAMS.oldRod.qualities.map((q) => q[0].toUpperCase() + q.slice(1)).join(', ')} only, ${PARAMS.oldRod.meanFish.toFixed(1)} fish, no stats`, `Removes the free-replacement exploit, the soft-lock and a sink worth ${minMax(Object.values(R.upkeep.oldRodLegacyRepairShare), (x) => pct(x))} of Old Rod income.`],
		['Fishing Crate', `${usd(T.fishingCrate.price)}; ${pct(T.fishingCrate.partShare, 0)} parts / ${pct(1 - T.fishingCrate.partShare, 0)} bait per slot; legacy table (a Rare+ part in ${pct(T.fishingCrate.rarePlusPartPerSlot)} of slots); duplicates \`${T.fishingCrate.duplicates}\`. **Delisted** (hotfix L5)`, `**T1 part crate, ${usd(R.crates[0].price)}** (formula), sold again in the Rod Workshop from Lv ${PARAMS.crates.tiers[1].unlockLevel}. Parts only, slot-balanced, slot 0 ≥ ${PARAMS.crates.tiers[1].guaranteed}, \`${PARAMS.crates.duplicates}\`. Owned units: option (b), opened first under today's definition (§7.4)`, 'The crafting input, priced from stage income; owned stock keeps what it was bought as.'],
		['Higher crates', 'none', `${[2, 3, 4, 5].map(crateRow).join(', ')}; T5 has pity. All formulas`, 'One custom assembly per tier for players who craft.'],
		['Duplicate parts', 'Dead inventory', `**Salvage for cash** (salvage table); a crate's full salvage returns at most ${pct(Math.max(...asm.map((a) => a.salvageReturnPerCrate)))} of its price`, 'Duplicates are never worthless; no arbitrage at the proposed prices.'],
		['Existing crafted rods', 'Legacy capabilities drive draws and per-draw', 'Read-time converter: parts resolve, so the new rules apply to the same parts; stored durability grandfathered; no data rewrite', 'Non-destructive (decision 13).'],
	]);

	// Current DCC progression vs the proposed hybrid progression (one table, every number generated).
	const U = require('./upgrades');
	const UR = U.report();
	const upgRef = UR.runs[F.REFERENCE_ARCHETYPE][F.UPGRADE_POLICY];
	out['rods-hybrid'] = mdTable(['Step of the loop', 'Current DCC (live)', 'Proposed hybrid (5b.5)'], [
		['Cast → sell', 'Catalog values per species; flat 10–25 XP per fish; crafted rods land 4–15 fish per cast', `Value model and XP per rarity (approved); ${gp[0].meanFish.toFixed(2)}–${refs[refs.length - 1].meanFish.toFixed(2)} fish per cast on standard rods, at most ${PARAMS.multi.ceilingMean} on any normal rod`],
		['Buy a standard rod', 'Impossible: the Fishing Rod button has no buyable rod', `${refs.length} shop rods, Lv ${refs.map((s) => s.level).join('/')}: ${usd(refs[0].price)} → ${usd(refs[refs.length - 1].price)}; the regular player buys each at its level (wait ${hrs(L.archetypes.regular.maxTierDelayHours ?? 0)})`],
		['Buy a permanent upgrade', 'None', `${U.UPGRADE_KEYS.length} Angler Upgrades × ${U.PARAMS.levels} levels (${usd(UR.allUpgradesTotal)} for everything); the regular player buys ${upgRef.boughtCount} levels by Lv 60 (${pct(upgRef.upgradeShare)} of income); a never-upgrade player still meets every window`],
		['Unlock a biome', 'Level only (no purchase)', 'Level + one-time permit (approved prices, River $1,000 → Mountain Stream $380,000)'],
		['Specialise with bait', 'Legacy bait catalog', 'Bait redesign (bait.md); Bait Conservation upgrade makes it cheaper'],
		['Craft a superior / custom rod', `Mandatory for any upgrade; requirement 10 × Σcount (Lv ${rng(T.crafted.level, (x) => x)}); 4–15 fish`, `Optional Rod Workshop from Lv ${PARAMS.craft.minLevel}: tier crates → custom sets that beat the standard rod of their level by ${minMax(CR.map((c) => c.netCashPerHour.custom / c.netCashPerHour.standard), (x) => rel(x))} net $/h, or specialise (Rare Hunter, Trophy Hunter, Speed, Workhorse); requirement = highest part level`],
		['Hunt rare / trophy / collection targets', 'Rarity stats bundled per part rarity', 'Rare Find/Luck (hook), Trophy (reel), Fish Knowledge and Trophy Instinct upgrades'],
		['Quests / aquarium / events', 'Legacy', 'Typed quests, aquarium licences and tanks, streak, buffs (approved designs; unchanged here)'],
		['Shop', '`/shop`: one list + Fishing Rod | Bait | Other buttons', 'Rods | Bait | Upgrades | Supplies | Aquarium | Special tabs (empty tabs hidden) + a separate Rod Workshop (§5)'],
	]);

	// Slot families.
	out['rods-slots'] = mdTable(['Part rarity', 'Full effect at', 'Tier', 'Rod piece: mean fish (chance of +1)', 'Reel: Speed / Trophy', 'Hook: Rare Find / Luck', 'Handle: Durability × / Sell', 'Rod-piece durability base', 'Repair cost'], R.slotTable.map((s) => [
		s.rarity, `Lv ${s.level}`, `T${s.tier}`, `${s.rod.meanFish.toFixed(2)} (${pct(s.rod.multiChance)})`,
		`+${pct(s.reel.fishingSpeed, 0)} / +${pct(s.reel.trophyChance, 0)}`, `+${pct(s.hook.rareFind, 0)} / +${pct(s.hook.luck, 0)}`,
		`×${s.handle.durabilityMult.toFixed(2)} / +${pct(s.handle.sellBonus, 0)}`, n0(s.rod.baseDurability), usd(s.rod.repairCost),
	]));

	// Specialties.
	const statLabel = { fishingSpeed: 'Speed', rareFind: 'Rare Find', trophyChance: 'Trophy', luck: 'Luck', sellBonus: 'Sell' };
	const sv = Object.entries(R.statValue).filter(([k]) => k !== 'biome');
	out['rods-specialties'] = [
		`Marginal value of each stat on the T3 reference set in ${R.statValue.biome} (\`report().statValue\`):`,
		'',
		mdTable(['Stat change', 'XP/h', '$/h'], sv.map(([k, v]) => {
			const [stat, step] = k.split(' ');
			return [`${statLabel[stat]} ${step}`, rel(1 + v.xp, 2), rel(1 + v.cash, 2)];
		})),
		'',
		'Each variant against the balanced part of the same rarity, in that tier\'s home biome (`report().specialties`):',
		'',
		mdTable(['Part', 'Rarity', 'Variant', 'Biome', 'XP/h', '$/h', 'Net $/h after repairs', 'Giants', 'Legendary+', 'Rod life'], R.specialties.map((s) => [
			s.part, s.rarity, `${s.variant} (${tilt(PARAMS.variants[s.part])})`, s.biome, rel(s.xpVsBalanced), rel(s.cashVsBalanced), rel(s.netCashVsBalanced),
			rel(s.giantsVsBalanced), rel(s.legendaryPlusVsBalanced), Math.abs(s.lifeVsBalanced - 1) < 1e-9 ? '—' : rel(s.lifeVsBalanced),
		])),
	].join('\n');

	// All combinations.
	const counts = hist.map(([, c]) => c);
	const todayHist = Object.entries(R.combos.today.fishPerCastHistogram).sort((a, b) => Number(a[0]) - Number(b[0]));
	const pt = R.combos.perTier;
	out['rods-combos'] = [
		mdTable(['', 'Mean fish per cast (combinations)'], [
			['Proposed', counts.every((c) => c === counts[0]) ? `${hist.map(([m]) => m).join(', ')} (${n0(counts[0])} each)` : hist.map(([m, c]) => `${m} (${n0(c)})`).join(', ')],
			['Today', todayHist.map(([m, c]) => `${m} (${n0(c)})`).join(', ')],
		]),
		'',
		mdTable(['Tier', 'Combos', 'Level', 'Home biome', 'Fish/cast (min–median–max)', 'XP/h', '$/h', '$/h vs reference set', 'Life (h, regular)', 'Upkeep at home', 'Today: level / fish per cast'], TIERS.map((t) => {
			const p = pt[t];
			return [`T${t}`, n0(p.combos), p.level, p.homeBiome, rng3(p.meanFish, (x) => x.toFixed(2)), rng(p.xpPerHour, n0), rng(p.cashPerHour, n0), rng(p.cashVsReference, (x) => pct(x, 0)), rng(p.lifeHoursRegular, (x) => x.toFixed(2)), rng(p.upkeepShareHome, (x) => pct(x)), `Lv ${rng(p.legacyLevel, (x) => x)} / ${rng(p.legacyFishPerCast, (x) => x)}`];
		})),
		'',
		'Stat spread (min–max over each tier\'s combinations):',
		'',
		mdTable(['Tier', 'Rare Find', 'Luck', 'Trophy', 'Speed', 'Sell', 'P(3+ fish)'], TIERS.map((t) => {
			const p = pt[t];
			const f = (x) => String(+x.toFixed(3));
			return [`T${t}`, rng(p.rareFind, f), rng(p.luck, f), rng(p.trophyChance, f), rng(p.fishingSpeed, f), rng(p.sellBonus, f), rng(p.jackpot3plus, (x) => pct(x))];
		})),
		'',
		`- **Mixed rods are weaker than matched ones:** the weakest T4 combination earns ${pct(pt[4].cashVsReference.min, 0)} of the full Legendary set's $/h.`,
		'- **No bypass** (`report().combos.bestAtLevel`): the best rod usable at each level.',
		'',
		mdTable(['Level', 'Today (fish per cast)', 'Proposed (mean fish)', 'Proposed best $/h (that level\'s biome)'], Object.entries(R.combos.bestAtLevel).map(([lv, b]) => [`Lv ${lv}`, b.todayFishPerCast, b.proposedMeanFish.toFixed(2), usd(b.proposedBestCashPerHour)])),
	].join('\n');

	// Gear path (the standard ladder: the reference) and hourly rates (standard + custom sets).
	const biomes = Object.keys(R.rates[0].byBiome);
	const rateOf = (name) => R.rates.find((r) => r.name === name);
	out['rods-gear-path'] = [
		mdTable(['Step', 'Level', 'Price', 'Home biome', 'Fish/cast', 'P(3+)', 'P(5)', 'Cooldown', 'Rare Find / Luck / Trophy / Speed / Sell', 'Durability (h, regular)', 'Repair', 'Upkeep at home'], gp.map((s) => [
			s.tier === 0 ? 'Old Rod (starter)' : `**${s.name}** (${s.label.match(/, (\w+)\)$/)?.[1] || s.kind})`, s.level, s.tier === 0 ? 'free' : `**${usd(s.price)}**`, s.homeBiome, s.meanFish.toFixed(2), pct(s.jackpot3plus), pct(s.jackpot5, 2), `${(s.cooldownMs / 1000).toFixed(2)} s`,
			s.tier === 0 ? 'none' : statsLine(s.stats), s.maxDurability ? `${n0(s.maxDurability)} (${hrs(s.lifeHoursRegular)})` : 'unbreakable', s.repairCost ? usd(s.repairCost) : '—', s.tier === 0 ? '—' : pct(s.upkeepShareHome),
		])),
		'',
		`The reference gear path (\`F.gearPath()\`, ladder \`${F.GEAR_PATH_LADDER}\`). Custom sets (the Rod Workshop) are in the custom-vs-standard table. Hourly rates by biome (\`report().rates\`, normal profile, ${F.DESIGN_OVERHEAD_S} s overhead; **bold** = the rod's home biome):`,
		'',
		mdTable(['Rod', 'XP/h', ...biomes.map((b) => `${b} $/h`)], R.rates.map((r) => {
			const xp = Object.values(r.byBiome).map((x) => x.xpPerHour);
			return [r.tier === 0 ? 'Old Rod' : r.kind === 'custom' ? `${r.name} (custom)` : r.name, minMax(xp, n0), ...biomes.map((b) => (r.homeBiome === b && r.tier > 0 ? `**${n0(r.byBiome[b].cashPerHour)}**` : n0(r.byBiome[b].cashPerHour)))];
		})),
	].join('\n');

	// Upkeep.
	const bIdx = (b) => biomes.indexOf(b);
	const stdUpkeep = R.upkeep.byTierHome.filter((u) => u.kind === 'standard');
	const belowHome = stdUpkeep.map((u) => rateOf(u.name).byBiome[biomes[bIdx(u.homeBiome) - 1]].upkeepShare);
	const oceanMax = Math.max(...R.upkeep.byTierHome.map((u) => rateOf(u.name).byBiome.Ocean.upkeepShare));
	const topStd = stdUpkeep[stdUpkeep.length - 2];
	const topOcean = rateOf(topStd.name).byBiome.Ocean;
	out['rods-upkeep'] = [
		mdTable(['Rod', 'Repair', 'Every (regular play)', 'Repair = minutes of home income', ...biomes], R.upkeep.byTierHome.map((u) => [
			u.kind === 'custom' ? `${u.name} (custom)` : u.name, usd(u.repairCost), hrs(u.lifeHoursRegular), u.repairCostInMinutesOfHomeIncome.toFixed(1),
			...biomes.map((b) => (u.homeBiome === b ? `**${pct(rateOf(u.name).byBiome[b].upkeepShare)}**` : pct(rateOf(u.name).byBiome[b].upkeepShare))),
		])),
		'',
		`- **One biome below home (standard):** ${minMax(belowHome, (x) => pct(x))}. **High gear in Ocean:** up to ${pct(oceanMax)} of gross income; the ${topStd.name} in Ocean still nets ${usd(topOcean.cashPerHour * (1 - topOcean.upkeepShare))}/h, ${((topOcean.cashPerHour * (1 - topOcean.upkeepShare)) / R.rates[0].byBiome.Ocean.cashPerHour).toFixed(1)}× the Old Rod (which costs nothing there). Tackle Care (upgrades.md) lowers every row by up to ${pct(require('./upgrades').statsFor({ tackleCare: require('./upgrades').PARAMS.levels }).durabilityEfficiency, 0)}.`,
		`- **What the unbreakable Old Rod gives up:** today's repair (${usd(T.oldRod.repairCost)} per ${n0(T.oldRod.maxDurability)} fish) as a share of Old Rod income under the proposed value model: ${biomes.map((b) => `${b} ${pct(R.upkeep.oldRodLegacyRepairShare[b])}`).join(', ')}.`,
	].join('\n');

	// Standard ladder: prices, stage income and time to afford by archetype.
	out['rods-standard'] = [
		mdTable(['Rod', 'Role', 'Unlock (listed from)', 'Price', '= hours of stage income (stage)', 'Home $/h (vs previous rod there)', 'Home XP/h', ...PLAYERS.map((k) => `${k}: h (sessions) to afford`)], ST.map((r) => [
			`**${r.name}**`, r.role, `Lv ${r.level} (Lv ${r.previewLevel})`, `**${usd(r.price)}**`, `${r.priceHours} (${r.stageBiome}, ${usd(r.stageIncomePerHour)}/h)`, `${usd(r.homeCashPerHour)} (${rel(r.homeCashVsPrevious)})`, n0(r.homeXpPerHour),
			...PLAYERS.map((k) => `${r.timeToAfford[k].hours.toFixed(2)} (${r.timeToAfford[k].sessions.toFixed(1)})`),
		])),
		'',
		'Time to afford = price ÷ the archetype\'s own net $/h (previous rod in the stage biome, after repairs), from $0. In the integrated run every archetype already holds the money on reaching the level (timing table).',
	].join('\n');

	// Custom vs standard at each level, and the custom builds.
	out['rods-custom-relation'] = [
		mdTable(['Level (biome)', 'Standard rod', 'Custom set', 'Fish/cast', 'Rare Find / Luck / Trophy / Speed / Sell', 'Net $/h at home', 'XP/h', 'Cost', 'Life (h)', 'Payback of the extra cost'], CR.map((c) => [
			`Lv ${c.level} (${c.biome})`, c.standard, c.custom,
			`${c.meanFish.standard.toFixed(2)} → **${c.meanFish.custom.toFixed(2)}**`, `${statsLine(c.stats.standard)} → ${statsLine(c.stats.custom)}`,
			`${usd(c.netCashPerHour.standard)} → **${usd(c.netCashPerHour.custom)}** (${rel(c.netCashPerHour.custom / c.netCashPerHour.standard)})`, `${n0(c.xpPerHour.standard)} → ${n0(c.xpPerHour.custom)} (${rel(c.xpPerHour.custom / c.xpPerHour.standard)})`,
			`${usd(c.cost.standard)} → E ${usd(c.cost.customExpected)}, P90 ${usd(c.cost.customP90)}, net of salvage ${usd(c.cost.customNetOfSalvage)} (${c.cost.crates.toFixed(2)} × ${c.cost.crate})`,
			`${c.life.standard.toFixed(1)} → ${c.life.custom.toFixed(1)}`, c.paybackHours > 0 ? hrs(c.paybackHours) : 'immediate',
		])),
		'',
		`Rule: at every level the balanced custom set carries ${minMax(CR.map((c) => c.meanFish.custom - c.meanFish.standard), (x) => `+${x.toFixed(2)}`)} fish per cast and more Rare Find, Luck and Trophy than the standard rod, costs ${minMax(CR.map((c) => c.cost.customNetOfSalvage / c.cost.standard), times)} as much net of salvage (with crate variance), and earns ${minMax(CR.map((c) => c.netCashPerHour.custom / c.netCashPerHour.standard), (x) => rel(x))} net $/h. Standard rods are the generalists (a little faster, sturdier at Lv 20); custom is the optimisation path. The integrated custom variant reaches Lv 50 in ${hrs(L.customVariant.regular.reached[50].hours)} (standard ${hrs(reg.reached[50].hours)}) for the regular player.`,
	].join('\n');
	const BUILD_NAMES = Object.keys(R.customBuilds[0].builds);
	out['rods-custom-builds'] = [
		'Best catalog combination for each goal, per custom tier (every combination of that tier; `report().customBuilds`). Figures against the standard rod of the same level in its home biome:',
		'',
		mdTable(['Tier (level)', ...BUILD_NAMES], R.customBuilds.map((t) => [
			`T${t.customTier} (Lv ${t.level}) vs ${t.standard}`,
			...BUILD_NAMES.map((n) => {
				const b = t.builds[n];
				return `${b.parts.join(' + ')}: ${b.meanFish.toFixed(2)} fish, ${statsLine(b.stats)}, ${b.lifeHoursRegular.toFixed(1)} h life; $/h ${rel(b.cashVsStandard)}, XP/h ${rel(b.xpVsStandard)}`;
			}),
		])),
		'',
		'Stats column order: Rare Find / Luck / Trophy / Speed / Sell. Bait Efficiency is not a rod-part stat in this design (the Bait Conservation upgrade carries it; a bait-saving part variant is an open option).',
	].join('\n');
	out['rods-level-rule'] = mdTable(['Highest part rarity', 'Combinations', 'Today: inherited requirement (all combinations)', 'Today: a matched set of that rarity', 'Proposed requirement'], R.levelRule.map((x) => [
		x.rarity, n0(x.combos), `Lv ${rng3(x.todayLevel, (v) => v)}`, x.matchedTodayLevel ? `Lv ${rng(x.matchedTodayLevel, (v) => v)}` : '—', `**Lv ${x.proposed}**`,
	]));

	// Crates.
	const featured = R.crates[0].featured;
	const pityText = (p) => (p ? Object.entries(p).map(([k, v]) => `${k}: soft ${v.softStart}, +${v.rampPerCast}/open, max +${v.maxBonus}, hard ${v.hard}`).join('; ') : '—');
	const above = (t) => (t < TIERS.length ? lower(PARAMS.referenceRarity[t + 1]) : null);
	out['rods-crates'] = [
		`Every crate: ${PARAMS.crates.slots} slots, \`${PARAMS.crates.strategy}\` rolls, \`duplicates: '${PARAMS.crates.duplicates}'\`, a pool of \`types: [${Object.values(SLOTS).join(', ')}]\` with \`fish: false\`.`,
		'',
		`Slot-balancing \`featured\` groups (\`slotBalanceFeatured()\`): ${featured.map((g) => `**weight ${g.weight}:** ${g.names.join(', ')}`).join('; ')}.`,
		'',
		mdTable(['Tier', 'Crate', 'Unlock (shop)', 'rarityTable', 'rarityFloor', 'guaranteedSlots', 'Pity', 'Price'], R.crates.map((c) => [
			`T${c.tier}`, `${c.name}${c.existingItem ? ' (existing item, redefined)' : ' (new)'}`, `Lv ${c.unlockLevel}`,
			Object.entries(c.rarityTable).filter(([, w]) => w > 0).map(([r, w]) => `${r} ${w}`).join(', '), c.rarityFloor || '—',
			c.guaranteedSlots.length ? c.guaranteedSlots.map((g) => `slot ${g.slot} ≥ ${g.minRarity}`).join(', ') : '—', pityText(c.pity), `**${usd(c.price)}**`,
		])),
		'',
		'Chance per crate slot of a part above the tier\'s reference rarity (`crateSlotOdds`; T5 has none above it):',
		'',
		mdTable(['Crate', 'Rarity', 'Slot 0', 'Slot 1', 'Slot 2'], R.crates.filter((c) => above(c.tier)).map((c) => [c.name, above(c.tier), ...c.slotOdds.map((s) => pct(s.rarity[above(c.tier)] || 0))])),
	].join('\n');

	// Assembly.
	const e1 = R.entryT1;
	out['rods-assembly'] = [
		mdTable(['Tier', 'Crate', 'Price', 'Stage before (biome, $/h)', 'Needs', 'E[crates]', 'Median', 'P90', 'E[cost]', 'Hours of stage income (P90)', 'Leftover parts', 'Salvage refund', 'Net after salvage'], asm.map((a) => {
			const pity = R.crates[a.tier - 1].pity;
			return [`T${a.tier}`, a.crate, usd(a.price), `${a.stageBiome}, ${usd(a.stageIncomePerHour)}`, a.needs.length === 4 && new Set(a.needs.map((x) => x.split(' ')[0])).size === 1 ? `4 × ${a.needs[0].split(' ')[0]}` : a.needs.join(', '),
				a.expectedCrates.toFixed(2), a.medianCrates, `${a.p90Crates}${pity ? ` (hard pity: ${Object.values(pity)[0].hard})` : ''}`, usd(a.expectedCost), `${a.hoursOfStageIncome.toFixed(2)} (${a.p90HoursOfStageIncome.toFixed(2)})`,
				a.leftoverParts.toFixed(1), usd(a.salvageRefund), usd(a.netCostAfterSalvage)];
		})),
		'',
		`- **Budget T1** (a Common-or-better part in every slot, ${e1.meanFish.toFixed(2)} fish): ${e1.expectedCrates.toFixed(2)} crates (P90 ${e1.p90Crates}), ${usd(e1.expectedCost)}, ${e1.hoursOfStageIncome.toFixed(2)} h of stage income.`,
		`- **Totals (T1–T5):** ${usd(asm.reduce((s, a) => s + a.expectedCost, 0))} of expected assemblies; salvaging every leftover returns ${usd(asm.reduce((s, a) => s + a.salvageRefund, 0))}.`,
	].join('\n');

	// Engine validation (recorded run).
	const ev = R.engineValidation;
	out['rods-engine-validation'] = [
		mdTable(['Crate', 'Exact E[crates] (live)', 'Exact at the run', 'Engine mean ± SE', 'z', 'Completed sets'], ev.crates.map((c) => [
			PARAMS.crates.tiers[c.tier].name, ev.exactNow[c.tier].toFixed(4), c.exactAtRun.toFixed(4), `${c.engine.toFixed(4)} ± ${c.se.toFixed(4)}`, (c.z < 0 ? '−' : '') + Math.abs(c.z).toFixed(2), n0(c.completions),
		])),
		'',
		`Recorded run: ${ev.opens.toLocaleString('en-US')} opens per crate at framework ${ev.framework}; largest |z| ${Math.max(...ev.crates.map((c) => Math.abs(c.z))).toFixed(2)}. ${ev.crates.every((c) => Math.abs(ev.exactNow[c.tier] - c.exactAtRun) < 1e-4) ? 'The live exact values equal the values at the run, so the recorded engine sample still applies.' : '**The live exact values differ from the values at the run: rerun validateCratesWithEngine().**'}`,
	].join('\n');

	// Salvage.
	out['rods-salvage'] = [
		mdTable(['Rarity', ...RARITY_ORDER], [['Salvage value', ...RARITY_ORDER.map((r) => usd(R.salvage[r]))]]),
		'',
		mdTable(['Tier crate', 'Full-crate salvage (share of price)', 'Salvage refund per assembly', 'Net assembly cost reduction'], asm.map((a) => [`T${a.tier} ${a.crate}`, pct(a.salvageReturnPerCrate), usd(a.salvageRefund), pct(a.salvageRefund / a.expectedCost)])),
	].join('\n');

	// Legacy converter.
	const lc = R.legacyConverter;
	const S = lc.samples;
	out['rods-converter'] = [
		mdTable(['Converter calibration (all combinations)', 'Value'], [
			['Legacy fingerprints / unique', `${n0(lc.signatures)} / ${n0(lc.uniqueSignatures)}`],
			['Path B tier recovered exactly / lower / higher', `${pct(lc.signatureTierExact)} / ${pct(lc.signatureTierUnder)} / ${pct(lc.signatureTierOver)}`],
			['Path B power over-estimated', pct(lc.signaturePowerOver)],
			['Legacy max durability ÷ proposed (min–median–max)', rng3(lc.grandfathered.durabilityRatio, (x) => `${+x.toFixed(2)}×`)],
			['Upkeep at home with grandfathered durability (min–median–max)', rng3(lc.grandfathered.upkeepShareHome, (x) => pct(x))],
		]),
		'',
		`Worked example (\`report().legacyConverter.samples\`): today's rod from ${S.stored.parts.join(' + ')}.`,
		'',
		mdTable(['', 'Today (stored)', `Proposed (Path A${S.pathA.tier === S.pathB.tier && S.pathA.meanFish === S.pathB.meanFish ? ' and Path B agree' : ''})`], [
			['Capabilities', `\`${JSON.stringify(S.stored.capabilities)}\``, 'unchanged (read only)'],
			['Level requirement', `Lv ${S.stored.legacyLevel}`, `Lv ${S.pathA.level} (T${S.pathA.tier})`],
			['Fish per cast', S.stored.legacyFishPerCast, S.pathA.meanFish.toFixed(2)],
			['Stats', 'none beyond the capabilities', `Rare Find ${pct(S.pathA.stats.rareFind, 0)}, Luck ${pct(S.pathA.stats.luck, 0)}, Trophy ${pct(S.pathA.stats.trophyChance, 0)}, Speed ${pct(S.pathA.stats.fishingSpeed, 0)}, Sell ${pct(S.pathA.stats.sellBonus, 0)}`],
			['Durability', `${S.stored.durability}, \`${S.stored.state}\``, `kept (${n0(S.pathA.durability.max)} max), \`${S.pathA.state}\` and repairable`],
			['Repair', `${usd(S.stored.legacyRepairCost)}, max ${T.crafted.maxRepairs}`, `${usd(S.pathA.repairCost)}, ${S.pathA.repairs}`],
		]),
		'',
		`Level cap example: a Lv ${S.levelCap.playerLevel} player with a ${S.levelCap.rod} gets a ${Object.values(S.levelCap.performsAs)[0]}-set rod (${S.levelCap.meanFish.toFixed(2)} fish, ${statsLine(S.levelCap.stats)} Rare Find / Luck / Trophy / Speed / Sell); the rod still shows Lv ${S.levelCap.requirementShown}.`,
	].join('\n');

	// Integrated lifecycle.
	const cell = (v, lv) => (v.reached[lv] ? `${hrs(v.reached[lv].hours)} (d${v.reached[lv].day})` : '—');
	const milestoneLevels = Object.keys(reg.reached).map(Number).sort((a, b) => a - b);
	const rodAtLevel = Object.fromEntries(refs.map((s) => [s.level, s.name]));
	out['rods-lifecycle'] = [
		mdTable(['Player', ...milestoneLevels.map((lv) => `Lv ${lv}${rodAtLevel[lv] ? ` (${rodAtLevel[lv]})` : ''}`), 'Rod start after its level', 'Repairs / fishing income', 'Rods / all income', 'Upgrades / all income', 'Saved at Lv 60 (share of all income)'], PLAYERS.map((k) => {
			const v = L.archetypes[k];
			return [k === F.REFERENCE_ARCHETYPE ? `**${k}**` : k, ...milestoneLevels.map((lv) => cell(v, lv)), v.maxTierDelayHours === 0 ? '0 h (every rod)' : v.maxTierDelayHours === null ? 'a rod not reached' : `up to ${hrs(v.maxTierDelayHours)}`,
				pct(v.totals.repairShare), pct(v.totals.rodShareOfIncome), pct(v.totals.upgradeShareOfIncome), `${usd(v.totals.saved)} (${pct(v.totals.savedShare, 0)})`];
		})),
		'',
		mdTable(['Regular player', ...regWindows.map(([lv]) => `Lv ${lv}`)], [
			['Approved window', ...regWindows.map(([, w]) => `${w.window[0]}–${w.window[1]} h`)],
			[`Reference: standard rods + upgrades (framework ${R.frameworkVersion}, locked quartic ${R.curve.quartic})`, ...regWindows.map(([, w]) => `${hrs(w.hours)} ${w.ok ? '(in)' : '**(OUT)**'}`)],
			['Never buys an upgrade', ...Object.values(L.noUpgrades.regular.targets).map((w) => `${hrs(w.hours)} ${w.ok ? '(in)' : '**(OUT)**'}`)],
			['Custom rods (Rod Workshop from Lv 20) + upgrades', ...Object.values(L.customVariant.regular.targets).map((w) => `${hrs(w.hours)} ${w.ok ? '(in)' : '(out)'}`)],
			['5b.4 ladder (crafted T1–T5, no upgrades) on today\'s model', ...Object.values(L.ladder5b4.regular.targets).map((w) => `${hrs(w.hours)} ${w.ok ? '(in)' : '(out)'}`)],
		]),
	].join('\n');

	// Purchase timing by archetype and affordability.
	const delayCell = (d) => {
		const late = Object.entries(d).filter(([, x]) => x === null || x > 0);
		return late.length ? late.map(([t, x]) => (x === null ? `${gp[t].name} after Lv ${F.LIFECYCLE.maxLevel}` : `${gp[t].name} +${x.toFixed(1)} h`)).join(', ') : 'none';
	};
	const shares = Object.keys(L.stressDelays[PLAYERS[0]]);
	const variants = Object.keys(L.variantMaxDelay[PLAYERS[0]]);
	out['rods-affordability'] = [
		mdTable(['Rod', 'Stage (regular)', 'Hours in stage', 'Income earned in the stage (all sources)', 'of which fishing', 'Price', 'Share of stage income', 'Share of stage fishing income'], L.rodShareOfStage.filter((s) => s.stage).map((s) => [
			s.name, s.stage, hrs(s.hours), usd(s.income), usd(s.fishing), usd(s.cost), pct(s.shareOfIncome), pct(s.shareOfFishing),
		])),
		'',
		'When each standard rod is bought (integrated reference loop; hours of play, gate level) and when it starts fishing:',
		'',
		mdTable(['Player', ...refs.map((s) => `${s.name} (Lv ${s.level})`)], PLAYERS.map((k) => {
			const v = L.archetypes[k];
			return [k, ...refs.map((s) => (v.bought[s.tier] && v.equips[s.tier] ? `${hrs(v.bought[s.tier].hours)} (d${v.bought[s.tier].day}, Lv ${v.bought[s.tier].level}) → ${hrs(v.equips[s.tier].hours)}` : 'after Lv 60'))];
		})),
		'',
		'Longest wait between reaching a rod\'s level and fishing it, per variant (integrate.run `variant`; every other system as in the reference loop):',
		'',
		mdTable(['Player', ...variants], PLAYERS.map((k) => [k, ...variants.map((n) => {
			const d = L.variantMaxDelay[k][n];
			return d === null ? 'a rod not reached' : d === 0 ? 'none' : hrs(d);
		})])),
		'',
		'Stress probe: the reference loop plus a share of every step\'s fishing income spent on purchases outside the model; rods that then wait for cash:',
		'',
		mdTable(['Player', ...shares.map((sh) => `${pct(Number(sh), 0)} of fishing income`)], PLAYERS.map((k) => [k, ...shares.map((sh) => delayCell(L.stressDelays[k][sh]))])),
	].join('\n');

	// 5b.4 -> 5b.5 delta (numbers that moved).
	const R4 = R.record5b4;
	const L4 = L.ladder5b4;
	const shareRange = (f) => minMax(PLAYERS.map(f), (x) => pct(x));
	const levelFish = (lv) => F.tierAt(lv, F.gearPath()).meanFish;
	out['rods-delta'] = mdTable(['Number', `5b.4 (published record, digest ${R4.digest})`, '5b.4 ladder on today\'s model', `5b.5 (${R.frameworkVersion}, reference)`], [
		['Reference gear', 'Old Rod + crafted T1–T5 (crate assemblies)', 'same', `Old Rod + ${refs.length} standard shop rods; custom sets optional`],
		['First rod upgrade', `Lv ${R4.firstRodLevel}`, `Lv ${R4.firstRodLevel}`, `Lv ${refs[0].level} (${refs[0].name})`],
		['Fish per cast at Lv 0/10/20/30/40/50/60', Object.values(R4.fishPerCast).map((x) => x.toFixed(2)).join(' / '), Object.values(R4.fishPerCast).map((x) => x.toFixed(2)).join(' / '), [0, 10, 20, 30, 40, 50, 60].map((lv) => levelFish(lv).toFixed(2)).join(' / ')],
		['Rod cost at Lv 20/30/40/50/60', Object.values(R4.rodCosts).map(usd).join(' / '), R.crafted5b4Path.slice(1).map((x) => usd(x.cost)).join(' / '), refs.slice(1).map((x) => usd(x.price)).join(' / ')],
		['Regular hours to Lv 20/30/40/50', [20, 30, 40, 50].map((lv) => R4.regularHours[lv].toFixed(2)).join(' / '), [20, 30, 40, 50].map((lv) => L4.regular.reached[lv].hours.toFixed(2)).join(' / '), [20, 30, 40, 50].map((lv) => reg.reached[lv].hours.toFixed(2)).join(' / ')],
		['Regular hours to Lv 60', R4.regularHours[60].toFixed(2), L4.regular.reached[60].hours.toFixed(2), reg.reached[60].hours.toFixed(2)],
		['Upkeep (repairs) / all income, to Lv 60', `${pct(R4.upkeepShare[0])}–${pct(R4.upkeepShare[1])}`, shareRange((k) => L4[k].totals.repairShareOfIncome), shareRange((k) => L.archetypes[k].totals.repairShareOfIncome)],
		['Progression (rods + permits) / all income', `${pct(R4.progressionShare[0])}–${pct(R4.progressionShare[1])}`, shareRange((k) => L4[k].totals.categoryShares.progression), shareRange((k) => L.archetypes[k].totals.categoryShares.progression)],
		['Upgrades / all income', '—', '—', shareRange((k) => L.archetypes[k].totals.upgradeShareOfIncome)],
		['Saved at Lv 60 / all income', `${pct(R4.savedShare[0])}–${pct(R4.savedShare[1])}`, shareRange((k) => L4[k].totals.savedShare), `${shareRange((k) => L.archetypes[k].totals.savedShare)} (no upgrades: ${shareRange((k) => L.noUpgrades[k].totals.savedShare)})`],
		['Crafting level requirement (four Commons)', 'Lv 20 (Common part level)', '—', `Lv ${PARAMS.partLevel.Common}`],
		['Owned Fishing Crates at release', 'proposed (a): open as the T1 crate', '—', 'user choice (b): legacyCount, old definition first'],
	]);

	// Shop mock: the Rods tab and the Rod Workshop with the modelled prices (layout in §5).
	const up = UR.table;
	out['rods-shop-mock'] = [
		'```text',
		'┌ 🎣 Shop · Rods ─────────────────────────────── (ephemeral; only the invoker can click) ┐',
		'│ Your rod: Trusty Rod · Lv 14 · $12,400                                                  │',
		...refs.map((s) => `│ ${s.level <= 14 ? (s.level <= 10 ? '✅ owned  ' : '🛒 buy    ') : s.level <= 20 ? '🔒 Lv ' + String(s.level).padEnd(3) : '   ·     '} ${s.name.padEnd(16)} ${usd(s.price).padStart(10)}  ${s.meanFish.toFixed(2)} fish · ${statsLine(s.stats)}`.padEnd(92) + '│'),
		'│ Next: Angler\'s Rod at Lv 20 · you are $' + n0(Math.max(0, refs[1].price - 12400)) + ' away                                           │',
		'└──────────────────────────────────────────────────────────────────────────────────────────┘',
		'[Rods] [Bait] [Upgrades] [Supplies] [Aquarium] [Special]      ← category buttons (empty ones hidden)',
		'[▼ Select a rod to buy…  (only rods at or below your level; greyed preview one stage early)]',
		'[🔧 Rod Workshop]',
		'',
		'┌ 🎣 Shop · Upgrades ─────────────────────────────────────────────────────────────────────┐',
		...up.map((u) => `│ ${u.name.padEnd(18)} L1 ${usd(u.prices[0]).padStart(7)} → L${U.PARAMS.levels} ${usd(u.prices[U.PARAMS.levels - 1]).padStart(8)}  +${pct(u.perLevel, 1)} ${u.stat}/level`.padEnd(92) + '│'),
		'└──────────────────────────────────────────────────────────────────────────────────────────┘',
		'```',
	].join('\n');

	// Parity record.
	const P = R.integration.parity;
	out['rods-parity'] = mdTable(['Parity record (constant; the old loop is deleted)', 'Value'], [
		['Source', `\`validateSystem()\` at commit ${P.commit} (framework ${P.framework})`],
		['Method', P.method],
		['Cases', P.cases],
		['Max relative difference (tolerance)', `${pct(P.maxRelativeDifference, 2)} (${pct(P.tolerance, 1)}); worst: ${P.worst}`],
		['Milestones on the same step', P.exactMilestones],
		['Largest tier-start shift', `${P.maxEquipShiftSteps} steps`],
		['Replay with the old equip timing', `${P.replay.exactMilestones} milestones, max difference ${pct(P.replay.maxRelativeDifference, 0)}: ${P.replay.exact ? 'exact' : 'not exact'}`],
		['Cause of every difference', P.cause],
	]);

	// Owned and pre-release Fishing Crates (P-RODS-FISHING-CRATE: user choice (b)).
	const paid = LCR.today.price;
	const [optA, optB, optC] = LCR.options;
	const baitNote = (o, text) => (o.plusBait ? `${text} + its bait` : text);
	out['rods-legacy-crate'] = [
		`Today's catalog row (\`src/bootstrap/data/gacha.js\`, read at render time): **Fishing Crate ${usd(paid)}**, \`shopItem: ${LCR.today.shopItem}\` (delisted by hotfix L5), ${LCR.today.level ? `Lv ${LCR.today.level}` : 'no level requirement'}. New T1 part crate after release: **${usd(LCR.t1.price)}** from Lv ${LCR.t1.unlockLevel}; one open's expected salvage is ${usd(LCR.t1.salvagePerOpen)} (${pct(LCR.t1.salvageShareOfPrice)} of that price).`,
		'',
		mdTable(['Owned-stock option (`P-RODS-FISHING-CRATE`)', `A crate bought at ${usd(paid)} opens as`, 'Expected salvage per crate', `Salvage ÷ ${usd(paid)} paid`, 'Gain per crate', 'Rare+ parts per crate', `${usd(LCR.moneyUnit)} of today's money: crates → expected salvage`], LCR.options.map((o) => [
			`(${o.key}) ${o.label}`, o.key === 'c' ? `${o.priceRatio.toFixed(3)} of a T1 part crate` : o.opensAs, baitNote(o, usd(o.salvagePerCrate)), times(o.salvageShareOfPaid),
			baitNote(o, signedUsd(o.gainPerCrate)), o.rarePlusPartsPerCrate.toFixed(3), baitNote(o, `${n0(o.perMoneyUnit.crates)} → ${usd(o.perMoneyUnit.salvage)}`),
		])),
		'',
		`- **What runs (user choice (b)):** at the 5B migration each owned Fishing Crate stack gets an additive \`legacyCount\` (= its count then, set once, idempotent). \`/open\` consumes legacy units first and opens them under today's definition (bait + parts, today's table): ${usd(optB.salvagePerCrate)} of expected part salvage per crate, ${times(optB.salvageShareOfPaid)} the price paid, plus its bait. They are never converted and never open as the ${usd(LCR.t1.price)} T1 part crate; units acquired after release open under the new definition.`,
		`- **Why not (a):** a crate bought at ${usd(paid)} would open as the T1 part crate and return ${times(optA.salvageShareOfPaid)} its price (${signedUsd(optA.gainPerCrate)} per crate): a T1 set from stock bought at today's price costs ${LCR.t1Set.expectedCrates.toFixed(2)} × ${usd(paid)} = ${usd(LCR.t1Set.atTodayPrice)}, ${pct(LCR.t1Set.atTodayPrice / LCR.t1Set.atProposedPrice)} of the ${usd(LCR.t1Set.atProposedPrice)} assembly. **Why not (c):** ${optC.exchange} owned crates per T1 open (${times(optC.exchangeSalvagePerCrate / paid)} per crate) converts what the player bought.`,
		`- **Delisting (hotfix L5) stops new stock**, so the owned stock at migration is final. The catalog sync (§13) relists the name as the T1 crate at ${usd(LCR.t1.price)} and Lv ${LCR.t1.unlockLevel}; the startup assertion stops a deploy whose row still says ${usd(paid)}.`,
	].join('\n');

	// Release catalog sync and startup assertion (§13).
	const CS = R.catalogSync;
	const fieldValue = (kind, x) => {
		if (x === null || x === undefined) return kind === 'level' ? 'no requirement' : 'absent';
		if (kind === 'usd') return usd(x);
		if (kind === 'level') return x ? `Lv ${x}` : 'no requirement';
		if (kind === 'list') return x.join(', ');
		return String(x);
	};
	const assertionCell = (kind, { value, expected }) => {
		const pass = kind === 'share' ? value < expected : value === expected;
		const shown = kind === 'share' ? `${pct(value)} of the price charged` : fieldValue(kind, value);
		return `${shown}: ${pass ? 'pass' : '**fail**'}`;
	};
	out['rods-catalog-sync'] = [
		mdTable(['Catalog row (`user: null`)', 'Field', 'Today (seed data, read at render time)', `After the sync (\`catalogRevision: '${CS.marker.catalogRevision}'\`)`, 'Source'], [
			...CS.updates.map((u) => [u.row, `\`${u.field}\``, fieldValue(u.kind, u.today), fieldValue(u.kind, u.after), u.source]),
			...CS.inserts.map((x) => [x.row, 'new row', 'absent', `inserted by the seed: \`price\` ${usd(x.price)}, \`requirements.level\` ${x.level}, \`shopItem\` ${x.shopItem}`, x.row.endsWith('(type rod)') ? 'standardRod(t).price, its level' : 'cratePrice(t), unlock level']),
			[`${PARAMS.crates.tiers[1].name}, Old Rod`, '`catalogRevision`', 'absent', `\`'${CS.marker.catalogRevision}'\``, 'the guard: rows that carry it are skipped'],
		]),
		'',
		mdTable(['Startup assertion (bootstrap `validate()`, after the sync)', 'Synced catalog', 'Today\'s row (sync skipped)'], CS.assertions.map((a) => [a.check, assertionCell(a.kind, a.synced), assertionCell(a.kind, a.stale)])),
	].join('\n');

	// Decisions for approval.
	out['rods-decisions'] = mdTable(['ID', 'Proposed decision', 'Modelled', 'Alternatives', 'Why', 'Record = model'], DECISIONS.map((d) => [
		`\`${d.id}\``, d.title, typeof d.modelled === 'string' ? d.modelled : `\`${JSON.stringify(d.modelled)}\``, d.alternatives.join('; '), d.why,
		d.get ? (JSON.stringify(d.get()) === JSON.stringify(d.expected) ? 'yes' : '**NO**') : 'n/a (not a model value)',
	]).map((row) => row.map((c) => String(c).replace(/\|/g, '\\|')))) + `\n\nStatus of every entry: \`${[...new Set(DECISIONS.map((d) => d.status))].join(', ')}\`. Only the user approves; \`decisions.js\` joins these to the Phase 5B registry and \`check-shared.js\` verifies each record against the model.`;

	return out;
}

module.exports = {
	PARAMS, RARITY_ORDER, SLOTS, CATALOG, ARCHETYPES, TARGETS, SYSTEM_DEFAULTS, SYSTEM_PARITY, ENGINE_VALIDATION, DECISIONS,
	tierLevel, homeBiome, stageBiome, capRarity, partProfile, matchedSet, referenceSet, performance, craftRod, oldRod,
	rodOutcome, rodHourly, upkeepShare, baseDurability, repairCostFor,
	legacyCombine, legacyCraft, verifyLegacyParity, legacySignature, convertLegacyRod, evaluateAllCombos,
	crateDefinition, crateDefinitions, crateSlotOdds, openOutcomes, cratesDistribution, validateCratesWithEngine, cratePrice, stageIncome, assembly, salvageValue, slotBalanceFeatured,
	crateOpenValue, legacyCrate, catalogSync, legacyDurability,
	gearPath, customPath, LADDERS, STANDARD_TIERS, standardRod, standardRods, assemblyPlan, lifecycle, system, report, markdownTables,
};

if (require.main === module) {
	process.stdout.write(JSON.stringify(report(), null, 1));
}
