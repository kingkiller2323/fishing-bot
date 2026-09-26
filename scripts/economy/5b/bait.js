// Phase 5B · Bait redesign and reprice (framework 5b.4). ANALYSIS ONLY: nothing here touches the live game.
//
// Bait is a SYSTEM on the shared lifecycle core (lifecycle.js, composed by integrate.js). This module never
// steps time: every per-cast number comes from the framework's castOutcome(), and every number over a
// player's lifecycle comes from integrate.run() (the reference core loop: rods, world, quests, streak,
// buffs) with variant.bait 'cash' | 'xp' against 'none'. Only design parameters are hard-coded (PARAMS);
// every non-obvious choice in them is a PROPOSED decision in DECISIONS (only the user approves).
// docs/economy/5b/bait.md's tables are generated from markdownTables() by render-docs.js.
//
//   node scripts/economy/5b/bait.js              prints report() as JSON
//   node scripts/economy/5b/render-docs.js       fills docs/economy/5b/bait.md from markdownTables()
//
// Exports
//   PARAMS, DECISIONS            design parameters; the proposed decisions (decisions.js shape, joined there)
//   STAGES, SHARED               stage ids (biome x tier of the shared gear path F.gearPath(): typical
//                                'ocean-old' .. 'swamp-t4', transitional 'lake-old' .. 'swamp-t3'); the gear view
//   withGear(gearPath, overrides)
//                                the per-cast model rebuilt on another rod path and/or with bait-definition
//                                overrides ({ baits: { [name]: { stats, multiChance } } }: sensitivity only,
//                                never a proposal). The functions below are withGear() on F.gearPath() + PARAMS:
//     stageGear(stage)           a stage (id, or { biome, tier | gear | qualities/stats/multiChance|meanFish,
//                                table, sellMult, xpMult }) as castOutcome input
//     baitEffect, prices, priceOf, evaluate, baitOption, baitMatrix, bandCheck, strongAccessByBiome,
//     stageRates, consumptionModel, chaseMetrics, boosterPackOdds, gachaBaitValue, currentVsProposed,
//     stageOptions               (see each function)
//   currentBaits()               today's catalog + measured Old Rod economics (measurements.json)
//   system(opts)                 the bait system (lifecycle.js hooks; see system())
//   lifecycle(policy, archetype, { model })
//                                one INTEGRATED lifecycle (integrate.run, reference loop + variant.bait
//                                policy): hours to each milestone, XP by source (the bait's share carved out of
//                                'fishing'), bait spend and extra value against income, baits used
//   lifecycleSensitivity()       every archetype x 'none'/'cash'/'xp', the approved windows (informational:
//                                they describe the no-bait reference player), the XP-bait guard and the
//                                XP-bait sizing sensitivity (xpSizing())
//   xpBaitGuard(model)           the XP-bait guard for every archetype: always-on XP bait is a net sink and
//                                reaches each milestone from Lv 20 at most maxXpBaitSpeedup sooner than the
//                                same archetype without bait (P-BAIT-XP-SIZING)
//   xpSizing()                   every archetype's always-on XP-bait run under alternative XP-bait sizings
//   RETIRED_LOOP_PARITY          the recorded parity of system() with the retired private loop (a83b5f0)
//   SYSTEM_NAME, SPEND_ITEM      'bait' and its one ledger item { category: 'optional', item: 'bait' }
//   report(opts), markdownTables()
const F = require('./framework');
const LC = require('./lifecycle');
const { PROFILES, BAIT_STATS } = require('../../../src/engine/balance');
const CURRENT_CATALOG = require('../../../src/bootstrap/data/bait');
const MEASURED = require('../../../docs/economy/measurements.json');
const GACHA_EV = require('../../../docs/economy/gacha-ev.json');
// integrate.js loads this module through its registry: required lazily.
const INTEGRATE = () => require('./integrate');

const deepFreeze = (o) => {
	for (const v of Object.values(o)) if (v && typeof v === 'object' && !Object.isFrozen(v)) deepFreeze(v);
	return Object.freeze(o);
};

// ---------------------------------------------------------------------------------------------
// Shared inputs: a view of the framework's shared gear path in the shape this module uses. Nothing here
// is a bait design choice and nothing is copied: the path is F.gearPath() (the rods design since R3).
const SHARED_PATH = F.gearPath();
const SHARED = deepFreeze({
	tiers: Object.fromEntries(SHARED_PATH.map((t) => [t.key, { level: t.level, mean: t.meanFish, ...(t.multiChance !== undefined ? { multiChance: t.multiChance } : {}), qualities: [...t.qualities], stats: { ...t.stats } }])),
	tierOrder: SHARED_PATH.map((t) => t.key),
	// The tier a player typically holds while fishing each biome (the tier unlocked at the biome's level).
	typicalTier: Object.fromEntries(F.LIVE_BIOMES.map((b) => [b, F.typicalTier(b, SHARED_PATH).key])),
});

// ---------------------------------------------------------------------------------------------
// Design parameters (the only hard-coded bait numbers). Every choice here is in DECISIONS.
const SALT = ['Ocean', 'Coast'];
const ALL = [...F.LIVE_BIOMES];
const PARAMS = deepFreeze({
	consumption: {
		unit: 'cast',
		perCast: 1,
		// Consumed only on a successful cast in a biome where the bait works; elsewhere it does
		// nothing (no stats, no XP) and is not used. Failed casts (NO_CATCH, broken rod...) use none.
		onlyWhereItWorks: true,
		// Founder uses exactly 1 per cast too.
		profileIndependent: true,
	},
	pricing: {
		// Money baits: cash return per $1 = returnTarget at the geometric centre of their home stages.
		returnTarget: 1.3,
		// XP-class baits: price = extra cash (at par) + xpPriceK × extra XP × the stage's own $/XP
		// (cash per cast ÷ XP per cast without bait). K = 1: an hour of income buys an hour of XP.
		xpPriceK: 1.0,
		// Acceptance bands, checked at every home stage by bandCheck().
		moneyReturnBand: [1.0, 1.7],
		xpUtilityBand: [0.75, 1.35],
		// A money bait's net gain must stay a small share of the cast's value (so skipping bait is fine).
		// Strong access is the largest lever (it opens half the catalog to an Old Rod); at the target
		// return its net gain in Ocean lands just under this cap (Pricing checks).
		netShareMax: 0.06,
		// XP baits are an optional money-to-progress converter, not a second curve. Guard (user decision on
		// P-BAIT-XP-SIZING), checked for EVERY archetype on the integrated model (xpBaitGuard()): a player who
		// runs the XP bait at every stage where one exists must (a) remain a net economic sink (bait bought >
		// the bait's extra catch value) and (b) reach each milestone from Lv 20 at most this much sooner, in
		// active hours, than the same archetype's no-bait run. The approved R1 progression windows describe the
		// no-bait reference player; they are not a test for bait buyers.
		// User decision D3: the hard guard is 12% (approved; was 'roughly 10%').
		maxXpBaitSpeedup: 0.12,
		xpBaitNetSink: true,
		// Sold in packs of `packSize` casts so small per-cast prices keep their precision (money is an
		// integer). Pack prices round to $1 below $100 and to $5 above.
		packSize: 10,
		packRoundTo: [{ below: 100, step: 1 }, { below: Infinity, step: 5 }],
	},
	// Volume baits (extra-fish chance: Spinner) work on every rod tier in their biomes, but the rod + bait
	// chance is capped at the chance whose mean fish per cast is the global normal-player ceiling
	// (rods.PARAMS.multi.ceilingMean, P-RODS-MEAN-FISH): a rod below it keeps the bait's boost up to the
	// ceiling, a rod at or above it gets nothing from the bait (the bait never lowers a rod's own chance).
	// Not a per-tier or per-band clamp (user decision on P-BAIT-SPINNER-TIERS).
	volume: { clampAt: 'ceiling' },
	bands: {
		starter: { biomes: ['Ocean', 'River'], note: 'Old Rod stage: strong-fish access only' },
		mid: { biomes: ['Lake', 'Pond'], note: 'Tier 1-2: one specialist per role' },
		late: { biomes: ['Coast', 'Swamp'], note: 'Tier 3-4: combination baits' },
		// Mountain Stream (Lv 60) is deliberately in no list: it gets its own band once its species
		// ladder exists, priced with these same functions. Adding it to a late bait would raise that
		// bait's return there by the Swamp→Mountain Stream value step.
	},
	// role, water/band, where it works, when the shop offers it, effect (framework stat model),
	// pricing class and the stages it is priced at (geometric centre of their utilities).
	baits: {
		// Strong access is the only thing that makes bait matter to an Old Rod, and it is the largest
		// lever in the game for one (strongAccessByBiome()). It is therefore limited to the two starter
		// waters: across a whole water type an Old Rod + Worm would return many times its price in Swamp.
		'Shrimp': {
			role: 'strong access (Ocean starter)', band: 'starter', biomes: ['Ocean'], levelFromBiome: 'Ocean',
			grantsStrong: true, stats: {}, multiChance: 0, pricing: 'money', homeStages: ['ocean-old'],
			description: 'Ocean starter bait: lets the Old Rod reach strong fish in the Ocean.',
		},
		'Worm': {
			role: 'strong access (River starter)', band: 'starter', biomes: ['River'], levelFromBiome: 'River',
			grantsStrong: true, stats: {}, multiChance: 0, pricing: 'money', homeStages: ['river-old'],
			description: 'River starter bait: lets the Old Rod reach strong fish in the River.',
		},
		'Fly': {
			role: 'rarity targeting (Rare/Ultra)', band: 'mid', biomes: ['Lake', 'Pond'], levelFromBiome: 'Lake',
			grantsStrong: false, stats: { rareFind: 1.0 }, multiChance: 0, pricing: 'money', homeStages: ['lake-t1', 'pond-t2'],
			description: 'Rare Find +100% in Lake and Pond.',
		},
		'Minnow': {
			role: 'trophy targeting (Giant)', band: 'mid', biomes: ['Lake', 'Pond'], levelFromBiome: 'Lake',
			grantsStrong: false, stats: { trophyChance: 1.5 }, multiChance: 0, pricing: 'money', homeStages: ['lake-t1', 'pond-t2'],
			description: 'Trophy Chance +150% in Lake and Pond: Giants 2.5x as likely.',
		},
		'Magnet': {
			role: 'luck / collection (Legendary+Lucky)', band: 'mid', biomes: ['Lake', 'Pond'], levelFromBiome: 'Lake',
			grantsStrong: false, stats: { luck: 2.0 }, multiChance: 0, pricing: 'money', homeStages: ['lake-t1', 'pond-t2'],
			description: 'Luck +200% in Lake and Pond: Legendary and Lucky fish 3x as likely.',
		},
		'Spinner': {
			role: 'multi-catch jackpots (+XP)', band: 'mid', biomes: ['Lake', 'Pond'], levelFromBiome: 'Lake',
			grantsStrong: false, stats: {}, multiChance: 0.10, pricing: 'xp', homeStages: ['lake-t1', 'pond-t2'],
			description: '+10% extra-fish chance in Lake and Pond: jackpot casts about twice as often.',
		},
		'Lure': {
			role: 'XP', band: 'mid', biomes: ['Lake', 'Pond'], levelFromBiome: 'Lake',
			grantsStrong: false, stats: { xpBonus: 0.15 }, multiChance: 0, pricing: 'xp', homeStages: ['lake-t1', 'pond-t2'],
			description: '+15% XP in Lake and Pond.',
		},
		'Bloodworm': {
			role: 'rarity + trophy (late)', band: 'late', biomes: ['Coast', 'Swamp'], levelFromBiome: 'Coast',
			grantsStrong: false, stats: { rareFind: 1.0, trophyChance: 0.75 }, multiChance: 0, pricing: 'money', homeStages: ['coast-t3', 'swamp-t4'],
			description: 'Rare Find +100% and Trophy Chance +75% in Coast and Swamp.',
		},
		'Magic Lure': {
			role: 'endgame all-rounder (XP + every rarity stat)', band: 'late', biomes: ['Coast', 'Swamp'], levelFromBiome: 'Coast',
			grantsStrong: false, stats: { rareFind: 0.75, trophyChance: 0.75, luck: 0.75, xpBonus: 0.12 }, multiChance: 0, pricing: 'xp', homeStages: ['coast-t3', 'swamp-t4'],
			description: '+12% XP and +75% Rare Find, Trophy Chance and Luck in Coast and Swamp.',
		},
		// Universal on purpose: the collection-completion tool for endgame players revisiting earlier
		// biomes. Priced at the most valuable stage it works in, so it is never a money-maker below it.
		// No strong access (legacy had it): an Old Rod + Strong Magnet in Swamp would be a money-maker.
		'Strong Magnet': {
			role: 'luck / collection completion, any biome', band: 'universal', biomes: ALL, levelFromBiome: 'Coast',
			grantsStrong: false, stats: { luck: 4.0 }, multiChance: 0, pricing: 'money', homeStages: ['swamp-t4'],
			description: 'Luck +400% (Legendary and Lucky 5x) in every biome. Priced for Swamp.',
		},
	},
});
const BAIT_NAMES = Object.keys(PARAMS.baits);

// Sensitivity inputs for the XP-bait sizing decision (P-BAIT-XP-SIZING). NOT proposals: the alternative
// the design stage measured, and the bisection that finds the largest uniform scale of the XP-class baits'
// XP effects passing the XP-bait guard for every archetype (xpSizing()).
const XP_SIZING = deepFreeze({
	designStage: { 'Lure': { stats: { xpBonus: 0.08 } }, 'Magic Lure': { stats: { xpBonus: 0.08 } }, 'Spinner': { multiChance: 0.05 } },
	bisectSteps: 8,
});

// Stage ids: typical (biome × the tier normally held there) and transitional (arrived, not upgraded).
const STAGES = deepFreeze(Object.fromEntries([
	...ALL.map((b) => [`${b.toLowerCase()}-${SHARED.typicalTier[b]}`, { biome: b, tier: SHARED.typicalTier[b], kind: 'typical' }]),
	...ALL.filter((b) => SHARED.typicalTier[b] !== 'old').map((b) => {
		const prev = SHARED.tierOrder[SHARED.tierOrder.indexOf(SHARED.typicalTier[b]) - 1];
		return [`${b.toLowerCase()}-${prev}`, { biome: b, tier: prev, kind: 'transitional' }];
	}),
]));
const TYPICAL_STAGE_IDS = Object.keys(STAGES).filter((k) => STAGES[k].kind === 'typical');

// ---------------------------------------------------------------------------------------------
const cap = (s) => String(s).split(' ').map((w) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase()).join(' ');
const r2 = (x) => (Number.isFinite(x) ? Math.round(x * 100) / 100 : x);
const r3 = (x) => (Number.isFinite(x) ? Math.round(x * 1000) / 1000 : x);
const r4 = (x) => (Number.isFinite(x) ? Math.round(x * 10000) / 10000 : x);
const geomean = (xs) => Math.exp(xs.reduce((s, x) => s + Math.log(x), 0) / xs.length);
const sum = (xs) => xs.reduce((a, b) => a + b, 0);
const mapValues = (o, fn) => Object.fromEntries(Object.entries(o).map(([k, v]) => [k, fn(v, k)]));
const addStats = (a = {}, b = {}) => {
	const o = { ...a };
	for (const [k, v] of Object.entries(b)) o[k] = (o[k] || 0) + v;
	return o;
};

/** Normalises a gear path (array old..t5 or keyed object) to { old, t1..t5 }. */
function normaliseGear(path) {
	if (!path) return SHARED.tiers;
	const entries = Array.isArray(path) ? path.map((t, i) => [SHARED.tierOrder[i], t]) : Object.entries(path);
	const out = {};
	for (const [name, t] of entries) {
		if (!SHARED.tierOrder.includes(name)) continue;
		out[name] = {
			level: t.level ?? SHARED.tiers[name].level,
			qualities: t.qualities || ['weak'],
			stats: { ...(t.stats || {}) },
			...(t.multiChance !== undefined ? { multiChance: t.multiChance } : { mean: t.meanFish ?? t.mean ?? 1 }),
		};
	}
	for (const n of SHARED.tierOrder) if (!out[n]) throw new Error(`gear path is missing tier ${n}`);
	return out;
}
const chanceOf = (gear) => (gear.multiChance !== undefined ? gear.multiChance : F.chanceForMean(gear.mean ?? gear.meanFish ?? 1));

let volumeCapMemo = null;
/** The global normal-player fish-per-cast ceiling (rods design) and the multi-catch chance with that mean. */
function volumeCap() {
	if (!volumeCapMemo) {
		const mean = require('./rods').PARAMS.multi.ceilingMean;
		volumeCapMemo = Object.freeze({ mean, chance: F.chanceForMean(mean) });
	}
	return volumeCapMemo;
}
/**
 * A volume bait's extra-fish chance on top of `current` (the rod's chance plus anything already added),
 * clamped per PARAMS.volume: the combined chance never passes the ceiling's chance, and the bait never
 * lowers it. Returns the chance the bait actually adds.
 */
function volumeAdd(current, baitChance) {
	if (!(baitChance > 0)) return 0;
	const limit = PARAMS.volume.clampAt === 'ceiling' ? volumeCap().chance : 1;
	return Math.max(0, Math.min(current + baitChance, limit, 1) - current);
}

const stageLabel = (s) => (typeof s === 'string' ? s : `${cap(s.biome).toLowerCase()}-${s.tier || 'custom'}`);

const outcomeCache = new Map();
/** castOutcome of a stage with an optional bait; `rules` overrides the framework's candidate rules. */
function outcome(g, bait, rules = null) {
	const qualities = bait && bait.grantsStrong ? [...new Set([...g.qualities, 'strong'])] : g.qualities;
	const input = {
		biome: g.biome,
		qualities,
		stats: addStats(g.stats, bait ? bait.stats : {}),
		multiChance: g.multiChance + (bait ? volumeAdd(g.multiChance, bait.multiChance || 0) : 0),
		table: g.table,
		sellMult: g.sellMult,
		xpMult: g.xpMult,
		...(rules ? { rules } : {}),
	};
	const key = JSON.stringify(input);
	if (!outcomeCache.has(key)) outcomeCache.set(key, F.castOutcome(input));
	return outcomeCache.get(key);
}

/** Per cast: Legendary+ fish, Lucky fish and Booster Packs (castOutcome's fish/item split of the Lucky tier). */
function chasePerCast(o) {
	const luckyFish = Math.max(0, o.rarity.lucky - o.itemPerDraw);
	return { legendaryPlusFish: (o.rarity.legendary + luckyFish) * o.fishPerCast, luckyFish: luckyFish * o.fishPerCast, booster: o.boosterPerDraw * o.fishPerCast };
}

const rowOut = (x) => ({
	bait: x.bait, biome: x.biome, tier: x.tier, applies: x.applies, price: x.price,
	extraValuePerCast: r2(x.extraValuePerCast), extraXpPerCast: r3(x.extraXpPerCast),
	cashReturn: r2(x.cashReturn), utilityReturn: r2(x.utilityReturn),
	netCostPerXp: r2(x.netCostPerXp), stageCashPerXp: r2(x.stageCashPerXp), xpPriceRatio: r2(x.xpPriceRatio),
	netShareOfCast: r4(x.netShareOfCast), baseValuePerCast: r2(x.baseValuePerCast),
	extraXpShare: r4(x.extraXpPerCast / x.baseXpPerCast), fishPerCast: r3(x.fishPerCast), jackpot3plus: [r4(x.baseJackpot3plus), r4(x.jackpot3plus)],
});

// ---------------------------------------------------------------------------------------------
/** Today's catalog bait and its measured Old Rod economics (real engine, measurements.json). */
function currentBaits() {
	const byKey = Object.fromEntries(MEASURED.results.map((r) => [r.key, r]));
	return CURRENT_CATALOG.map((b) => {
		const perBiome = [];
		for (const biome of b.biomes) {
			const m = byKey[`${biome}|Old Rod|${b.name}|normal`];
			const n = byKey[`${biome}|Old Rod|-|normal`];
			if (!m || !n) continue;
			const extraValue = m.valueBase / m.casts - n.valueBase / n.casts;
			const extraXp = m.xpBase / m.casts - n.xpBase / n.casts;
			const unitsPerCast = m.units / m.casts;
			const cost = unitsPerCast * b.price;
			perBiome.push({ biome, unitsPerCast: r2(unitsPerCast), costPerCast: r2(cost), extraValuePerCast: r2(extraValue), returnPerDollar: r2(extraValue / cost), extraXpPerCast: r2(extraXp), costPerExtraXp: extraXp > 1 ? r2(cost / extraXp) : null });
		}
		const best = perBiome.reduce((a, x) => (x.returnPerDollar > (a?.returnPerDollar ?? -Infinity) ? x : a), null);
		return {
			name: b.name, price: b.price, consumption: 'per fish', capabilities: b.capabilities, biomes: b.biomes,
			xpMultiplier: b.multiplier ?? 1, engineStats: BAIT_STATS[b.name] || {},
			bestReturnPerDollar: best?.returnPerDollar ?? null, bestBiome: best?.biome ?? null,
			costPerCastRange: [Math.min(...perBiome.map((x) => x.costPerCast)), Math.max(...perBiome.map((x) => x.costPerCast))],
			medianExtraXpPerCast: perBiome.map((x) => x.extraXpPerCast).sort((a, c) => a - c)[Math.floor(perBiome.length / 2)],
			medianCostPerExtraXp: (() => {
				const v = perBiome.map((x) => x.costPerExtraXp).filter((x) => x !== null).sort((a, c) => a - c);
				return v.length ? v[Math.floor(v.length / 2)] : null;
			})(),
			perBiome,
		};
	});
}

/** Bait definitions with sensitivity overrides merged in ({ [name]: { stats, multiChance } }). */
function mergeBaits(overrides) {
	if (!overrides) return PARAMS.baits;
	const out = {};
	for (const name of BAIT_NAMES) {
		const b = PARAMS.baits[name];
		const o = overrides[name];
		out[name] = o ? { ...b, ...o, stats: { ...b.stats, ...(o.stats || {}) } } : b;
	}
	return deepFreeze(out);
}

/**
 * The per-cast bait model on one rod path. Everything that depends on gear lives in here, so a new gear
 * path regenerates every number.
 * @param gearPath null (the shared path F.gearPath()) | a rods-style path
 * @param overrides null | { baits: { [name]: { stats, multiChance } } } (sensitivity only; see XP_SIZING)
 */
function createBaitModel(gearPath = null, overrides = null) {
	const TIERS = normaliseGear(gearPath);
	const BAITS = mergeBaits(overrides && overrides.baits);
	const gearSource = gearPath ? 'custom' : F.GEAR_PATH_SOURCE;

	/** Normalises a stage to castOutcome input. */
	function stageGear(stage) {
		const s = typeof stage === 'string' ? STAGES[stage] : stage;
		if (!s) throw new Error(`Unknown stage ${stage}`);
		const biome = cap(s.biome);
		const tierName = s.tier || SHARED.typicalTier[biome] || 'old';
		const gear = s.gear || (s.qualities || s.stats || s.mean || s.meanFish || s.multiChance !== undefined ? s : TIERS[tierName]);
		if (!gear) throw new Error(`Unknown tier ${tierName}`);
		return {
			biome,
			tier: s.gear || s.qualities ? (s.tier || 'custom') : tierName,
			qualities: gear.qualities || ['weak'],
			stats: { ...(gear.stats || {}) },
			multiChance: chanceOf(gear),
			table: s.table,
			sellMult: s.sellMult,
			xpMult: s.xpMult,
		};
	}

	/** Expected effect of one bait at a stage (per cast, versus the same stage without bait). */
	function baitEffect(name, stage) {
		const b = BAITS[name];
		if (!b) throw new Error(`Unknown bait ${name}`);
		const g = stageGear(stage);
		const base = outcome(g, null);
		const applies = b.biomes.includes(g.biome);
		const w = applies ? outcome(g, b) : base;
		return {
			bait: name,
			biome: g.biome,
			tier: g.tier,
			applies,
			extraValuePerCast: w.valuePerCast - base.valuePerCast,
			extraXpPerCast: w.xpPerCast - base.xpPerCast,
			cashPerXp: base.valuePerCast / base.xpPerCast,
			base,
			with: w,
		};
	}

	/** Pricing utility at a stage: what the price is set against. */
	function pricingUtility(name, stage) {
		const e = baitEffect(name, stage);
		if (BAITS[name].pricing === 'money') return e.extraValuePerCast / PARAMS.pricing.returnTarget;
		return e.extraValuePerCast + PARAMS.pricing.xpPriceK * e.extraXpPerCast * e.cashPerXp;
	}

	/** Pack price (integer $) for a raw per-cast price. */
	function roundPack(perCast) {
		const pack = perCast * PARAMS.pricing.packSize;
		const rule = PARAMS.pricing.packRoundTo.find((x) => pack < x.below);
		return Math.max(1, Math.round(pack / rule.step) * rule.step);
	}

	let priceMemo = null;
	/** Shop prices, computed from castOutcome at each bait's home stages. */
	function prices() {
		if (priceMemo) return priceMemo;
		priceMemo = {};
		for (const name of BAIT_NAMES) {
			const b = BAITS[name];
			const rawPrice = geomean(b.homeStages.map((s) => pricingUtility(name, s)));
			const packPrice = roundPack(rawPrice);
			priceMemo[name] = {
				price: packPrice / PARAMS.pricing.packSize,
				packPrice,
				packSize: PARAMS.pricing.packSize,
				rawPrice: r3(rawPrice),
				pricing: b.pricing,
				homeStages: [...b.homeStages],
				levelRequirement: F.BIOME_LEVEL[b.levelFromBiome],
			};
		}
		return priceMemo;
	}
	const priceOf = (name) => prices()[name].price;

	/** Effect + price at a stage, with every comparison metric. */
	function evaluate(name, stage) {
		const e = baitEffect(name, stage);
		const price = priceOf(name);
		const cost = e.applies ? price : 0;
		const xpValue = e.extraXpPerCast * e.cashPerXp;
		return {
			bait: name,
			biome: e.biome,
			tier: e.tier,
			applies: e.applies,
			price,
			costPerCast: cost,
			extraValuePerCast: e.extraValuePerCast,
			extraXpPerCast: e.extraXpPerCast,
			netValuePerCast: e.extraValuePerCast - cost,
			netShareOfCast: (e.extraValuePerCast - cost) / e.base.valuePerCast,
			cashReturn: cost > 0 ? e.extraValuePerCast / cost : null,
			utilityReturn: cost > 0 ? (e.extraValuePerCast + xpValue) / cost : null,
			netCostPerXp: e.extraXpPerCast > 1e-9 ? (cost - e.extraValuePerCast) / e.extraXpPerCast : null,
			stageCashPerXp: e.cashPerXp,
			xpPriceRatio: e.extraXpPerCast > 1e-9 ? (cost - e.extraValuePerCast) / e.extraXpPerCast / e.cashPerXp : null,
			baseValuePerCast: e.base.valuePerCast,
			baseXpPerCast: e.base.xpPerCast,
			fishPerCast: e.with.fishPerCast,
			jackpot3plus: e.with.jackpot3plus,
			baseJackpot3plus: e.base.jackpot3plus,
		};
	}

	/**
	 * What a player who uses bait equips at this stage.
	 * @param stage stage id or object (see stageGear)
	 * @param opts { goal: 'cash' (best positive net cash) | 'xp' (the XP-class bait with the most extra XP,
	 *   else 'cash') | <bait name> }
	 */
	function baitOption(stage, { goal = 'cash' } = {}) {
		const none = { bait: null, costPerCast: 0, extraValuePerCast: 0, extraXpPerCast: 0, netValuePerCast: 0, goal };
		const g = stageGear(stage);
		const usable = BAIT_NAMES.filter((n) => BAITS[n].biomes.includes(g.biome));
		const pick = (rows) => (rows.length ? rows[0] : null);
		let chosen = null;
		if (BAITS[goal]) {
			chosen = usable.includes(goal) ? evaluate(goal, stage) : null;
		}
		else if (goal === 'xp') {
			const rows = usable.filter((n) => BAITS[n].pricing === 'xp').map((n) => evaluate(n, stage)).filter((r) => r.extraXpPerCast > 0)
				.sort((a, b) => b.extraXpPerCast - a.extraXpPerCast);
			chosen = pick(rows) || baitOption(stage, { goal: 'cash' });
			if (chosen && chosen.bait === null) return { ...chosen, goal };
		}
		else {
			const rows = usable.map((n) => evaluate(n, stage)).filter((r) => r.netValuePerCast > 0).sort((a, b) => b.netValuePerCast - a.netValuePerCast);
			chosen = pick(rows);
		}
		if (!chosen) return none;
		return {
			bait: chosen.bait,
			costPerCast: chosen.costPerCast,
			extraValuePerCast: chosen.extraValuePerCast,
			extraXpPerCast: chosen.extraXpPerCast,
			netValuePerCast: chosen.netValuePerCast,
			cashReturn: chosen.cashReturn,
			xpPriceRatio: chosen.xpPriceRatio,
			role: BAITS[chosen.bait].role,
			goal,
		};
	}

	/** Every bait at every typical stage it works in; starter baits also with an Old Rod elsewhere. */
	function baitMatrix() {
		const out = {};
		for (const name of BAIT_NAMES) {
			const b = BAITS[name];
			const home = b.homeStages.map((s) => ({ stage: s, ...rowOut(evaluate(name, s)) }));
			const elsewhere = TYPICAL_STAGE_IDS.filter((s) => !b.homeStages.includes(s) && b.biomes.includes(STAGES[s].biome))
				.map((s) => ({ stage: s, ...rowOut(evaluate(name, s)) }));
			const transitional = Object.keys(STAGES).filter((s) => STAGES[s].kind === 'transitional' && b.biomes.includes(STAGES[s].biome))
				.map((s) => ({ stage: s, ...rowOut(evaluate(name, s)) }));
			const oldRodElsewhere = b.grantsStrong
				? b.biomes.filter((bi) => !b.homeStages.includes(`${bi.toLowerCase()}-old`)).map((bi) => ({ stage: `${bi.toLowerCase()}-old`, atypical: SHARED.typicalTier[bi] !== 'old', ...rowOut(evaluate(name, { biome: bi, tier: 'old' })) }))
				: [];
			out[name] = { home, elsewhere, transitional, oldRodElsewhere };
		}
		return out;
	}

	/** Checks the pricing targets at every home stage; flags a bait that is too good anywhere typical. */
	function bandCheck() {
		const P = PARAMS.pricing;
		const issues = [];
		const summary = {};
		for (const name of BAIT_NAMES) {
			const b = BAITS[name];
			const home = b.homeStages.map((s) => evaluate(name, s));
			const typicalElsewhere = TYPICAL_STAGE_IDS.filter((s) => !b.homeStages.includes(s) && b.biomes.includes(STAGES[s].biome)).map((s) => evaluate(name, s));
			if (b.pricing === 'money') {
				const rets = home.map((h) => h.cashReturn);
				const shares = home.map((h) => h.netShareOfCast);
				summary[name] = { pricing: 'money', cashReturnRange: [r2(Math.min(...rets)), r2(Math.max(...rets))], netShareMax: r4(Math.max(...shares)) };
				for (const h of home) {
					if (h.cashReturn < P.moneyReturnBand[0] || h.cashReturn > P.moneyReturnBand[1]) issues.push(`${name} @ ${h.biome}/${h.tier}: cash return ${r2(h.cashReturn)} outside ${P.moneyReturnBand}`);
					if (h.netShareOfCast > P.netShareMax) issues.push(`${name} @ ${h.biome}/${h.tier}: net gain ${r4(h.netShareOfCast)} of cast value > ${P.netShareMax}`);
				}
				for (const h of typicalElsewhere) if (h.cashReturn !== null && h.cashReturn > P.moneyReturnBand[1]) issues.push(`${name} @ ${h.biome}/${h.tier} (not home): cash return ${r2(h.cashReturn)} above band`);
			}
			else {
				const us = home.map((h) => h.utilityReturn);
				const ks = home.map((h) => h.xpPriceRatio);
				summary[name] = { pricing: 'xp', utilityReturnRange: [r2(Math.min(...us)), r2(Math.max(...us))], xpPriceRatioRange: [r2(Math.min(...ks)), r2(Math.max(...ks))] };
				for (const h of home) if (h.utilityReturn < P.xpUtilityBand[0] || h.utilityReturn > P.xpUtilityBand[1]) issues.push(`${name} @ ${h.biome}/${h.tier}: utility return ${r2(h.utilityReturn)} outside ${P.xpUtilityBand}`);
			}
		}
		// Volume baits: the rod + bait mean fish per cast stays at or under the global ceiling on every rod tier.
		const vol = volumeCheck();
		for (const [name, v] of Object.entries(vol.summary)) {
			summary[name].volumeCeiling = { ceiling: v.ceiling, maxMeanWith: v.maxMeanWith, pass: !v.tiersAboveCeiling.length };
			if (v.tiersAboveCeiling.length) issues.push(`${name}: mean fish per cast above the ${v.ceiling} ceiling on ${v.tiersAboveCeiling.join(', ')}`);
		}
		return { pass: issues.length === 0, issues, summary, bands: { moneyReturn: P.moneyReturnBand, xpUtility: P.xpUtilityBand, netShareMax: P.netShareMax, fishPerCastCeiling: vol.ceiling } };
	}

	/**
	 * Volume baits (extra-fish chance) on EVERY rod tier in every biome they work in. P-BAIT-WHERE-IT-WORKS
	 * gates by biome only, so a Tier 3-5 rod taken back to a mid-band biome gets the bait too; PARAMS.volume
	 * caps the rod + bait chance at the global ceiling's chance (P-BAIT-SPINNER-TIERS, rods.PARAMS.multi.
	 * ceilingMean). Mean fish per cast with the bait (clamped) is checked against the ceiling (the pass
	 * condition) and compared with the highest rod mean of the tiers typical in the bait's biomes (the band's
	 * rod range: informational, the user chose not to clamp there). The unclamped mean (the bait's intended
	 * boost) and the other alternatives (clamp at the band's range, bait only up to the band's top tier) are a
	 * sensitivity. The XP and cash columns show why a high-tier rod would use it: XP per cast does not depend
	 * on the biome.
	 */
	function volumeCheck() {
		const vcap = volumeCap();
		const ceiling = vcap.mean;
		const meanOf = (chance) => F.fishDistribution(Math.min(1, chance));
		const rows = [];
		const summary = {};
		for (const name of BAIT_NAMES.filter((n) => (BAITS[n].multiChance || 0) > 0)) {
			const b = BAITS[name];
			const bandTiers = [...new Set(b.biomes.map((bi) => SHARED.typicalTier[bi]).filter(Boolean))];
			const topBandTier = SHARED.tierOrder.filter((t) => bandTiers.includes(t)).pop();
			const bandTop = Math.max(...bandTiers.map((t) => meanOf(chanceOf(TIERS[t])).mean));
			const price = priceOf(name);
			const firstLevel = Math.min(...b.biomes.map((bi) => F.BIOME_LEVEL[bi]));
			for (const tier of SHARED.tierOrder) {
				// Where this rod usually fishes once the bait can be used: the highest biome open at the rod's
				// level, and at least the bait's first biome.
				const topBiome = F.biomeAt(Math.max(TIERS[tier].level, firstLevel));
				const home = outcome(stageGear({ biome: topBiome, tier }), null);
				for (const biome of b.biomes) {
					const e = evaluate(name, { biome, tier });
					const chance = chanceOf(TIERS[tier]);
					const base = meanOf(chance);
					const intended = meanOf(chance + b.multiChance);
					const w = meanOf(chance + volumeAdd(chance, b.multiChance));
					const clampAt = (limit) => Math.min(intended.mean, Math.max(base.mean, limit));
					rows.push({
						bait: name, tier, level: TIERS[tier].level, biome,
						meanWithout: r3(base.mean), meanUnclamped: r3(intended.mean), meanWith: r3(w.mean), addedMean: r3(w.mean - base.mean),
						clamped: w.mean < intended.mean - 1e-9, noEffect: w.mean <= base.mean + 1e-9,
						p3plusWith: r4(w.p3plus), p5With: r4(w.p5),
						aboveBand: w.mean > bandTop + 1e-9, aboveCeiling: w.mean > ceiling + 1e-9,
						xpPerCastWith: r2(e.baseXpPerCast + e.extraXpPerCast), topBiome, xpPerCastTopBiome: r2(home.xpPerCast),
						netCashPerCastWith: r2(e.baseValuePerCast + e.extraValuePerCast - price), cashPerCastTopBiome: r2(home.valuePerCast),
						alternatives: {
							noClamp: r3(intended.mean),
							clampAtBand: r3(clampAt(bandTop)),
							upToBandTier: r3(SHARED.tierOrder.indexOf(tier) <= SHARED.tierOrder.indexOf(topBandTier) ? intended.mean : base.mean),
						},
					});
				}
			}
			const mine = rows.filter((r) => r.bait === name);
			const tiersWhere = (pred) => [...new Set(mine.filter(pred).map((r) => r.tier))];
			summary[name] = {
				biomes: [...b.biomes], bandTiers, topBandTier, bandTop: r3(bandTop), ceiling, clampAt: PARAMS.volume.clampAt,
				tiersAboveBand: tiersWhere((r) => r.aboveBand),
				tiersAboveCeiling: tiersWhere((r) => r.aboveCeiling),
				tiersClamped: tiersWhere((r) => r.clamped),
				tiersNoEffect: tiersWhere((r) => r.noEffect),
				tiersAboveCeilingUnclamped: tiersWhere((r) => r.meanUnclamped > ceiling + 1e-9),
				maxMeanWith: r3(Math.max(...mine.map((r) => r.meanWith))),
				maxMeanUnclamped: r3(Math.max(...mine.map((r) => r.meanUnclamped))),
				// Home-stage effect under the clamp and under each alternative (unchanged effect = unchanged price).
				homeStageEffectKept: {
					clampAtCeiling: b.homeStages.every((s) => clampKeeps(s, b.multiChance, ceiling)),
					clampAtBand: b.homeStages.every((s) => clampKeeps(s, b.multiChance, bandTop)),
					upToBandTier: b.homeStages.every((s) => SHARED.tierOrder.indexOf(STAGES[s].tier) <= SHARED.tierOrder.indexOf(topBandTier)),
				},
			};
		}
		/** True when a mean clamp at `limit` leaves the bait's effect at a home stage untouched. */
		function clampKeeps(stage, multiChance, limit) {
			const g = stageGear(stage);
			return meanOf(g.multiChance + multiChance).mean <= Math.max(meanOf(g.multiChance).mean, limit) + 1e-9;
		}
		// The ceiling is the pass condition; the band's rod range is informational (P-BAIT-SPINNER-TIERS).
		const pass = Object.values(summary).every((x) => !x.tiersAboveCeiling.length);
		return { pass, ceiling, ceilingChance: vcap.chance, clampAt: PARAMS.volume.clampAt, summary, rows };
	}

	/**
	 * Evidence for the starter baits' biome lists: what strong access is worth to an Old Rod in each
	 * biome, and the return it would have at the starter bait's price of that water type.
	 */
	function strongAccessByBiome() {
		return ALL.map((biome) => {
			const g = stageGear({ biome, tier: 'old' });
			const o0 = outcome(g, null);
			const o1 = outcome(g, { grantsStrong: true, stats: {} });
			const starter = SALT.includes(biome) ? 'Shrimp' : 'Worm';
			const extra = o1.valuePerCast - o0.valuePerCast;
			return {
				biome, oldRodValuePerCast: r2(o0.valuePerCast), strongAccessExtraPerCast: r2(extra), strongAccessShare: r4(extra / o0.valuePerCast),
				starterOfWaterType: starter, returnAtStarterPrice: r2(extra / priceOf(starter)),
				starterWorksHere: BAITS[starter].biomes.includes(biome), typicalTierHere: SHARED.typicalTier[biome],
			};
		});
	}

	/** Cash, XP and cash per XP per cast at each typical stage without bait (what XP pricing reads). */
	function stageRates() {
		return TYPICAL_STAGE_IDS.map((s) => {
			const o = outcome(stageGear(s), null);
			return { stage: s, valuePerCast: r2(o.valuePerCast), xpPerCast: r2(o.xpPerCast), cashPerXp: r2(o.valuePerCast / o.xpPerCast) };
		});
	}

	// ---------------------------------------------------------------------------------------------
	/** Per-cast vs per-fish consumption by rod tier (framework multi-catch) and for today's Founder. */
	function consumptionModel() {
		const tiers = SHARED.tierOrder.map((t) => {
			const d = F.fishDistribution(chanceOf(TIERS[t]));
			return { tier: t, perFishUnitsPerCast: r3(d.mean), perCastUnitsPerCast: PARAMS.consumption.perCast, pUnitsAtLeast3PerFish: r4(d.p3plus), pUnits5PerFish: r4(d.p5) };
		});
		const fb = PROFILES.founder.bonusDraws;
		const total = Object.values(fb).reduce((s, p) => s + p, 0);
		const founderDraws = 1 + Object.entries(fb).reduce((s, [k, p]) => s + Number(k) * p / total, 0);
		return {
			rule: PARAMS.consumption,
			byTier: tiers,
			founderToday: { expectedDrawsStarterRod: r2(founderDraws), perFishUnitsPerCast: r2(founderDraws), perCastUnitsPerCast: PARAMS.consumption.perCast },
		};
	}

	/**
	 * Collection-chase metrics for the luck baits at their home stages and back in the starter waters, under
	 * the Lucky-item rule the framework runs (F.RULES.luckyItems, proposed P-LUCKY).
	 */
	function chaseMetrics() {
		const rows = [];
		const cases = [
			['Magnet', 'lake-t1'], ['Magnet', 'pond-t2'],
			['Strong Magnet', 'coast-t3'], ['Strong Magnet', 'swamp-t4'],
			// Endgame player (Tier 4) back in the starter waters to finish the collection (Magikarp, Pearl...).
			['Strong Magnet', { biome: 'Ocean', tier: 't4' }], ['Strong Magnet', { biome: 'River', tier: 't4' }],
		];
		for (const [name, s] of cases) {
			const g = stageGear(s);
			const o0 = outcome(g, null);
			const o1 = outcome(g, BAITS[name]);
			const c0 = chasePerCast(o0);
			const c1 = chasePerCast(o1);
			const price = priceOf(name);
			const net = price - (o1.valuePerCast - o0.valuePerCast);
			rows.push({
				bait: name, stage: stageLabel(s), price,
				castsPerLegendaryPlus: { without: Math.round(1 / c0.legendaryPlusFish), with: Math.round(1 / c1.legendaryPlusFish) },
				castsPerLuckyFish: { without: Math.round(1 / c0.luckyFish), with: Math.round(1 / c1.luckyFish) },
				// Negative = the bait pays for itself in cash while multiplying the chase odds.
				netCostPerExtraLegendaryPlus: Math.round(net / (c1.legendaryPlusFish - c0.legendaryPlusFish)),
				netCostPerExtraLegendaryPlusInMinutesOfIncome: r2((60 * net) / (c1.legendaryPlusFish - c0.legendaryPlusFish) / F.hourly(o0).cash),
				netCostPerExtraLuckyFish: Math.round(net / (c1.luckyFish - c0.luckyFish)),
			});
		}
		return { luckyItemRule: F.RULES.luckyItems, rows };
	}

	/**
	 * Booster Pack (Lucky item) odds with luck baits, under today's engine rule and under the pinned rule the
	 * framework runs (proposed P-LUCKY). Disclosed only: never valued in any model.
	 */
	function boosterPackOdds() {
		const ENGINE = { luckyItems: 'engine' };
		const PINNED = { luckyItems: 'pinned' };
		const rows = [];
		for (const [name, s] of [[null, 'ocean-old'], [null, 'swamp-t4'], ['Magnet', 'pond-t2'], ['Strong Magnet', 'swamp-t4'], ['Strong Magnet', { biome: 'Ocean', tier: 't4' }], ['Magic Lure', 'swamp-t4']]) {
			const g = stageGear(s);
			const b = name ? BAITS[name] : null;
			const oe = outcome(g, b, ENGINE);
			const perCast = chasePerCast(oe).booster;
			rows.push({
				bait: name, stage: stageLabel(s),
				castsPerBoosterPack: Math.round(1 / perCast),
				hoursPerBoosterPackRegular: Math.round(1 / perCast / F.hourly(oe, F.ARCHETYPES[F.REFERENCE_ARCHETYPE].overheadS).casts),
				baitSpendPerBoosterPack: name ? Math.round(priceOf(name) / perCast) : 0,
				castsPerBoosterPackIfPinned: Math.round(1 / chasePerCast(outcome(g, b, PINNED)).booster),
			});
		}
		// Founder rarity table (per draw; Founder draw counts belong to the Founder design).
		const fg = { ...stageGear('swamp-t4'), table: F.FOUNDER_RARITY_TABLE };
		const perDraw = (b, rules) => Math.round(1 / outcome(fg, b, rules).boosterPerDraw);
		const sm = BAITS['Strong Magnet'];
		return {
			note: 'Lucky items are excluded from castOutcome value; Booster Packs are counted in no income or progression model. "IfPinned" = the pinned rule the framework runs (proposed P-LUCKY): luck stats raise Lucky fish, never the Lucky-item rate.',
			normal: rows,
			founderPerDraw: { withoutBait: perDraw(null, ENGINE), withStrongMagnet: perDraw(sm, ENGINE), withoutBaitIfPinned: perDraw(null, PINNED), withStrongMagnetIfPinned: perDraw(sm, PINNED) },
		};
	}

	/** Liquid value of the bait share of each box per open, current vs proposed prices (1 unit per slot). */
	function gachaBaitValue() {
		const current = Object.fromEntries(CURRENT_CATALOG.map((b) => [b.name, b.price]));
		const out = {};
		for (const [box, d] of Object.entries(GACHA_EV)) {
			let cur = 0;
			let prop = 0;
			let units = 0;
			for (const [name, r] of Object.entries(d.rewards || {})) {
				if (r.type !== 'bait') continue;
				const u = r.p * d.slots;
				units += u;
				cur += u * (current[name] ?? r.price ?? 0);
				prop += u * (BAITS[name] ? priceOf(name) : 0);
			}
			out[box] = { baitUnitsPerOpen: r3(units), currentBaitValuePerOpen: r2(cur), proposedBaitValuePerOpen: r2(prop), proposedIfSlotGrantsAPack: r2(prop * PARAMS.pricing.packSize) };
		}
		return out;
	}

	// ---------------------------------------------------------------------------------------------
	/** Current -> proposed rows for all 10 baits (proposed metrics at each home stage). */
	function currentVsProposed() {
		const cur = Object.fromEntries(currentBaits().map((c) => [c.name, c]));
		const p = prices();
		return BAIT_NAMES.map((name) => {
			const b = BAITS[name];
			const c = cur[name];
			return {
				bait: name,
				current: {
					price: c.price, consumption: c.consumption, biomes: c.biomes, capabilities: c.capabilities, engineStats: c.engineStats, xpMultiplier: c.xpMultiplier,
					bestReturnPerDollarOldRod: c.bestReturnPerDollar, bestBiome: c.bestBiome, costPerCastRange: c.costPerCastRange, medianExtraXpPerCast: c.medianExtraXpPerCast, medianCostPerExtraXp: c.medianCostPerExtraXp,
				},
				proposed: {
					role: b.role, band: b.band, price: p[name].price, packPrice: p[name].packPrice, rawPrice: p[name].rawPrice, levelRequirement: p[name].levelRequirement,
					consumption: '1 per cast where it works', biomes: b.biomes, grantsStrong: b.grantsStrong, stats: b.stats, multiChance: b.multiChance, pricing: b.pricing,
					home: b.homeStages.map((s) => rowOut(evaluate(name, s))),
				},
			};
		});
	}

	function stageOptions() {
		return Object.keys(STAGES).map((s) => {
			const cash = baitOption(s, { goal: 'cash' });
			const xp = baitOption(s, { goal: 'xp' });
			const trim = (o) => ({ bait: o.bait, costPerCast: o.costPerCast, extraValuePerCast: r2(o.extraValuePerCast), extraXpPerCast: r3(o.extraXpPerCast), netValuePerCast: r2(o.netValuePerCast) });
			return { stage: s, kind: STAGES[s].kind, cash: trim(cash), xp: trim(xp) };
		});
	}

	/** The per-cast model's report (lifecycle figures are added by the module's report(), integrated). */
	function modelReport() {
		return {
			...F.stamp(),
			curve: { ...F.CURVE },
			gear: { source: gearSource, tiers: TIERS },
			params: {
				consumption: PARAMS.consumption,
				pricing: PARAMS.pricing,
				bands: PARAMS.bands,
			},
			prices: prices(),
			currentVsProposed: currentVsProposed(),
			bandCheck: bandCheck(),
			volumeCheck: volumeCheck(),
			matrix: baitMatrix(),
			strongAccess: strongAccessByBiome(),
			stageRates: stageRates(),
			stageOptions: stageOptions(),
			consumption: consumptionModel(),
			chase: chaseMetrics(),
			boosterPack: boosterPackOdds(),
			gacha: gachaBaitValue(),
		};
	}

	return {
		tiers: TIERS, gearSource, baits: BAITS,
		stageGear, baitEffect, prices, priceOf, evaluate, baitOption,
		baitMatrix, bandCheck, volumeCheck, strongAccessByBiome, stageRates, consumptionModel, chaseMetrics, boosterPackOdds, gachaBaitValue,
		currentVsProposed, stageOptions, report: modelReport,
	};
}

const DEFAULT = createBaitModel();

/**
 * Bait held below its shop level (legacy stacks, P-BAIT-LEGACY-STACKS; box grants, P-STREAK-BAIT-PACK). A
 * player below a biome's level cannot fish there, so a bait whose every biome opens at or after its shop
 * level waits through biome access alone. A bait with a biome that opens earlier is usable below its shop
 * level unless the cast checks the level (cast.js baitApplies). Today nothing checks it: /equip's level
 * check never blocks (equip.js:67-74 reads userData.level, which the User wrapper does not have), and an
 * owned stack carries the cloned catalog requirements.level of its purchase.
 */
function legacyLevelCheck(model = DEFAULT) {
	const p = model.prices();
	const rows = BAIT_NAMES.map((name) => {
		const b = model.baits[name];
		const shop = p[name].levelRequirement;
		const early = b.biomes.filter((bi) => F.BIOME_LEVEL[bi] < shop);
		return { bait: name, shopLevel: shop, biomes: [...b.biomes], lowestBiomeLevel: Math.min(...b.biomes.map((bi) => F.BIOME_LEVEL[bi])), usableBelowShopLevelIn: early, enforcedByBiomeAccess: early.length === 0 };
	});
	return { rows, needUseTimeCheck: rows.filter((r) => !r.enforcedByBiomeAccess).map((r) => r.bait) };
}

// ---------------------------------------------------------------------------------------------
// SYSTEM: bait on the shared lifecycle core (lifecycle.js). The core steps time and accrues every cast into
// ledger source 'fishing', the bait's effect included. This system only picks the bait, applies it to the
// cast and pays for it. It writes no ledger source and one spend item.
const SYSTEM_NAME = 'bait';
/** The one ledger item the system writes: bait bought per cast, an optional sink (user decision 10). */
const SPEND_ITEM = Object.freeze({ category: 'optional', item: 'bait' });
const POLICIES = Object.freeze(['none', 'cash', 'xp']);
const NO_BAIT = Object.freeze({ bait: null, costPerCast: 0, extraValuePerCast: 0, extraXpPerCast: 0 });
const numericKeys = (o) => Object.keys(o).filter((k) => /^\d+$/.test(k));
const newTally = () => ({ units: 0, spend: 0, extraValue: 0, extraXp: 0, extraPublicXp: 0 });
const addTally = (t, d) => {
	for (const k of Object.keys(d)) t[k] += d[k];
};
const pickTally = (t) => ({ units: t.units, spend: t.spend, extraValue: t.extraValue, extraXp: t.extraXp, extraPublicXp: t.extraPublicXp });

/**
 * The cast input without what the bait added. Other systems' changes are kept: a stat nothing else
 * touched after the bait gets its exact pre-bait value back, any other stat has the bait's bonus removed.
 */
function withoutBait(input, applied) {
	const stats = { ...input.stats };
	for (const [k, v] of Object.entries(applied.stats)) {
		const restored = stats[k] === applied.after[k] ? applied.before[k] : stats[k] - v;
		if (restored === undefined) delete stats[k];
		else stats[k] = restored;
	}
	const qualities = applied.strong ? input.qualities.filter((q) => q !== 'strong') : [...input.qualities];
	return { ...input, qualities, stats, costs: undefined };
}

/**
 * The bait SYSTEM (lifecycle.js hooks). A fresh object per call. Per-run state lives in state.sys.bait only.
 *   init        state.sys.bait: { policy, units, spend, extraValue, extraXp, extraPublicXp, byBait,
 *               stages, milestones, publicMilestones }
 *   modifyCast  baitOption({ biome: input.biome, tier: the equipped tier on the run's gear path
 *               (ctx.path[input.tier]) }, { goal: policy }), memoised per stage in state.sys.bait.stages.
 *               When a bait fits, it adds the bait's stats to input.stats (Rare Find, Trophy Chance, Luck,
 *               xpBonus, and Spinner's extra-fish chance as stats.multiChance, only up to the ceiling's
 *               chance on top of the cast's current chance, PARAMS.volume) and strong access for the
 *               starter baits (input.qualities). It then pushes the per-cast cost { category: 'optional',
 *               item: 'bait', perCast: shop price per cast }: one unit per cast, only where the bait works
 *               (PARAMS.consumption). Nothing happens where no bait fits.
 *   onCasts     the bait's marginal effect this step, measured on the core's own cast: value and XP
 *               (account and public) of the cast minus the same cast without the bait (other systems'
 *               changes kept), from the same outcome function the core used. It is added to the totals,
 *               byBait[name] and stages[biome/tier].
 *   on          'levelUp': snapshots the totals at each recorded milestone (milestones /
 *               publicMilestones), next to the core's ledger snapshots
 * Ledgers: the core's 'fishing' XP and cash already include the bait's effect. The system writes no
 * XP or cash source. Its only ledger item is ledger.spend.optional.bait. A report that splits XP by
 * source takes the bait's share from state.sys.bait (extraXp / extraPublicXp) and never edits 'fishing'.
 * Buffs credit their bonus on the whole catch (bait effect included) to their own 'buff' source.
 * Profile: the choice is baitOption's (normal-profile stage economics, fixed shop prices). A Founder
 * also uses one unit per cast (PARAMS.consumption.profileIndependent). The marginal is measured on the
 * profile's actual cast (the outcome override honours the input), so a Founder's is its own.
 * Box contents: bait units inside boxes are valued by the system that grants the box (counting rule),
 * never here, and they do not offset the bait bought per cast.
 * @param {object} opts { policy: 'cash' (default: best positive net cash) | 'xp' (best XP-class bait, else
 *   'cash') | a bait name (that bait wherever it works) | 'none' (no-op); model: a withGear() model
 *   (default: the proposed model on the shared path; sensitivity runs pass an alternative sizing) }
 */
function system(opts = {}) {
	const policy = opts.policy ?? 'cash';
	const model = opts.model || DEFAULT;
	if (!POLICIES.includes(policy) && !model.baits[policy]) throw new Error(`Unknown bait policy ${policy} (${POLICIES.join(' | ')} | a bait name)`);
	const own = (state) => state.sys[SYSTEM_NAME];

	/** What the policy equips at a biome with a path tier (memoised per run; shop prices are fixed). */
	function stageChoice(s, biome, tierIdx, ctx) {
		const gear = ctx.path[tierIdx];
		const key = gear.key || F.TIER_KEYS[tierIdx] || `tier${tierIdx}`;
		const id = `${biome}/${key}`;
		if (!s.stages[id]) {
			const opt = policy === 'none' ? NO_BAIT : model.baitOption({ biome, tier: key, gear }, { goal: policy });
			s.stages[id] = { bait: opt.bait, costPerCast: opt.costPerCast, designExtraValuePerCast: opt.extraValuePerCast, designExtraXpPerCast: opt.extraXpPerCast, ...newTally() };
		}
		return s.stages[id];
	}

	/** The no-bait outcome from the function the core used (castOutcome, or the run's outcome override). */
	function baseOutcome(s, input, state, ctx) {
		const provider = ctx.systems.find((x) => typeof x.outcome === 'function');
		let key = JSON.stringify(input);
		if (provider) key = typeof provider.outcomeCacheKey === 'function' ? `${key}|${provider.outcomeCacheKey(input, state, ctx)}` : null;
		let o = key === null ? null : s.memo.get(key);
		if (!o) {
			o = provider ? provider.outcome(input, state, ctx) : F.castOutcome(input);
			if (key !== null) s.memo.set(key, o);
		}
		return o;
	}

	return {
		name: SYSTEM_NAME,
		init(state) {
			state.sys[SYSTEM_NAME] = { policy, ...newTally(), byBait: {}, stages: {}, milestones: {}, publicMilestones: {} };
			// Per-run scratch kept out of the result's JSON: the step's bait and a memo of no-bait outcomes.
			Object.defineProperty(own(state), 'current', { value: null, writable: true, enumerable: false });
			Object.defineProperty(own(state), 'memo', { value: new Map(), enumerable: false });
		},
		modifyCast(input, state, ctx) {
			const s = own(state);
			const stage = stageChoice(s, input.biome, input.tier, ctx);
			s.current = null;
			if (!stage.bait) return;
			const b = model.baits[stage.bait];
			// A volume bait adds its extra-fish chance only up to the ceiling (PARAMS.volume), on top of the
			// rod's chance and whatever other systems already added this cast.
			const extra = b.multiChance ? volumeAdd((input.multiChance || 0) + (input.stats.multiChance || 0), b.multiChance) : 0;
			const add = { ...b.stats, ...(extra > 0 ? { multiChance: extra } : {}) };
			const before = {};
			const after = {};
			for (const [k, v] of Object.entries(add)) {
				before[k] = input.stats[k];
				input.stats[k] = (input.stats[k] || 0) + v;
				after[k] = input.stats[k];
			}
			const strong = b.grantsStrong && !input.qualities.includes('strong');
			if (strong) input.qualities.push('strong');
			input.costs.push({ ...SPEND_ITEM, perCast: stage.costPerCast });
			s.current = { stage, input, applied: { stats: add, before, after, strong } };
		},
		onCasts(state, ctx, { casts, rates }) {
			const s = own(state);
			const cur = s.current;
			s.current = null;
			if (!cur || rates.blocked || !(casts > 0)) return;
			const base = baseOutcome(s, withoutBait(cur.input, cur.applied), state, ctx);
			// The same step's casts without the bait (a bait that changed the cooldown would change their number).
			const baseCasts = (casts * (rates.outcome.cooldownMs / 1000 + ctx.arch.overheadS)) / (base.cooldownMs / 1000 + ctx.arch.overheadS);
			const d = {
				units: casts * PARAMS.consumption.perCast,
				spend: casts * cur.stage.costPerCast,
				extraValue: rates.cash - baseCasts * base.valuePerCast,
				extraXp: rates.xp - baseCasts * base.xpPerCast,
				extraPublicXp: rates.xpBase - baseCasts * (base.xpBasePerCast ?? base.xpPerCast),
			};
			addTally(s, d);
			addTally(s.byBait[cur.stage.bait] || (s.byBait[cur.stage.bait] = newTally()), d);
			addTally(cur.stage, d);
		},
		on(event, payload, state) {
			if (event !== 'levelUp') return;
			const s = own(state);
			const [recorded, mine] = payload.kind === 'public' ? [state.publicMilestones, s.publicMilestones] : [state.milestones, s.milestones];
			for (const T of numericKeys(recorded)) if (!mine[T]) mine[T] = pickTally(s);
		},
	};
}

// ---------------------------------------------------------------------------------------------
// Retired private loop: the record of system()'s parity with it. The loop (lifecycle() on its own 1-minute
// steps, the 5b.1 placeholder gear rule and daily XP) and its validateSystem() were deleted at 5b.4; this is
// validateSystem()'s output at commit a83b5f0 (framework, lifecycle core and bait.js unchanged since).
const RETIRED_LOOP_PARITY = deepFreeze({
	commit: 'a83b5f0',
	source: 'validateSystem() output at a83b5f0 (deleted with the private loop)',
	method: 'LC.simulate with system({ policy }), the retired loop\'s gear rule and daily XP, and a milestone probe, against the retired lifecycle(policy, archetype); every archetype x policy on the shared gear path. Compared: milestone hours as step indices, XP by source at each milestone (fishing without bait, bait, daily), bait spend, bait extra value, no-bait income, steps and the baits used.',
	archetypes: ['casual', 'regular', 'active', 'grinder'],
	policies: ['none', 'cash', 'xp'],
	milestonesCompared: 72,
	exactMilestones: 72,
	maxRelativeDifference: 0,
	maxFloatGap: 1.5e-13,
	tolerance: 0.005,
	baitsUsedMatch: true,
	// Gear rule sensitivity (regular player): the 5b.1 provisional rod-purchase rule instead of the retired
	// loop's (a fixed tier price saved from net cash after bait), largest relative change in milestone hours.
	gearRuleSensitivity: { archetype: 'regular', none: 0, cash: 0, xp: 0.0037 },
});

// ---------------------------------------------------------------------------------------------
// INTEGRATED lifecycle: every lifecycle number this module reports is an integrate.run() of the reference
// core loop (rods, world, quests, streak, buffs) with variant.bait = policy ('none' adds no bait system).
// XP sources are grouped as R2 groups them (r2.js); the bait's share is carved out of 'fishing'.
const XP_GROUPS = { quests: ['story', 'repeatable'], daily: ['daily', 'weekly'], buffs: ['buff'] };
const xpGroupOf = (src) => (src === 'fishing' ? 'fishing' : Object.keys(XP_GROUPS).find((g) => XP_GROUPS[g].includes(src)) || 'other');

const runCache = new WeakMap();
/** One integrated run (memoised per model, archetype and policy). */
function integratedRun(archetype, policy, model = DEFAULT) {
	const m = policy === 'none' ? DEFAULT : model;
	if (!runCache.has(m)) runCache.set(m, new Map());
	const cache = runCache.get(m);
	const key = `${archetype}|${policy}`;
	if (!cache.has(key)) cache.set(key, INTEGRATE().run({ archetype, variant: { bait: policy }, systemOpts: m === DEFAULT ? {} : { bait: { model: m } } }));
	return cache.get(key);
}

/**
 * One integrated lifecycle with bait bought every cast by `policy`.
 * @param policy 'none' | 'cash' | 'xp' | a bait name
 * @param archetype an F.ARCHETYPES name (or F.MINIMUM_DAILY.name)
 * @param opts { model: a withGear() model (default: the proposed model) }
 * @returns { policy, archetype, model, hoursToLevel, xpSources: { [L]: { day, hours, totalXp, xp, share } },
 *   income, baitSpendShareOfIncome, baitExtraValueShareOfIncome, netEffectShareOfIncome, baitsUsed, byBait }
 *   Income shares are of the run's income before the bait's effect (all cash sources minus the bait's
 *   extra catch value), over the run to the stop level.
 */
function lifecycle(policy = 'none', archetype = F.REFERENCE_ARCHETYPE, { model = DEFAULT } = {}) {
	const r = integratedRun(archetype, policy, model);
	const b = r.sys[SYSTEM_NAME] || null;
	const xpSources = {};
	for (const L of numericKeys(r.milestones)) {
		const m = r.milestones[L];
		const baitXp = b?.milestones[L]?.extraXp ?? 0;
		const xp = { fishing: 0, bait: baitXp, quests: 0, daily: 0, buffs: 0, other: 0 };
		for (const [src, v] of Object.entries(m.ledger.xp)) xp[xpGroupOf(src)] += v;
		xp.fishing -= baitXp;
		const total = sum(Object.values(xp));
		xpSources[L] = { day: m.day, hours: m.hours, totalXp: Math.round(total), xp: mapValues(xp, Math.round), share: mapValues(xp, (v) => r4(v / total)) };
	}
	const income = sum(Object.values(r.ledger.cash));
	const spend = r.ledger.spend.optional?.[SPEND_ITEM.item] || 0;
	const extra = b ? b.extraValue : 0;
	const before = income - extra;
	return {
		policy, archetype, model: `integrated (${INTEGRATE().REFERENCE.join(', ')}${policy === 'none' ? '' : ' + bait'})`, systems: r.systems,
		hoursToLevel: LC.milestoneHours(r),
		xpSources,
		income: { total: Math.round(income), beforeBaitEffect: Math.round(before), baitSpend: Math.round(spend), baitExtraValue: Math.round(extra), baitExtraXp: Math.round(b ? b.extraXp : 0) },
		baitSpendShareOfIncome: r4(spend / before), baitExtraValueShareOfIncome: r4(extra / before), netEffectShareOfIncome: r4((extra - spend) / before),
		baitsUsed: b ? Object.keys(b.byBait) : [],
		byBait: b ? mapValues(b.byBait, (t) => mapValues(pickTally(t), (v) => r2(v))) : {},
		final: { level: r.final.level, hours: r.hours, money: Math.round(r.final.money) },
	};
}

/** 1 - hours(policy) / hours(no bait) at each milestone from Lv 20 that both runs reach. */
function speedups(run, none) {
	return Object.fromEntries(Object.keys(run.hoursToLevel).filter((L) => Number(L) >= 20 && none.hoursToLevel[L]).map((L) => [L, r4(1 - run.hoursToLevel[L] / none.hoursToLevel[L])]));
}
const largest = (o) => Object.entries(o).reduce((a, [L, v]) => (v > a.speedup ? { level: Number(L), speedup: v } : a), { level: null, speedup: -Infinity });
/** The regular player's milestones against the approved windows. */
function windowRows(run, none) {
	return Object.entries(F.TARGET_WINDOWS).map(([L, [lo, hi]]) => {
		const h = run.hoursToLevel[L];
		return { level: Number(L), window: [lo, hi], hours: h, inWindow: h >= lo && h <= hi, shortBy: h < lo ? r2(lo - h) : 0, speedupVsNoBait: r4(1 - h / none.hoursToLevel[L]) };
	});
}

/** The XP-class baits' XP effects (xpBonus, extra-fish chance) scaled uniformly: a sensitivity override. */
function scaledXpBaits(scale) {
	const out = {};
	for (const n of BAIT_NAMES) {
		const b = PARAMS.baits[n];
		if (b.pricing !== 'xp') continue;
		out[n] = { ...(b.stats.xpBonus ? { stats: { xpBonus: b.stats.xpBonus * scale } } : {}), ...(b.multiChance ? { multiChance: b.multiChance * scale } : {}) };
	}
	return out;
}

/** The XP-class baits (pricing 'xp') of a model. */
const xpClassOf = (model) => BAIT_NAMES.filter((n) => model.baits[n].pricing === 'xp');

/**
 * The XP-bait guard for one archetype (user decision on P-BAIT-XP-SIZING): the always-on XP-bait run
 * (policy 'xp') against the same archetype's no-bait run, both integrated.
 *   speedups   1 - hours(xp) / hours(none) at every milestone from Lv 20 both runs reach (active hours)
 *   netSink    bait bought > the bait's extra catch value, for the whole policy (it buys the starter
 *              money baits too) and for the XP-class baits alone; the guard reads the whole policy
 *   pass       netSink (when PARAMS.pricing.xpBaitNetSink) and every speed-up <= maxXpBaitSpeedup
 */
function guardRow(archetype, model = DEFAULT) {
	const none = lifecycle('none', archetype);
	const run = lifecycle('xp', archetype, { model });
	const sp = speedups(run, none);
	const top = largest(sp);
	const xpClass = xpClassOf(model);
	const xpOnly = xpClass.reduce((a, n) => {
		const t = run.byBait[n];
		return t ? { spend: a.spend + t.spend, extraValue: a.extraValue + t.extraValue } : a;
	}, { spend: 0, extraValue: 0 });
	const limit = PARAMS.pricing.maxXpBaitSpeedup;
	const netSink = run.income.baitSpend > run.income.baitExtraValue;
	const overLimit = Object.keys(sp).filter((L) => sp[L] > limit + 1e-9).map(Number);
	return {
		archetype, minutesPerDay: F.ARCHETYPES[archetype].minutesPerDay,
		speedups: sp, maxSpeedup: top.speedup, maxSpeedupAt: top.level, overLimit,
		hoursNone: none.hoursToLevel, hoursXp: run.hoursToLevel,
		baitSpend: run.income.baitSpend, baitExtraValue: run.income.baitExtraValue, netEffectShareOfIncome: run.netEffectShareOfIncome,
		netSink, xpClassNetSink: xpOnly.spend > xpOnly.extraValue, xpClassSpend: Math.round(xpOnly.spend), xpClassExtraValue: Math.round(xpOnly.extraValue),
		pass: (!PARAMS.pricing.xpBaitNetSink || netSink) && !overLimit.length,
	};
}

/** The XP-bait guard for every archetype (F.ARCHETYPES) with a model's XP-bait definitions. */
function xpBaitGuard(model = DEFAULT) {
	const rows = Object.keys(F.ARCHETYPES).map((a) => guardRow(a, model));
	return {
		rule: `always-on XP bait remains a net economic sink and reaches each milestone from Lv 20 at most ${pctOf(PARAMS.pricing.maxXpBaitSpeedup)} sooner (active hours) than the same archetype without bait; every archetype`,
		limit: PARAMS.pricing.maxXpBaitSpeedup, netSinkRequired: PARAMS.pricing.xpBaitNetSink,
		rows,
		overLimit: rows.filter((r) => r.overLimit.length).map((r) => r.archetype),
		notNetSink: rows.filter((r) => !r.netSink).map((r) => r.archetype),
		pass: rows.every((r) => r.pass),
	};
}

/**
 * One sizing row: every archetype's always-on XP-bait run with a model's XP-bait definitions (the guard),
 * plus the regular player's hours and the approved windows (informational: the windows describe the no-bait
 * reference player).
 */
function sizingRow(id, label, model) {
	const ref = F.REFERENCE_ARCHETYPE;
	const none = lifecycle('none', ref);
	const run = lifecycle('xp', ref, { model });
	const guard = xpBaitGuard(model);
	const worst = guard.rows.reduce((a, r) => (r.maxSpeedup > a.maxSpeedup ? r : a));
	return {
		id, label,
		effects: Object.fromEntries(xpClassOf(model).map((n) => [n, { xpBonus: model.baits[n].stats.xpBonus || 0, multiChance: model.baits[n].multiChance || 0, pricePerCast: model.prices()[n].price }])),
		hoursToLevel: run.hoursToLevel,
		windows: windowRows(run, none),
		byArchetype: Object.fromEntries(guard.rows.map((r) => [r.archetype, { maxSpeedup: r.maxSpeedup, at: r.maxSpeedupAt, netSink: r.netSink, netEffectShareOfIncome: r.netEffectShareOfIncome, pass: r.pass }])),
		maxSpeedupAny: worst.maxSpeedup, maxSpeedupAnyArchetype: worst.archetype, maxSpeedupAnyAt: worst.maxSpeedupAt,
		guardPass: guard.pass, overLimit: guard.overLimit, notNetSink: guard.notNetSink,
		baitSpendShareOfIncome: run.baitSpendShareOfIncome, netEffectShareOfIncome: run.netEffectShareOfIncome,
	};
}

let sizingMemo = null;
/**
 * XP-bait sizing on the integrated model (decision P-BAIT-XP-SIZING): the proposed sizing, the design-stage
 * alternative, and the largest uniform scale of the XP-class baits' XP effects that passes the guard for
 * every archetype (bisection; a bound, not a proposal). Prices follow each sizing through the same pricing
 * rule (K x extra XP x the stage's $/XP).
 */
function xpSizing() {
	if (sizingMemo) return sizingMemo;
	const passes = (scale) => xpBaitGuard(createBaitModel(null, { baits: scaledXpBaits(scale) })).pass;
	let lo = 0;
	let hi = 1;
	if (xpBaitGuard(DEFAULT).pass) {lo = 1;}
	else {
		for (let i = 0; i < XP_SIZING.bisectSteps; i++) {
			const mid = (lo + hi) / 2;
			if (passes(mid)) lo = mid;
			else hi = mid;
		}
	}
	const rows = [
		sizingRow('proposed', 'proposed (PARAMS)', DEFAULT),
		sizingRow('design-stage', 'design-stage alternative', createBaitModel(null, { baits: XP_SIZING.designStage })),
		...(lo < 1 ? [sizingRow('guard-bound', `largest uniform scale passing the guard for every archetype (×${r3(lo)}; a bound, not a proposal)`, createBaitModel(null, { baits: scaledXpBaits(lo) }))] : []),
	];
	sizingMemo = { policy: 'xp', archetypes: Object.keys(F.ARCHETYPES), scaleBound: r3(lo), bisectSteps: XP_SIZING.bisectSteps, rows };
	return sizingMemo;
}

let sensitivityMemo = null;
/**
 * Every archetype x 'none' / 'cash' / 'xp' on the integrated model; the approved windows (regular player;
 * informational: they describe the no-bait reference player); the XP-bait guard for every archetype
 * (xpBaitGuard()) and the XP-bait sizing sensitivity.
 */
function lifecycleSensitivity() {
	if (sensitivityMemo) return sensitivityMemo;
	const ref = F.REFERENCE_ARCHETYPE;
	const names = Object.keys(F.ARCHETYPES);
	const runs = Object.fromEntries(names.map((a) => [a, Object.fromEntries(POLICIES.map((p) => [p, lifecycle(p, a)]))]));
	const guard = xpBaitGuard();
	const byArchetype = Object.fromEntries(names.map((a) => {
		const cash = largest(speedups(runs[a].cash, runs[a].none));
		const xp = largest(speedups(runs[a].xp, runs[a].none));
		const g = guard.rows.find((r) => r.archetype === a);
		return [a, { hours: mapValues(runs[a], (x) => x.hoursToLevel), cash, xp, xpOverCap: g.overLimit.length > 0, xpNetSink: g.netSink }];
	}));
	const windows = Object.entries(F.TARGET_WINDOWS).map(([L, w]) => ({
		level: Number(L), window: w,
		...Object.fromEntries(POLICIES.map((p) => [p, windowRows(runs[ref][p], runs[ref].none).find((x) => x.level === Number(L))])),
	}));
	sensitivityMemo = {
		model: `Model: integrate.run(), the reference core loop (${INTEGRATE().REFERENCE.join(', ')}); the bait columns add system({ policy }) through variant.bait 'cash' | 'xp'`,
		archetypes: runs,
		windows,
		byArchetype,
		xpBaitGuard: guard,
		xpSizing: xpSizing(),
	};
	return sensitivityMemo;
}

// ---------------------------------------------------------------------------------------------
// PROPOSED decisions (status 'proposed' only: only the user approves). get() reads what the model runs;
// decisions.verify() checks it against `expected`. The framework-level entries this design relies on
// (P-LUCKY, P-DOUBLE-CASH, P-EVENTS) and the box owners' bait-slot rule (P-STREAK-BAIT-PACK) live elsewhere.
const P = PARAMS.pricing;
/** A fraction as a percentage for decision texts (no float noise). */
const pctOf = (x) => `${+(x * 100).toFixed(6)}%`;
const DECISIONS = [
	{
		id: 'P-BAIT-PER-CAST', status: 'proposed',
		title: 'Bait is consumed once per successful cast, not per fish, for every profile',
		modelled: `${PARAMS.consumption.perCast} unit per ${PARAMS.consumption.unit}; a Founder cast uses one too; a failed cast (no catch, broken rod) uses none`,
		alternatives: ['per fish (today: every fish of a multi-catch burns a unit; today\'s Founder about three per cast)'],
		source: 'bait design', why: 'a fixed, knowable cost per cast; jackpots never cost more bait; no Founder tell in bait counts (Consumption)',
		get: () => ({ unit: PARAMS.consumption.unit, perCast: PARAMS.consumption.perCast, profileIndependent: PARAMS.consumption.profileIndependent }),
		expected: { unit: 'cast', perCast: 1, profileIndependent: true },
	},
	{
		id: 'P-BAIT-WHERE-IT-WORKS', status: 'proposed',
		title: 'Bait works only in its listed biomes: elsewhere no stats, no XP bonus, and no unit is used',
		modelled: `onlyWhereItWorks ${PARAMS.consumption.onlyWhereItWorks}`,
		alternatives: ['today: the XP multiplier applies in every biome and units burn everywhere'],
		source: 'bait design', why: 'biome lists are the balance lever: a fixed price against biome-scaled value would otherwise balloon returns up the ladder (Starter baits)',
		get: () => PARAMS.consumption.onlyWhereItWorks, expected: true,
	},
	{
		id: 'P-BAIT-ROSTER', status: 'proposed',
		title: 'Ten baits, one clear role each: two starter baits, five mid-band specialists, two late combination baits and one universal luck bait; Spinner (the only volume bait) works only in the mid-band biomes, on any rod tier, its mean capped at the global ceiling (P-BAIT-SPINNER-TIERS)',
		modelled: BAIT_NAMES.map((n) => `${n}: ${PARAMS.baits[n].role}`).join('; '),
		alternatives: ['today\'s roster (stacked capabilities, water-type biome lists, XP multipliers everywhere)', 'Spinner in the late band too (Coast, Swamp: Tier 3-5 rods would get it at their own stage)'],
		source: 'bait design', why: 'the player chooses by goal (collection, trophies, Legendary hunting, jackpots, XP); each band gets one specialist per role (Roster)',
		get: () => Object.fromEntries(BAIT_NAMES.map((n) => {
			const b = PARAMS.baits[n];
			return [n, { band: b.band, biomes: b.biomes, grantsStrong: b.grantsStrong, stats: b.stats, multiChance: b.multiChance, pricing: b.pricing }];
		})),
		expected: {
			'Shrimp': { band: 'starter', biomes: ['Ocean'], grantsStrong: true, stats: {}, multiChance: 0, pricing: 'money' },
			'Worm': { band: 'starter', biomes: ['River'], grantsStrong: true, stats: {}, multiChance: 0, pricing: 'money' },
			'Fly': { band: 'mid', biomes: ['Lake', 'Pond'], grantsStrong: false, stats: { rareFind: 1 }, multiChance: 0, pricing: 'money' },
			'Minnow': { band: 'mid', biomes: ['Lake', 'Pond'], grantsStrong: false, stats: { trophyChance: 1.5 }, multiChance: 0, pricing: 'money' },
			'Magnet': { band: 'mid', biomes: ['Lake', 'Pond'], grantsStrong: false, stats: { luck: 2 }, multiChance: 0, pricing: 'money' },
			'Spinner': { band: 'mid', biomes: ['Lake', 'Pond'], grantsStrong: false, stats: {}, multiChance: 0.1, pricing: 'xp' },
			'Lure': { band: 'mid', biomes: ['Lake', 'Pond'], grantsStrong: false, stats: { xpBonus: 0.15 }, multiChance: 0, pricing: 'xp' },
			'Bloodworm': { band: 'late', biomes: ['Coast', 'Swamp'], grantsStrong: false, stats: { rareFind: 1, trophyChance: 0.75 }, multiChance: 0, pricing: 'money' },
			'Magic Lure': { band: 'late', biomes: ['Coast', 'Swamp'], grantsStrong: false, stats: { rareFind: 0.75, trophyChance: 0.75, luck: 0.75, xpBonus: 0.12 }, multiChance: 0, pricing: 'xp' },
			'Strong Magnet': { band: 'universal', biomes: ['Ocean', 'River', 'Lake', 'Pond', 'Coast', 'Swamp'], grantsStrong: false, stats: { luck: 4 }, multiChance: 0, pricing: 'money' },
		},
	},
	{
		id: 'P-BAIT-STARTER-BIOME', status: 'proposed',
		title: 'Strong-fish access comes only from the two starter baits, each in its own starter biome',
		modelled: BAIT_NAMES.filter((n) => PARAMS.baits[n].grantsStrong).map((n) => `${n}: ${PARAMS.baits[n].biomes.join(', ')}`).join('; '),
		alternatives: ['by water type (today: Shrimp in salt water, Worm in fresh water)', 'strong access on more baits (today: most of the catalog)'],
		source: 'bait design', why: 'from Lv 20 every crafted rod reaches strong fish; in later biomes strong access at a starter price would be a money-maker for players who never craft (Starter baits)',
		get: () => ({ strongAccess: BAIT_NAMES.filter((n) => PARAMS.baits[n].grantsStrong), Shrimp: PARAMS.baits.Shrimp.biomes, Worm: PARAMS.baits.Worm.biomes }),
		expected: { strongAccess: ['Shrimp', 'Worm'], Shrimp: ['Ocean'], Worm: ['River'] },
	},
	{
		id: 'P-BAIT-UNIVERSAL', status: 'proposed',
		title: 'Strong Magnet is the one universal bait (collection completion): every live biome, priced at Swamp, no strong access; Mountain Stream gets its own bait band later',
		modelled: `biomes ${PARAMS.baits['Strong Magnet'].biomes.join(', ')}; priced at ${PARAMS.baits['Strong Magnet'].homeStages.join(', ')}`,
		alternatives: ['a Lake/Pond-priced luck bait everywhere (a money-maker in late biomes)', 'keep legacy strong access (an Old Rod money-maker in Swamp)'],
		source: 'bait design', why: 'priced at the most valuable stage it works in, it is a deliberate cash loss below Swamp and never a money-maker anywhere (Chase)',
		get: () => ({ biomes: PARAMS.baits['Strong Magnet'].biomes, homeStages: PARAMS.baits['Strong Magnet'].homeStages, grantsStrong: PARAMS.baits['Strong Magnet'].grantsStrong }),
		expected: { biomes: ['Ocean', 'River', 'Lake', 'Pond', 'Coast', 'Swamp'], homeStages: ['swamp-t4'], grantsStrong: false },
	},
	{
		id: 'P-BAIT-MONEY-RETURN', status: 'proposed',
		title: 'Money baits are priced for a modest positive cash return at home, with the net gain capped as a share of the cast',
		modelled: `return ${P.returnTarget} per $1 at the geometric centre of the home stages; accepted ${P.moneyReturnBand.join('-')} at every home stage; net gain at most ${pctOf(P.netShareMax)} of the cast's value`,
		alternatives: ['a return of 1.0 (bait as a pure sink)', 'a higher return (bait becomes mandatory)'],
		source: 'bait design', why: 'bait pays back a little where it works, so it is worth buying, while skipping it costs little (Home stages; Pricing checks)',
		get: () => ({ returnTarget: P.returnTarget, moneyReturnBand: P.moneyReturnBand, netShareMax: P.netShareMax }),
		expected: { returnTarget: 1.3, moneyReturnBand: [1, 1.7], netShareMax: 0.06 },
	},
	{
		id: 'P-BAIT-XP-PRICE', status: 'proposed',
		title: 'XP-class baits are priced at K times the stage\'s own cash per XP (K = 1: an hour of income buys an hour of XP); their cash effect is charged at par',
		modelled: `K ${P.xpPriceK}; accepted utility return ${P.xpUtilityBand.join('-')} at every home stage`,
		alternatives: ['K > 1 (XP bait a premium luxury)', 'K < 1 (XP bait close to mandatory)'],
		source: 'bait design', why: 'converts money into time at the stage\'s own exchange rate; XP baits are band-restricted because XP gets dearer in cash up the ladder (Stage rates)',
		get: () => ({ xpPriceK: P.xpPriceK, xpUtilityBand: P.xpUtilityBand }),
		expected: { xpPriceK: 1, xpUtilityBand: [0.75, 1.35] },
	},
	{
		id: 'P-BAIT-XP-SIZING', status: 'proposed',
		title: 'XP bonuses kept at the proposed values. Guard: always-on XP bait must remain a net economic sink and may cut milestone active time by no more than about the cap against the equivalent no-bait run, for every archetype; the approved progression windows describe the no-bait reference player, not bait buyers',
		modelled: `Lure XP +${pctOf(PARAMS.baits.Lure.stats.xpBonus)}, Magic Lure XP +${pctOf(PARAMS.baits['Magic Lure'].stats.xpBonus)}, Spinner extra-fish chance +${pctOf(PARAMS.baits.Spinner.multiChance)}; guard: net sink ${P.xpBaitNetSink}, speed-up cap ${pctOf(P.maxXpBaitSpeedup)} (hours to each milestone from Lv 20, every archetype against its own no-bait run)`,
		alternatives: ['the design-stage alternative (smaller XP bonuses; XP-bait sizing)', 'scale the XP bonuses down to the guard bound so every archetype stays under the cap (XP-bait sizing)', 'no XP-class baits', 'superseded test: the always-on buyer must stay inside the approved windows (replaced by the user)'],
		source: 'bait design; user decision (keep the proposed values, replace the window test with the net-sink and speed-up guard)', why: 'a paid, optional accelerator: it must cost more cash than it returns and must not become a second progression curve; archetypes over the cap are flagged, not tuned away (XP-bait guard; XP-bait sizing)',
		get: () => ({ 'Lure': PARAMS.baits.Lure.stats.xpBonus, 'Magic Lure': PARAMS.baits['Magic Lure'].stats.xpBonus, 'Spinner': PARAMS.baits.Spinner.multiChance, 'maxXpBaitSpeedup': P.maxXpBaitSpeedup, 'xpBaitNetSink': P.xpBaitNetSink }),
		expected: { 'Lure': 0.15, 'Magic Lure': 0.12, 'Spinner': 0.1, 'maxXpBaitSpeedup': 0.12, 'xpBaitNetSink': true },
	},
	{
		id: 'P-BAIT-PACK', status: 'proposed',
		title: 'Sold in packs of casts, pack prices rounded to whole dollars',
		modelled: `${P.packSize} casts per pack; $1 steps below $100, $5 steps above`,
		alternatives: ['single units at a fractional price (money is an integer)', 'larger packs'],
		source: 'bait design', why: 'per-cast prices are a few dollars; integer pack prices keep them precise (Proposed prices)',
		get: () => ({ packSize: P.packSize, packRoundTo: P.packRoundTo }),
		expected: { packSize: 10, packRoundTo: [{ below: 100, step: 1 }, { below: Infinity, step: 5 }] },
	},
	{
		id: 'P-BAIT-SHOP-LEVEL', status: 'proposed',
		title: 'Each bait is sold from the unlock level of its first biome; Strong Magnet with the late band',
		modelled: BAIT_NAMES.map((n) => `${n} Lv ${F.BIOME_LEVEL[PARAMS.baits[n].levelFromBiome]}`).join(', '),
		alternatives: ['today\'s level requirements', 'Strong Magnet from Lv 0 (a universal bait for new players)'],
		source: 'bait design', why: 'a bait is offered when the player can first use it; Strong Magnet is an endgame collection tool',
		get: () => Object.fromEntries(BAIT_NAMES.map((n) => [n, DEFAULT.prices()[n].levelRequirement])),
		expected: { 'Shrimp': 0, 'Worm': 10, 'Fly': 20, 'Minnow': 20, 'Magnet': 20, 'Spinner': 20, 'Lure': 20, 'Bloodworm': 40, 'Magic Lure': 40, 'Strong Magnet': 40 },
	},
	{
		id: 'P-BAIT-OPTIONAL-SINK', status: 'proposed',
		title: 'Bait spending is an optional sink, never mandatory upkeep',
		modelled: `spend item ${SPEND_ITEM.category}.${SPEND_ITEM.item}`,
		alternatives: ['upkeep (bait required to fish competitively)'],
		source: 'bait design (user decision 10 categories)', why: 'no stage requires bait; money bait returns a small net gain and XP bait buys time (Income and XP sources)',
		get: () => ({ ...SPEND_ITEM }), expected: { category: 'optional', item: 'bait' },
	},
	{
		id: 'P-BAIT-LEGACY-STACKS', status: 'proposed',
		title: 'Owned bait stacks keep their count (one unit = one cast under the new rules); no refunds; behaviour read by name from the new definitions; a stack held below its bait\'s shop level works only once the player reaches that level',
		modelled: `migration rule (not a PARAMS value). The wait is enforced by biome access for every bait whose biomes open at or after its shop level; ${legacyLevelCheck().needUseTimeCheck.join(', ')} (Lv ${legacyLevelCheck().needUseTimeCheck.map((n) => DEFAULT.prices()[n].levelRequirement).join(', ')}) also works in earlier biomes and needs a use-time level check (cast.js baitApplies reads BAIT_DEFS[name].levelRequirement against the gate level, never the owned copy)`,
		alternatives: ['refund the difference between the old and the new price', 'convert stacks by value', `no use-time level check: legacy ${legacyLevelCheck().needUseTimeCheck.join(', ')} stacks below the shop level work in ${legacyLevelCheck().rows.filter((r) => !r.enforcedByBiomeAccess).map((r) => r.usableBelowShopLevelIn.join(', ')).join('; ')} at release (Legacy stacks below the shop level)`],
		source: 'bait design', why: 'no player document is rewritten; legacy units work better than before within the new biome lists (Migrations). Today no level check on bait use or /equip blocks anything (fix-first: equip.js)',
	},
	{
		id: 'P-BAIT-SPINNER-TIERS', status: 'proposed',
		title: 'Spinner keeps its extra-fish boost on every rod tier in its biomes, but the rod + Spinner mean fish per cast is clamped at the global normal-player ceiling (the chance whose mean is the ceiling); rods at or above the ceiling get no extra fish from it; no tier gate and no per-tier or mid-band clamp',
		modelled: `Spinner +${pctOf(PARAMS.baits.Spinner.multiChance)} extra-fish chance in ${PARAMS.baits.Spinner.biomes.join(', ')} on any rod; combined chance capped at F.chanceForMean(${volumeCap().mean}) (rods.PARAMS.multi.ceilingMean, P-RODS-MEAN-FISH), in the per-cast model and in system() (Spinner by rod tier)`,
		alternatives: [
			'no clamp: an optional, paid overshoot above the ceiling on the top tiers (Spinner by rod tier, unclamped column)',
			'clamp the rod + bait mean at the mid band\'s rod range (also cuts Spinner\'s home-stage effect: its price would have to be re-derived)',
			'Spinner only on rods up to the mid band\'s top tier (T2)',
		],
		source: 'bait design (adversarial review); user decision (clamp at the ceiling)', why: 'keeps Spinner\'s intended boost wherever it fits under the ceiling (its home stages and price are unchanged), while no normal player ever averages more fish per cast than the global ceiling (Spinner by rod tier; Pricing checks)',
		get: () => ({ biomes: PARAMS.baits.Spinner.biomes, multiChance: PARAMS.baits.Spinner.multiChance, clampAt: PARAMS.volume.clampAt, ceilingMean: volumeCap().mean }),
		expected: { biomes: ['Lake', 'Pond'], multiChance: 0.1, clampAt: 'ceiling', ceilingMean: 1.8 },
	},
];

// ---------------------------------------------------------------------------------------------
/** The system's contract and the retired loop's parity record, for report(). */
function systemReport() {
	return {
		name: SYSTEM_NAME,
		policies: [...POLICIES, ...BAIT_NAMES],
		hooks: ['init', 'modifyCast', 'onCasts', 'on'],
		events: { listens: ['levelUp'], emits: [] },
		ledger: {
			xpSources: [], cashSources: [], spend: [{ ...SPEND_ITEM }],
			note: 'The core\'s \'fishing\' XP/cash includes the bait effect. The bait\'s own share is state.sys.bait.extraXp / extraPublicXp / extraValue (totals, byBait, stages, and snapshots at milestones / publicMilestones).',
		},
		integration: 'integrate.run({ variant: { bait: \'cash\' | \'xp\' } }) adds system({ policy }); systemOpts.bait.model runs an alternative sizing',
		retiredLoopParity: RETIRED_LOOP_PARITY,
	};
}

const decisionRows = () => DECISIONS.map((d) => ({ ...Object.fromEntries(Object.entries(d).filter(([k]) => k !== 'get' && k !== 'expected')), recordMatchesModel: d.get ? JSON.stringify(d.get()) === JSON.stringify(d.expected) : null }));

let reportMemo = null;
/**
 * The full report: the per-cast model (opts.gearPath rebuilds it on another rod path), the integrated
 * lifecycle (always on the shared path: the rods system buys the shared tiers), the system contract with
 * the retired loop's parity record, and the proposed decisions.
 */
function report(opts = {}) {
	if (!opts.gearPath && reportMemo) return reportMemo;
	const model = opts.gearPath ? createBaitModel(opts.gearPath) : DEFAULT;
	const out = { ...model.report(), legacyLevel: legacyLevelCheck(model), lifecycle: lifecycleSensitivity(), system: systemReport(), decisions: decisionRows() };
	if (!opts.gearPath) reportMemo = out;
	return out;
}

// ---------------------------------------------------------------------------------------------
// Markdown tables for docs/economy/5b/bait.md (render-docs.js). Every number in the doc comes from here.
const esc = (c) => String(c).replace(/\|/g, '\\|');
const mdTable = (head, rows) => [`| ${head.join(' | ')} |`, `| ${head.map(() => '---').join(' | ')} |`, ...rows.map((row) => `| ${row.map(esc).join(' | ')} |`)].join('\n');
const digits = (x, d) => Math.abs(Number(x)).toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d });
/** Sign of x as printed at d decimals (0 when it rounds to zero, so no '-0.00'). */
const signAt = (x, d) => (Number(digits(x, d).replace(/,/g, '')) === 0 ? 0 : Math.sign(x));
const num = (x, d = 2) => `${signAt(x, d) < 0 ? '−' : ''}${digits(x, d)}`;
const usd = (x, d = 2) => `${signAt(x, d) < 0 ? '−' : ''}$${digits(x, d)}`;
const pct = (x, d = 1) => `${num(x * 100, d)}%`;
const spct = (x, d = 1) => `${['−', '', '+'][signAt(x * 100, d) + 1]}${digits(x * 100, d)}%`;
const hrs = (h) => (h === undefined || h === null ? '—' : `${num(h, 2)} h`);
const int = (x) => num(x, 0);
const yes = (b) => (b ? 'yes' : '**no**');
const range = (xs, fmt) => {
	const lo = Math.min(...xs);
	const hi = Math.max(...xs);
	return lo === hi ? fmt(lo) : `${fmt(lo)}–${fmt(hi)}`;
};
const tierName = (t) => (t === 'old' ? 'Old Rod' : t.replace(/^t/, 'T'));
const stageName = (id) => {
	const [biome, tier] = String(id).split('-');
	return `${cap(biome)} · ${tierName(tier)}`;
};
const STAT_LABEL = { rareFind: 'Rare Find', trophyChance: 'Trophy', luck: 'Luck', xpBonus: 'XP', multiChance: 'extra-fish chance', perDraw: 'fish/draw' };
const effectText = (b) => [
	...(b.grantsStrong ? ['strong access'] : []),
	...Object.entries(b.stats).map(([k, v]) => `${STAT_LABEL[k] || k} +${num(v * 100, 0)}%`),
	...(b.multiChance ? [`extra-fish chance +${num(b.multiChance * 100, 0)}%`] : []),
].join(', ') || '—';
const engineText = (c) => {
	const parts = Object.entries(c.engineStats).map(([k, v]) => (k === 'perDraw' ? `+${v} fish/draw` : `${STAT_LABEL[k] || k} +${num(v * 100, 0)}%`));
	if ((c.capabilities || []).includes('strong')) parts.push('strong');
	return parts.join(', ') || 'none';
};

function markdownTables() {
	const R = report();
	const L = R.lifecycle;
	const ref = F.REFERENCE_ARCHETYPE;
	const reg = L.archetypes[ref];
	const bc = R.bandCheck;
	const vc = R.volumeCheck;
	const vs = vc.summary.Spinner;
	const T = {};
	const byName = Object.fromEntries(R.currentVsProposed.map((x) => [x.bait, x]));
	const xpNames = BAIT_NAMES.filter((n) => PARAMS.baits[n].pricing === 'xp');
	const homeRows = BAIT_NAMES.flatMap((n) => byName[n].proposed.home.map((h) => ({ name: n, h })));
	const moneyReturns = homeRows.filter((x) => PARAMS.baits[x.name].pricing === 'money').map((x) => x.h.cashReturn);
	const xpRatios = homeRows.filter((x) => PARAMS.baits[x.name].pricing === 'xp').map((x) => x.h.xpPriceRatio);
	const xpUtility = homeRows.filter((x) => PARAMS.baits[x.name].pricing === 'xp').map((x) => x.h.utilityReturn);
	const netShares = homeRows.filter((x) => PARAMS.baits[x.name].pricing === 'money').map((x) => x.h.netShareOfCast);
	const G = L.xpBaitGuard;
	const gReg = G.rows.find((r) => r.archetype === ref);
	const cashTop = L.byArchetype[ref].cash;
	const anyXp = Object.entries(L.byArchetype).reduce((a, [name, x]) => (x.xp.speedup > a.speedup ? { name, ...x.xp } : a), { speedup: -Infinity });
	const tiersNonOld = R.consumption.byTier.filter((t) => t.tier !== 'old');
	const PR = RETIRED_LOOP_PARITY;

	// ----- Summary -----
	T['bait-headline'] = mdTable(['Figure', 'Value', 'Table'], [
		['Consumption', `${PARAMS.consumption.perCast} unit per successful cast where the bait works; per fish would be ${range(tiersNonOld.map((t) => t.perFishUnitsPerCast), (x) => num(x, 2))} units/cast on Tiers ${tierName(tiersNonOld[0].tier).slice(1)}–${tierName(tiersNonOld[tiersNonOld.length - 1].tier).slice(1)}`, 'Consumption'],
		['Money baits: cash return per $1 at their home stages', `${range(moneyReturns, (x) => num(x, 2))} (target ${P.returnTarget}, accepted ${P.moneyReturnBand.join('–')})`, 'Home stages'],
		['XP baits: net $ per extra XP against the stage\'s own rate', `${range(xpRatios, (x) => `${num(x, 2)}×`)} (target K = ${P.xpPriceK})`, 'Home stages'],
		['Pricing checks', `${bc.pass ? 'all pass' : `${bc.issues.length} issue(s)`}`, 'Pricing checks'],
		['Spinner on any rod tier in Lake and Pond, clamped at the ceiling', `mean fish per cast up to ${num(vs.maxMeanWith, 3)} (ceiling ${num(vs.ceiling, 2)}: ${vs.tiersAboveCeiling.length ? `**above on ${vs.tiersAboveCeiling.map(tierName).join(', ')}**` : 'never above'}); the clamp binds on ${vs.tiersClamped.map(tierName).join(', ') || 'no tier'}, no extra fish on ${vs.tiersNoEffect.map(tierName).join(', ') || 'no tier'}; unclamped it would reach ${num(vs.maxMeanUnclamped, 3)} (\`P-BAIT-SPINNER-TIERS\`)`, 'Spinner by rod tier'],
		['Bait held below its shop level (legacy stacks, box grants)', `waits through biome access, except ${R.legacyLevel.needUseTimeCheck.join(', ') || 'none'}: needs a use-time level check (\`P-BAIT-LEGACY-STACKS\`)`, 'Legacy stacks below the shop level'],
		['Money bait always on, regular player (integrated)', `net ${spct(reg.cash.netEffectShareOfIncome)} of income; milestones at most ${pct(cashTop.speedup)} sooner`, 'Regular player; Income and XP sources'],
		['XP bait always on, regular player (integrated)', `L50 ${hrs(reg.none.hoursToLevel[50])} → ${hrs(reg.xp.hoursToLevel[50])}; largest speed-up ${pct(gReg.maxSpeedup)} at L${gReg.maxSpeedupAt}; net ${spct(reg.xp.netEffectShareOfIncome)} of income`, 'Regular player'],
		['XP-bait guard, every archetype: a net sink, and at most the cap sooner than its own no-bait run', `net sink: ${G.notNetSink.length ? `**not for ${G.notNetSink.join(', ')}**` : 'every archetype'}; cap ${pct(G.limit, 0)}: ${G.overLimit.length ? `**over for ${G.overLimit.join(', ')}**` : 'every archetype within'}; largest ${pct(anyXp.speedup)} (${anyXp.name}, L${anyXp.level})`, 'XP-bait guard'],
		['Retired private loop', `system() matched it exactly: ${PR.exactMilestones}/${PR.milestonesCompared} milestones step-exact (${PR.commit})`, 'Retired-loop parity'],
	]);

	// ----- Decisions for approval -----
	T['bait-decisions'] = `${mdTable(['ID', 'Proposed decision', 'Modelled', 'Alternatives', 'Why', 'Record = model'], DECISIONS.map((d) => [
		`\`${d.id}\``, d.title, d.modelled, d.alternatives.join('; '), d.why,
		d.get ? yes(JSON.stringify(d.get()) === JSON.stringify(d.expected)) : 'n/a (not a PARAMS value)',
	]))}\n\nStatus of every entry: \`${[...new Set(DECISIONS.map((d) => d.status))].join(', ')}\`. Only the user approves; \`decisions.js\` joins these to the Phase 5B registry (alongside the framework's \`P-LUCKY\`, \`P-DOUBLE-CASH\` and \`P-EVENTS\`, and the streak design's \`P-STREAK-BAIT-PACK\`, which this design relies on) and \`check-shared.js\` verifies each record against the model.`;

	// ----- Consumption -----
	const fdr = R.consumption.founderToday;
	T['bait-consumption'] = mdTable(['Rod', 'Units/cast if consumed per fish', 'Units/cast, proposed', 'P(≥3 units in one cast), per fish', 'P(5 units), per fish'], [
		...R.consumption.byTier.map((t) => [tierName(t.tier), num(t.perFishUnitsPerCast, 2), t.perCastUnitsPerCast, pct(t.pUnitsAtLeast3PerFish), pct(t.pUnits5PerFish)]),
		['Founder today (starter rod, bonus draws)', num(fdr.perFishUnitsPerCast, 2), fdr.perCastUnitsPerCast, '—', '—'],
	]);

	// ----- Roster -----
	const bandRow = (band, label) => {
		const inBand = BAIT_NAMES.filter((n) => PARAMS.baits[n].band === band);
		const col = (pred, fmt) => inBand.filter((n) => pred(PARAMS.baits[n])).map((n) => fmt(n, PARAMS.baits[n])).join(', ') || '—';
		const stat = (k) => col((b) => b.stats[k], (n, b) => `${n} (+${num(b.stats[k] * 100, 0)}%)`);
		return [label, col((b) => b.grantsStrong, (n, b) => `${n} (${b.biomes.join(', ')})`), stat('rareFind'), stat('trophyChance'), stat('luck'), col((b) => b.multiChance, (n, b) => `${n} (+${num(b.multiChance * 100, 0)}%)`), stat('xpBonus')];
	};
	const typical = (bs) => [...new Set(bs.map((b) => tierName(SHARED.typicalTier[b])))].join('–');
	T['bait-roster'] = mdTable(['Band (biomes · typical rod)', 'Strong access', 'Rare Find (Rare/Ultra)', 'Trophy (Giant)', 'Luck (Legendary/Lucky)', 'Extra-fish chance (jackpots)', 'XP'], [
		...['starter', 'mid', 'late'].map((band) => bandRow(band, `**${cap(band)}** (${PARAMS.bands[band].biomes.join(', ')} · ${typical(PARAMS.bands[band].biomes)})`)),
		bandRow('universal', `**Universal** (every live biome · priced at ${PARAMS.baits['Strong Magnet'].homeStages.map(stageName).join(', ')})`),
	]);

	// ----- Current -> proposed -----
	T['bait-current'] = mdTable(['Bait', 'Price/unit', 'Consumption', 'Cost/cast', 'Works in', 'Engine stats', 'XP mult', 'Best return per $1 (biome)', '$ per extra XP'], R.currentVsProposed.map((x) => {
		const c = x.current;
		return [x.bait, usd(c.price, 0), c.consumption, range(c.costPerCastRange, (v) => usd(v, 0)), c.biomes.join(', '), engineText(c), `×${c.xpMultiplier}`, c.bestReturnPerDollarOldRod === null ? '—' : `${num(c.bestReturnPerDollarOldRod, 2)} (${c.bestBiome})`, c.medianCostPerExtraXp === null ? '—' : usd(c.medianCostPerExtraXp, 0)];
	}));
	T['bait-proposed'] = mdTable(['Bait', 'Role', 'Works in', 'Shop from', 'Effect', `Pack of ${P.packSize} casts`, 'Per cast', 'Pricing'], R.currentVsProposed.map((x) => {
		const p = x.proposed;
		return [x.bait, p.role, p.biomes.length === ALL.length ? `every live biome (${p.biomes.length})` : p.biomes.join(', '), `Lv ${p.levelRequirement}`, effectText(PARAMS.baits[x.bait]), usd(p.packPrice, 0), usd(p.price), p.pricing === 'xp' ? 'XP' : 'money'];
	}));
	T['bait-home'] = mdTable(['Bait', 'Stage', 'Base $/cast', '+$/cast', '+XP/cast (share)', 'Cost/cast', 'Cash return per $1', 'Net gain (share of cast)', 'Net $ per extra XP', '× stage $/XP', 'Jackpot 3+ (base → bait)'], homeRows.map(({ name, h }) => {
		const xpClass = PARAMS.baits[name].pricing === 'xp';
		const profit = !xpClass && h.netCostPerXp !== null && h.netCostPerXp < 0;
		return [
			name, stageName(`${h.biome.toLowerCase()}-${h.tier}`), usd(h.baseValuePerCast), usd(h.extraValuePerCast), h.extraXpPerCast > 0.005 ? `${num(h.extraXpPerCast, 2)} (${spct(h.extraXpShare)})` : '0',
			usd(h.price), xpClass ? num(h.cashReturn, 2) : `**${num(h.cashReturn, 2)}**`, spct(h.netShareOfCast),
			xpClass ? usd(h.netCostPerXp) : profit || h.netCostPerXp === null ? 'profit' : usd(h.netCostPerXp), xpClass ? `**${num(h.xpPriceRatio, 2)}×**` : '—',
			h.jackpot3plus[0] === h.jackpot3plus[1] ? (h.jackpot3plus[0] > 0 ? pct(h.jackpot3plus[0]) : '—') : `${pct(h.jackpot3plus[0])} → ${pct(h.jackpot3plus[1])}`,
		];
	}));
	T['bait-stage-rates'] = mdTable(['Typical stage', 'Cash per cast', 'XP per cast', 'Stage $/XP'], R.stageRates.map((s) => [stageName(s.stage), usd(s.valuePerCast), num(s.xpPerCast, 2), usd(s.cashPerXp)]));
	const lim = (ok) => (ok ? 'pass' : '**fail**');
	T['bait-checks'] = mdTable(['Check', 'Target', 'Measured', 'Result'], [
		['Money baits: cash return at every home stage', `${P.moneyReturnBand.join('–')} (centre ${P.returnTarget})`, range(moneyReturns, (x) => num(x, 2)), lim(moneyReturns.every((x) => x >= P.moneyReturnBand[0] && x <= P.moneyReturnBand[1]))],
		['Money baits: net gain, share of the cast', `≤ ${pct(P.netShareMax, 0)}`, `≤ ${pct(Math.max(...netShares))}`, lim(Math.max(...netShares) <= P.netShareMax)],
		['XP baits: utility return at every home stage', P.xpUtilityBand.join('–'), range(xpUtility, (x) => num(x, 2)), lim(xpUtility.every((x) => x >= P.xpUtilityBand[0] && x <= P.xpUtilityBand[1]))],
		['XP baits: net $ per extra XP against the stage rate', `centre K = ${P.xpPriceK}`, range(xpRatios, (x) => `${num(x, 2)}×`), 'reported'],
		['Volume bait (Spinner, clamped): mean fish per cast on every rod tier in its biomes', `≤ the global ceiling (${num(vs.ceiling, 2)}, \`P-BAIT-SPINNER-TIERS\`)`, `up to ${num(vs.maxMeanWith, 3)}; above the ceiling on ${vs.tiersAboveCeiling.map(tierName).join(', ') || 'none'}`, lim(vc.pass)],
		['Volume bait (Spinner): against the mid band\'s rod range', `${num(vs.bandTop, 2)} (informational: the clamp is at the ceiling, not here)`, `above the range on ${vs.tiersAboveBand.map(tierName).join(', ') || 'none'}`, 'reported'],
		['No money bait above the band at a typical stage outside its home', `≤ ${P.moneyReturnBand[1]}`, bc.issues.filter((s) => s.includes('not home')).length ? bc.issues.filter((s) => s.includes('not home')).join('; ') : 'none above', lim(!bc.issues.some((s) => s.includes('not home')))],
		['Always-on XP bait remains a net economic sink, every archetype (integrated)', 'bait bought > extra catch value', G.rows.map((r) => `${r.archetype} ${spct(r.netEffectShareOfIncome)} of income`).join(', '), G.notNetSink.length ? `**fail**: ${G.notNetSink.join(', ')}` : 'pass'],
		['Always-on XP bait: milestone active time against the same archetype without bait, every milestone from L20 (integrated)', `≤ ${pct(G.limit, 0)} sooner (hard guard, user decision D3)`, G.rows.map((r) => `${r.archetype} ${pct(r.maxSpeedup)} (L${r.maxSpeedupAt})`).join(', '), G.overLimit.length ? `**flag for the user**: over for ${G.overLimit.join(', ')} (\`P-BAIT-XP-SIZING\`)` : 'pass'],
	]);

	// ----- Spinner by rod tier -----
	const flag = (b) => (b ? '**yes**' : 'no');
	T['bait-volume'] = mdTable(['Rod (from Lv)', 'Biome', 'Mean fish/cast: rod → with Spinner (clamped)', 'Spinner adds', 'With Spinner: P(3+) / P(5)', `Above the ceiling (${num(vs.ceiling, 2)})`, `Above the mid band's rod range (${num(vs.bandTop, 2)}, informational)`, 'XP/cast: with Spinner here → rod\'s usual biome, no bait', '$/cast after bait → rod\'s usual biome, no bait', 'Alternative: no clamp', 'Alternative: clamp at the mid band\'s range', `Alternative: Spinner only up to ${tierName(vs.topBandTier)}`], vc.rows.filter((r) => r.bait === 'Spinner').map((r) => [
		`${tierName(r.tier)} (Lv ${r.level})`, r.biome, `${num(r.meanWithout, 2)} → ${num(r.meanWith, 3)}${r.clamped ? ' (clamped)' : ''}`, r.noEffect ? '**nothing**' : `+${num(r.addedMean, 3)}`, `${pct(r.p3plusWith)} / ${pct(r.p5With, 2)}`, flag(r.aboveCeiling), r.aboveBand ? 'yes' : 'no',
		`${num(r.xpPerCastWith, 2)} → ${num(r.xpPerCastTopBiome, 2)} (${r.topBiome})`, `${usd(r.netCashPerCastWith)} → ${usd(r.cashPerCastTopBiome)}`,
		num(r.alternatives.noClamp, 3), num(r.alternatives.clampAtBand, 3), num(r.alternatives.upToBandTier, 3),
	])) + `\n\n\`volumeCheck()\`: framework multi-catch chain on the rod's chance + Spinner's ${pct(PARAMS.baits.Spinner.multiChance, 0)}, the combined chance capped at the chance whose mean is the ceiling (\`rods.PARAMS.multi.ceilingMean\`, \`P-RODS-MEAN-FISH\`; \`PARAMS.volume\`, the same clamp in \`system()\`). The mid band's rod range is the highest mean of the rods typical in ${vs.biomes.join(' and ')} (${vs.bandTiers.map(tierName).join(', ')}). "Rod's usual biome" is the highest biome open at the rod's level (at least ${vs.biomes[0]}). The alternative columns are a sensitivity for \`P-BAIT-SPINNER-TIERS\`, not proposals. Spinner's effect at its home stages (and so its price) is ${vs.homeStageEffectKept.clampAtCeiling ? 'unchanged' : '**changed**'} by the ceiling clamp, and would be ${vs.homeStageEffectKept.clampAtBand ? 'unchanged' : '**changed**'} by the mid-band clamp and ${vs.homeStageEffectKept.upToBandTier ? 'unchanged' : '**changed**'} by the tier limit.`;

	// ----- Bait held below its shop level -----
	T['bait-legacy-level'] = mdTable(['Bait', 'Shop level', 'Works in (biome level)', 'Usable below the shop level in', 'The wait is enforced by'], R.legacyLevel.rows.map((r) => [
		r.bait, `Lv ${r.shopLevel}`, r.biomes.map((b) => `${b} (${F.BIOME_LEVEL[b]})`).join(', '), r.usableBelowShopLevelIn.join(', ') || '—', r.enforcedByBiomeAccess ? 'biome access' : '**a use-time level check** (cast.js `baitApplies`); nothing today',
	])) + '\n\n`legacyLevelCheck()`. A player below a biome\'s level cannot fish there (level-gated biome access), and bait is used only where it works (`P-BAIT-WHERE-IT-WORKS`).';

	// ----- Magnet, Strong Magnet, Magic Lure -----
	T['bait-chase'] = mdTable(['Bait', 'Stage', 'Price/cast', 'Casts per Legendary+ (no bait → bait)', 'Casts per Lucky fish (no bait → bait)', 'Net $ per extra Legendary+', 'In minutes of income', 'Net $ per extra Lucky fish'], R.chase.rows.map((c) => [
		c.bait, stageName(c.stage), usd(c.price), `${int(c.castsPerLegendaryPlus.without)} → ${int(c.castsPerLegendaryPlus.with)}`, `${int(c.castsPerLuckyFish.without)} → ${int(c.castsPerLuckyFish.with)}`,
		usd(c.netCostPerExtraLegendaryPlus, 0), num(c.netCostPerExtraLegendaryPlusInMinutesOfIncome, 1), usd(c.netCostPerExtraLuckyFish, 0),
	])) + `\n\nLucky-item rule: \`${R.chase.luckyItemRule}\` (the framework's proposed \`P-LUCKY\`). A negative net cost means the bait pays for itself in cash while it raises the odds.`;

	// ----- Starter baits -----
	T['bait-starter'] = mdTable(['Biome', 'Old Rod $/cast', '+ strong access', 'Share', 'Return at the starter price (bait)', 'Starter works here', 'Typical rod here'], R.strongAccess.map((s) => [
		s.biome, usd(s.oldRodValuePerCast), usd(s.strongAccessExtraPerCast), pct(s.strongAccessShare), `${num(s.returnAtStarterPrice, 2)} (${s.starterOfWaterType})`, s.starterWorksHere ? 'yes' : 'no', tierName(s.typicalTierHere),
	]));

	// ----- What a bait player picks -----
	T['bait-options'] = mdTable(['Stage', 'goal: cash', 'Net $/cast', 'goal: xp', '+XP/cast', 'Cost/cast (xp)'], R.stageOptions.map((o) => [
		`${stageName(o.stage)}${o.kind === 'transitional' ? ' (transitional)' : ''}`, o.cash.bait || 'none', o.cash.bait ? usd(o.cash.netValuePerCast) : '—',
		o.xp.bait ? `${o.xp.bait}${PARAMS.baits[o.xp.bait].pricing === 'xp' ? '' : ' (no XP bait here)'}` : 'none', o.xp.bait ? num(o.xp.extraXpPerCast, 2) : '—', o.xp.bait ? usd(o.xp.costPerCast) : '—',
	]));

	// ----- Integrated lifecycle -----
	T['bait-lifecycle'] = mdTable(['Level', 'Approved window (no-bait reference)', 'No bait', 'No bait inside the window', 'Money bait (goal cash)', 'XP bait (goal xp)', 'XP-bait speed-up', `Within the ${pct(G.limit, 0)} guard`], F.LIFECYCLE.milestones.map((lv) => {
		const w = F.TARGET_WINDOWS[lv];
		const h = (p) => reg[p].hoursToLevel[lv];
		const sp = gReg.speedups[lv];
		const inW = w ? (h('none') >= w[0] && h('none') <= w[1] ? 'yes' : '**no**') : '—';
		return [`L${lv}`, w ? `${w[0]}–${w[1]} h` : '—', hrs(h('none')), inW, hrs(h('cash')), hrs(h('xp')), sp === undefined ? '—' : pct(sp), sp === undefined ? '—' : sp > G.limit + 1e-9 ? '**no**' : 'yes'];
	})) + `\n\nRegular player (${F.ARCHETYPES[ref].minutesPerDay} min/day). ${L.model}. The approved windows describe the no-bait reference player; a bait buyer is held to the XP-bait guard instead (\`P-BAIT-XP-SIZING\`).`;
	const xpAt = 50;
	const srcCols = ['fishing', 'bait', 'quests', 'daily', 'buffs'];
	T['bait-lifecycle-income'] = mdTable(['Policy', 'Bait bought (share of income)', 'Extra catch value', 'Net effect on income', `XP at L${xpAt}: ${srcCols.join(' / ')}`, 'Baits used'], POLICIES.map((p) => {
		const x = reg[p];
		const s = x.xpSources[xpAt];
		return [p === 'none' ? 'no bait' : p === 'cash' ? 'money bait' : 'XP bait', pct(x.baitSpendShareOfIncome), pct(x.baitExtraValueShareOfIncome), `**${spct(x.netEffectShareOfIncome)}**`, s ? srcCols.map((k) => pct(s.share[k])).join(' / ') : '—', x.baitsUsed.join(', ') || '—'];
	})) + '\n\nShares of the run\'s income to L60 before the bait\'s effect (every cash source minus the bait\'s extra catch value). XP sources as R2 groups them: quests = story + repeatable, daily = daily + weekly quests, buffs = the Double XP bonus (on the whole catch, bait included); the bait\'s share is carved out of fishing.';
	T['bait-archetypes'] = mdTable(['Archetype', 'L50 no bait', 'L50 money bait', 'L50 XP bait', 'Largest money-bait speed-up', 'Largest XP-bait speed-up', `Over the ${pct(G.limit, 0)} guard`], Object.entries(L.byArchetype).map(([a, x]) => [
		`${a} (${F.ARCHETYPES[a].minutesPerDay} min/day)`, hrs(x.hours.none[50]), hrs(x.hours.cash[50]), hrs(x.hours.xp[50]), `${pct(x.cash.speedup)} (L${x.cash.level})`, `${pct(x.xp.speedup)} (L${x.xp.level})`, x.xpOverCap ? '**yes**' : 'no',
	])) + '\n\nSpeed-ups are measured from L20 (no XP bait exists before Lake), each archetype against its own no-bait run.';
	const guardLevels = [...new Set(G.rows.flatMap((r) => Object.keys(r.speedups).map(Number)))].sort((x, y) => x - y);
	T['bait-xp-guard'] = mdTable(['Archetype', ...guardLevels.map((lv) => `L${lv} sooner`), 'Largest', `Within ${pct(G.limit, 0)}`, 'Bait bought → extra catch value (whole policy)', 'Net effect on income', 'Net sink (policy / XP-class baits)', 'Guard'], G.rows.map((r) => [
		`${r.archetype} (${r.minutesPerDay} min/day)`, ...guardLevels.map((lv) => (r.speedups[lv] === undefined ? '—' : r.speedups[lv] > G.limit + 1e-9 ? `**${pct(r.speedups[lv])}**` : pct(r.speedups[lv]))),
		`${pct(r.maxSpeedup)} (L${r.maxSpeedupAt})`, r.overLimit.length ? `**no** (${r.overLimit.map((lv) => `L${lv}`).join(', ')})` : 'yes',
		`${usd(r.baitSpend, 0)} → ${usd(r.baitExtraValue, 0)}`, spct(r.netEffectShareOfIncome), `${yes(r.netSink)} / ${yes(r.xpClassNetSink)}`, r.pass ? 'pass' : '**flag**',
	])) + `\n\n\`xpBaitGuard()\`: every archetype's always-on XP-bait run (\`variant.bait: 'xp'\`) against its own no-bait run, integrated. "Sooner" = 1 − hours with XP bait ÷ hours without, in active play hours, at every milestone from L20 both runs reach. The policy also buys the starter money baits where no XP bait exists; the XP-class column counts ${xpNames.join(', ')} alone. The hard guard is ${pct(G.limit, 0)} (user decision D3): a milestone over it fails the check; nothing is tuned away.`;
	T['bait-by-bait'] = mdTable(['Policy', 'Bait', 'Casts with it', 'Spent', 'Extra catch value', 'Realised cash return', 'Extra XP', 'Net $ per extra XP'], ['cash', 'xp'].flatMap((p) => Object.entries(reg[p].byBait).map(([name, t]) => [
		p === 'cash' ? 'money bait' : 'XP bait', name, int(t.units), usd(t.spend, 0), usd(t.extraValue, 0), num(t.extraValue / t.spend, 2), int(t.extraXp), t.extraXp > 1 ? usd((t.spend - t.extraValue) / t.extraXp) : '—',
	]))) + '\n\nRegular player to L60, integrated: what each bait actually did on the core\'s own casts (gear, buffs and stage mix included).';
	const SZ = L.xpSizing;
	const effect = (row, n) => {
		const e = row.effects[n];
		return e.xpBonus ? `+${num(e.xpBonus * 100, 1)}% XP` : `+${num(e.multiChance * 100, 1)}% extra-fish`;
	};
	const archNames = Object.keys(F.ARCHETYPES);
	T['bait-xp-sizing'] = mdTable(['XP-bait sizing', ...xpNames.map((n) => `${n}`), 'Price/cast (' + xpNames.join(' / ') + ')', ...archNames.map((a) => `Largest speed-up: ${a}`), 'Every archetype a net sink', `Every archetype within ${pct(G.limit, 0)}`, 'Net effect on income (regular)'], SZ.rows.map((row) => [
		row.label, ...xpNames.map((n) => effect(row, n)), xpNames.map((n) => usd(row.effects[n].pricePerCast)).join(' / '),
		...archNames.map((a) => {
			const x = row.byArchetype[a];
			const t = `${pct(x.maxSpeedup)} (L${x.at})`;
			return x.maxSpeedup > G.limit + 1e-9 ? `**${t}**` : t;
		}),
		yes(!row.notNetSink.length), row.overLimit.length ? `**no** (${row.overLimit.join(', ')})` : 'yes', spct(row.netEffectShareOfIncome),
	])) + `\n\nAlways-on XP bait, every archetype, integrated, each against its own no-bait run (the XP-bait guard). Prices follow each sizing through the same rule (K × extra XP × stage $/XP). ${SZ.scaleBound < 1 ? `The guard bound is found by bisection (${SZ.bisectSteps} steps) on a uniform scale of the XP-class baits' XP effects; it is a bound for the decision, not a proposal.` : 'The proposed sizing passes the guard for every archetype, so no bound row is shown.'}`;

	// ----- Booster Packs, crates -----
	const B = R.boosterPack;
	T['bait-booster'] = mdTable(['Setup', 'Casts per Booster Pack (today\'s engine rule)', 'Regular play-hours', 'Bait spend per Booster Pack', 'Casts per Booster Pack (pinned rule, `P-LUCKY`)'], [
		...B.normal.map((x) => [`${x.bait || 'no bait'}, ${stageName(x.stage)}`, int(x.castsPerBoosterPack), int(x.hoursPerBoosterPackRegular), x.bait ? usd(x.baitSpendPerBoosterPack, 0) : '—', int(x.castsPerBoosterPackIfPinned)]),
		['Founder rarity table, Swamp · T4, no bait (per draw)', int(B.founderPerDraw.withoutBait), '—', '—', int(B.founderPerDraw.withoutBaitIfPinned)],
		['Founder rarity table, Swamp · T4, Strong Magnet (per draw)', int(B.founderPerDraw.withStrongMagnet), '—', '—', int(B.founderPerDraw.withStrongMagnetIfPinned)],
	]);
	T['bait-gacha'] = mdTable(['Box', 'Bait units per open', 'Bait value today', 'Proposed, 1 unit per slot', 'Proposed, 1 pack per slot'], Object.entries(R.gacha).filter(([, g]) => g.baitUnitsPerOpen > 0).map(([box, g]) => [box, num(g.baitUnitsPerOpen, 2), usd(g.currentBaitValuePerOpen), usd(g.proposedBaitValuePerOpen), usd(g.proposedIfSlotGrantsAPack)]));

	// ----- Retired loop parity -----
	T['bait-parity'] = mdTable(['Record', 'Value'], [
		['Source', `${PR.source}, commit \`${PR.commit}\``],
		['Method', PR.method],
		['Runs', `${PR.archetypes.length} archetypes × ${PR.policies.length} policies (${PR.policies.join(', ')})`],
		['Milestones step-exact', `${PR.exactMilestones} of ${PR.milestonesCompared}`],
		['Largest relative difference', `${PR.maxRelativeDifference} (tolerance ${PR.tolerance})`],
		['Largest float gap (share of the compared total)', PR.maxFloatGap.toExponential(1)],
		['Baits used', PR.baitsUsedMatch ? 'identical in every run' : '**differ**'],
		['Gear-rule sensitivity (regular: largest relative change in milestone hours)', Object.entries(PR.gearRuleSensitivity).filter(([k]) => k !== 'archetype').map(([k, v]) => `${k} ${pct(v, 2)}`).join(', ')],
	]);
	return T;
}

module.exports = {
	PARAMS, DECISIONS, STAGES, SHARED, XP_SIZING,
	withGear: createBaitModel,
	currentBaits,
	...Object.fromEntries(Object.entries(DEFAULT).filter(([k]) => k !== 'report')),
	SYSTEM_NAME, SPEND_ITEM, POLICIES, system, RETIRED_LOOP_PARITY,
	lifecycle, lifecycleSensitivity, xpBaitGuard, xpSizing, legacyLevelCheck, volumeCap,
	report, markdownTables,
};

if (require.main === module) process.stdout.write(`${JSON.stringify(module.exports.report(), null, 1)}\n`);
