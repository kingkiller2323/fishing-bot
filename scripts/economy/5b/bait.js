// Phase 5B · Bait redesign and reprice. ANALYSIS ONLY: nothing here touches the live game.
//
// Every number this module reports is computed at runtime from the shared framework
// (./framework.js, FRAMEWORK_VERSION reported by report()). Only design parameters are hard-coded
// (PARAMS: roles, stats, biomes, pricing classes, the return/XP-price targets). If a shared value
// changes (curve, value model, multi-catch), re-run report() and every price and return regenerates.
//
//   node -e "require('./scripts/economy/5b/bait.js').report()"      (returns the report object)
//   node scripts/economy/5b/bait.js                                 (prints it as JSON)
//
// Exports
//   PARAMS                       frozen design parameters (consumption rule, targets, the 10 baits)
//   STAGES                       frozen stage ids: typical 'ocean-old' .. 'swamp-t4' and transitional
//                                'lake-old' .. 'swamp-t3' (biome × provisional rod tier)
//   stageGear(stage)             normalises a stage (id string, or { biome, tier | gear | qualities/stats/
//                                mean|multiChance, table, sellMult, xpMult, overheadS }) to castOutcome input
//   baitEffect(name, stage)      { applies, extraValuePerCast, extraXpPerCast, cashPerXp, base, with }
//   prices()                     { [bait]: { price (per cast), packPrice, packSize, rawPrice, pricing,
//                                homeStages, levelRequirement } } (memoised; from castOutcome at the
//                                bait's home stages; sold in packs of packSize casts)
//   priceOf(name)                cost per cast (= packPrice / packSize; one unit = one cast)
//   evaluate(name, stage)        effect + price at a stage: cashReturn, utilityReturn, netCostPerXp,
//                                xpPriceRatio, netValuePerCast, netShareOfCast
//   baitOption(stage, opts)      what the integrated simulator calls for a player who uses bait:
//                                { bait, costPerCast, extraValuePerCast, extraXpPerCast, ... }
//                                opts.goal: 'cash' (default: best positive net cash) | 'xp' (best
//                                XP-class bait, else 'cash') | a bait name. bait = null when none fits.
//   baitMatrix()                 every bait × every typical stage (and Old Rod rows for starter baits)
//   bandCheck()                  acceptance test of the pricing targets over the matrix
//   strongAccessByBiome()        value of strong access to an Old Rod per biome (why starters are 1-biome)
//   consumptionModel()           per-cast vs per-fish consumption numbers by rod tier and for Founder
//   chaseMetrics()               Legendary+/Lucky catch rates and $ per extra catch for luck baits
//   boosterPackOdds()            Lucky-item (Booster Pack) odds with luck baits (disclosed, never valued)
//   gachaBaitValue()             bait liquid value per box open: current, proposed (1 unit/slot) and
//                                proposed if a bait slot grants one pack
//   currentBaits()               today's catalog + measured Old Rod economics (measurements.json)
//   lifecycle(policy, archetype, { detail })
//                                curve.js-style lifecycle with bait bought every cast ('none'|'cash'|'xp')
//                                incl. the XP-source split (fishing / bait / daily) for requirement R2;
//                                detail adds the unrounded figures validateSystem() compares
//   lifecycleSensitivity()       regular/grinder/casual lifecycles, approved windows, speed-up check
//   system(opts)                 framework 5b.3: a FRESH lifecycle.js system (per-run state in
//                                state.sys.bait only). opts.policy 'cash' | 'xp' | a bait name | 'none'.
//                                modifyCast applies baitOption() at the equipped stage and pushes the
//                                per-cast cost (spend item optional.bait); the core's 'fishing' ledger
//                                carries the bait effect, the bait's marginal value/XP is in state.sys.bait
//   validateSystem()             system() on the shared core (LC.simulate) vs lifecycle() for every
//                                archetype x 'none'/'cash'/'xp' (memoised)
//   SYSTEM_NAME, SPEND_ITEM      'bait' and its one ledger item { category: 'optional', item: 'bait' }
//   report(opts)                 all of the above, plus frameworkVersion and system (contract +
//                                validateSystem()); opts.gearPath = withGear input
//   withGear(gearPath)           the same API rebuilt on another rod path (e.g. rods.gearPath(): an
//                                array old..t4 or { old, t1..t4 } of { level, qualities, stats,
//                                multiChance | meanFish | mean }). Every price and check regenerates;
//                                the functions above are withGear(PROVISIONAL.tiers).
const F = require('./framework');
const LC = require('./lifecycle');
const { drawDistribution } = require('../lib/catalog-model');
const { PROFILES, BAIT_STATS } = require('../../../src/engine/balance');
const CURRENT_CATALOG = require('../../../src/bootstrap/data/bait');
const MEASURED = require('../../../docs/economy/measurements.json');
const GACHA_EV = require('../../../docs/economy/gacha-ev.json');
const CURVE_JSON = require('../../../docs/economy/5b/curve.json');

const deepFreeze = (o) => {
	for (const v of Object.values(o)) if (v && typeof v === 'object' && !Object.isFrozen(v)) deepFreeze(v);
	return Object.freeze(o);
};

// ---------------------------------------------------------------------------------------------
// Shared inputs: a view of the framework's shared assumptions (gear path, archetypes, lifecycle), in the
// shape this module uses. Nothing here is a bait design choice and nothing is copied: change them in
// assumptions.js (with a FRAMEWORK_VERSION bump) and this view follows.
const SHARED_PATH = F.gearPath();
const PROVISIONAL = deepFreeze({
	tiers: Object.fromEntries(SHARED_PATH.map((t) => [t.key, { level: t.level, mean: t.meanFish, qualities: [...t.qualities], stats: { ...t.stats } }])),
	tierOrder: SHARED_PATH.map((t) => t.key),
	// The tier a player typically holds while fishing each biome (the tier unlocked at the biome's level).
	typicalTier: Object.fromEntries(F.LIVE_BIOMES.map((b) => [b, F.typicalTier(b, SHARED_PATH).key])),
	archetypes: JSON.parse(JSON.stringify(F.ARCHETYPES)),
	lifecycle: { dailyXpPerLevel: F.DAILY.xpPerLevel, purchaseHours: F.PURCHASE.saveHours, stepH: F.LIFECYCLE.stepH, maxLevel: F.LIFECYCLE.maxLevel },
});

// ---------------------------------------------------------------------------------------------
// Design parameters (the only hard-coded bait numbers).
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
		// 6%: strong access is the largest lever (it opens half the catalog to an Old Rod), and at the
		// target return its net gain in Ocean lands just under this; every other bait stays below ~3.5%.
		netShareMax: 0.06,
		// XP baits are an optional money-to-progress converter, not a second curve: a regular player
		// who runs the XP bait at every stage where one exists may reach any milestone at most this
		// much sooner than the same player without bait (checked by lifecycleSensitivity()).
		maxXpBaitSpeedup: 0.10,
		// Sold in packs of `packSize` casts so small per-cast prices keep their precision (money is an
		// integer). Pack prices round to $1 below $100 and to $5 above.
		packSize: 10,
		packRoundTo: [{ below: 100, step: 1 }, { below: Infinity, step: 5 }],
	},
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
		// waters: across a whole water type an Old Rod + Worm would return up to ~10x in Swamp.
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
		// No strong access (legacy had it): an Old Rod + Strong Magnet in Swamp would return ~2.6x.
		'Strong Magnet': {
			role: 'luck / collection completion, any biome', band: 'universal', biomes: ALL, levelFromBiome: 'Coast',
			grantsStrong: false, stats: { luck: 4.0 }, multiChance: 0, pricing: 'money', homeStages: ['swamp-t4'],
			description: 'Luck +400% (Legendary and Lucky 5x) in every biome. Priced for Swamp.',
		},
	},
});
const BAIT_NAMES = Object.keys(PARAMS.baits);

// Stage ids: typical (biome × the tier normally held there) and transitional (arrived, not upgraded).
const STAGES = deepFreeze(Object.fromEntries([
	...ALL.map((b) => [`${b.toLowerCase()}-${PROVISIONAL.typicalTier[b]}`, { biome: b, tier: PROVISIONAL.typicalTier[b], kind: 'typical' }]),
	...ALL.filter((b) => PROVISIONAL.typicalTier[b] !== 'old').map((b) => {
		const prev = PROVISIONAL.tierOrder[PROVISIONAL.tierOrder.indexOf(PROVISIONAL.typicalTier[b]) - 1];
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
const addStats = (a = {}, b = {}) => {
	const o = { ...a };
	for (const [k, v] of Object.entries(b)) o[k] = (o[k] || 0) + v;
	return o;
};

/** Normalises a gear path (array old..t4 or keyed object) to { old, t1..t4 }. */
function normaliseGear(path) {
	if (!path) return PROVISIONAL.tiers;
	const entries = Array.isArray(path) ? path.map((t, i) => [PROVISIONAL.tierOrder[i], t]) : Object.entries(path);
	const out = {};
	for (const [name, t] of entries) {
		if (!PROVISIONAL.tierOrder.includes(name)) continue;
		out[name] = {
			level: t.level ?? PROVISIONAL.tiers[name].level,
			qualities: t.qualities || ['weak'],
			stats: { ...(t.stats || {}) },
			...(t.multiChance !== undefined ? { multiChance: t.multiChance } : { mean: t.meanFish ?? t.mean ?? 1 }),
		};
	}
	for (const n of PROVISIONAL.tierOrder) if (!out[n]) throw new Error(`gear path is missing tier ${n}`);
	return out;
}
const chanceOf = (gear) => (gear.multiChance !== undefined ? gear.multiChance : F.chanceForMean(gear.mean ?? gear.meanFish ?? 1));

const stageLabel = (s) => (typeof s === 'string' ? s : `${cap(s.biome).toLowerCase()}-${s.tier || 'custom'}`);

const outcomeCache = new Map();
function outcome(g, bait) {
	const qualities = bait && bait.grantsStrong ? [...new Set([...g.qualities, 'strong'])] : g.qualities;
	const input = {
		biome: g.biome,
		qualities,
		stats: addStats(g.stats, bait ? bait.stats : {}),
		multiChance: Math.min(1, g.multiChance + (bait ? bait.multiChance || 0 : 0)),
		table: g.table,
		sellMult: g.sellMult,
		xpMult: g.xpMult,
	};
	const key = JSON.stringify(input);
	if (!outcomeCache.has(key)) outcomeCache.set(key, F.castOutcome(input));
	return outcomeCache.get(key);
}

/** Lucky-fish / Lucky-item split of one draw (drawDistribution over the cast's final table). */
function drawSplit(g, bait, table) {
	const qualities = bait && bait.grantsStrong ? [...new Set([...g.qualities, 'strong'])] : g.qualities;
	const dist = drawDistribution(g.biome, qualities, table);
	let legendaryPlusFish = 0;
	let luckyFish = 0;
	let booster = 0;
	let luckyItems = 0;
	for (const d of dist) {
		if (d.kind === 'fish' && (d.rarity === 'legendary' || d.rarity === 'lucky')) legendaryPlusFish += d.p;
		if (d.kind === 'fish' && d.rarity === 'lucky') luckyFish += d.p;
		if (d.kind === 'item') {
			luckyItems += d.p;
			if (d.template.name === 'Booster Pack') booster += d.p;
		}
	}
	return { legendaryPlusFish, luckyFish, booster, luckyItems };
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

const biomeAt = (L) => [...ALL].reverse().find((b) => L >= F.BIOME_LEVEL[b]);

/**
 * The whole bait model on one rod path. Everything that depends on gear lives in here, so a new
 * gear path (the rods design, or a later framework version) regenerates every number.
 */
function createBaitModel(gearPath = null) {
	const TIERS = normaliseGear(gearPath);
	// The default path is the shared one (F.gearPath(): the rods design since the 5b.3 R3 cutover).
	const gearSource = gearPath ? 'custom' : F.GEAR_PATH_SOURCE;

	/** Normalises a stage to castOutcome input. */
	function stageGear(stage) {
		const s = typeof stage === 'string' ? STAGES[stage] : stage;
		if (!s) throw new Error(`Unknown stage ${stage}`);
		const biome = cap(s.biome);
		const tierName = s.tier || PROVISIONAL.typicalTier[biome] || 'old';
		const gear = s.gear || (s.qualities || s.stats || s.mean || s.meanFish || s.multiChance !== undefined ? s : TIERS[tierName]);
		if (!gear) throw new Error(`Unknown tier ${tierName}`);
		const multiChance = chanceOf(gear);
		return {
			biome,
			tier: s.gear || s.qualities ? (s.tier || 'custom') : tierName,
			qualities: gear.qualities || ['weak'],
			stats: { ...(gear.stats || {}) },
			multiChance,
			table: s.table,
			sellMult: s.sellMult,
			xpMult: s.xpMult,
			overheadS: s.overheadS ?? 4,
		};
	}

	/** Expected effect of one bait at a stage (per cast, versus the same stage without bait). */
	function baitEffect(name, stage) {
		const b = PARAMS.baits[name];
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
		const b = PARAMS.baits[name];
		if (b.pricing === 'money') return e.extraValuePerCast / PARAMS.pricing.returnTarget;
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
			const b = PARAMS.baits[name];
			const utilities = b.homeStages.map((s) => pricingUtility(name, s));
			const rawPrice = geomean(utilities);
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
	 * @param opts { goal: 'cash' | 'xp' | <bait name> }
	 */
	function baitOption(stage, { goal = 'cash' } = {}) {
		const none = { bait: null, costPerCast: 0, extraValuePerCast: 0, extraXpPerCast: 0, netValuePerCast: 0, goal };
		const g = stageGear(stage);
		const usable = BAIT_NAMES.filter((n) => PARAMS.baits[n].biomes.includes(g.biome));
		const pick = (rows) => (rows.length ? rows[0] : null);
		let chosen = null;
		if (PARAMS.baits[goal]) {
			chosen = usable.includes(goal) ? evaluate(goal, stage) : null;
		}
		else if (goal === 'xp') {
			const rows = usable.filter((n) => PARAMS.baits[n].pricing === 'xp').map((n) => evaluate(n, stage)).filter((r) => r.extraXpPerCast > 0)
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
			role: PARAMS.baits[chosen.bait].role,
			goal,
		};
	}

	/** Every bait at every typical stage it works in; starter baits also with an Old Rod elsewhere. */
	function baitMatrix() {
		const out = {};
		for (const name of BAIT_NAMES) {
			const b = PARAMS.baits[name];
			const home = b.homeStages.map((s) => ({ stage: s, ...rowOut(evaluate(name, s)) }));
			const elsewhere = TYPICAL_STAGE_IDS.filter((s) => !b.homeStages.includes(s) && b.biomes.includes(STAGES[s].biome))
				.map((s) => ({ stage: s, ...rowOut(evaluate(name, s)) }));
			const transitional = Object.keys(STAGES).filter((s) => STAGES[s].kind === 'transitional' && b.biomes.includes(STAGES[s].biome))
				.map((s) => ({ stage: s, ...rowOut(evaluate(name, s)) }));
			const oldRodElsewhere = b.grantsStrong
				? b.biomes.filter((bi) => !b.homeStages.includes(`${bi.toLowerCase()}-old`)).map((bi) => ({ stage: `${bi.toLowerCase()}-old`, atypical: PROVISIONAL.typicalTier[bi] !== 'old', ...rowOut(evaluate(name, { biome: bi, tier: 'old' })) }))
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
			const b = PARAMS.baits[name];
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
		return { pass: issues.length === 0, issues, summary, bands: { moneyReturn: P.moneyReturnBand, xpUtility: P.xpUtilityBand, netShareMax: P.netShareMax } };
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
				starterWorksHere: PARAMS.baits[starter].biomes.includes(biome), typicalTierHere: PROVISIONAL.typicalTier[biome],
			};
		});
	}

	// ---------------------------------------------------------------------------------------------
	/** Per-cast vs per-fish consumption by rod tier (framework multi-catch) and for today's Founder. */
	function consumptionModel() {
		const tiers = PROVISIONAL.tierOrder.map((t) => {
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

	/** Collection-chase metrics for the luck baits (and Magic Lure) at their home stages and in Ocean. */
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
			const b = PARAMS.baits[name];
			const o0 = outcome(g, null);
			const o1 = outcome(g, b);
			const s0 = drawSplit(g, null, o0.table);
			const s1 = drawSplit(g, b, o1.table);
			const lp0 = s0.legendaryPlusFish * o0.fishPerCast;
			const lp1 = s1.legendaryPlusFish * o1.fishPerCast;
			const lu0 = s0.luckyFish * o0.fishPerCast;
			const lu1 = s1.luckyFish * o1.fishPerCast;
			const price = priceOf(name);
			const net = price - (o1.valuePerCast - o0.valuePerCast);
			rows.push({
				bait: name, stage: stageLabel(s), price,
				castsPerLegendaryPlus: { without: Math.round(1 / lp0), with: Math.round(1 / lp1) },
				castsPerLuckyFish: { without: Math.round(1 / lu0), with: Math.round(1 / lu1) },
				// Negative = the bait pays for itself in cash while tripling-to-quintupling the chase odds.
				netCostPerExtraLegendaryPlus: Math.round(net / (lp1 - lp0)),
				netCostPerExtraLegendaryPlusInMinutesOfIncome: r2((60 * net) / (lp1 - lp0) / F.hourly(o0).cash),
				netCostPerExtraLuckyFish: Math.round(net / (lu1 - lu0)),
			});
		}
		return rows;
	}

	/** Booster Pack (Lucky item) odds with luck baits. Disclosed only: never valued in any model. */
	function boosterPackOdds() {
		const rows = [];
		for (const [name, s] of [[null, 'ocean-old'], [null, 'swamp-t4'], ['Magnet', 'pond-t2'], ['Strong Magnet', 'swamp-t4'], ['Strong Magnet', { biome: 'Ocean', tier: 't4' }], ['Magic Lure', 'swamp-t4']]) {
			const g = stageGear(s);
			const b = name ? PARAMS.baits[name] : null;
			const o = outcome(g, b);
			const sp = drawSplit(g, b, o.table);
			const perCast = sp.booster * o.fishPerCast;
			// Pinned rule (proposed engine change): the Lucky-item branch keeps the rate of the profile's
			// unmodified table, so luck from rods/bait raises Lucky FISH only.
			const baseTable = F.castOutcome({ biome: g.biome, qualities: g.qualities }).table;
			const pinned = drawSplit({ ...g, qualities: b && b.grantsStrong ? [...new Set([...g.qualities, 'strong'])] : g.qualities }, null, baseTable).booster * o.fishPerCast;
			rows.push({
				bait: name, stage: stageLabel(s),
				castsPerBoosterPack: Math.round(1 / perCast),
				hoursPerBoosterPackRegular: Math.round(1 / perCast / F.hourly(o, F.ARCHETYPES[F.REFERENCE_ARCHETYPE].overheadS).casts),
				baitSpendPerBoosterPack: name ? Math.round(priceOf(name) / perCast) : 0,
				castsPerBoosterPackIfPinned: Math.round(1 / pinned),
			});
		}
		// Founder today (per draw; Founder draw counts belong to the Founder design).
		const fg = { ...stageGear('swamp-t4'), table: F.FOUNDER_RARITY_TABLE };
		const f0 = drawSplit(fg, null, outcome(fg, null).table);
		const fsm = drawSplit(fg, PARAMS.baits['Strong Magnet'], outcome(fg, PARAMS.baits['Strong Magnet']).table);
		return {
			note: 'Lucky items are excluded from castOutcome value; Booster Packs stay an Easter egg and are counted in no income or progression model. "IfPinned" = proposed rule: luck stats raise Lucky fish, never the Lucky-item rate.',
			normal: rows,
			founderPerDraw: { withoutBait: Math.round(1 / f0.booster), withStrongMagnet: Math.round(1 / fsm.booster) },
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
				prop += u * (PARAMS.baits[name] ? priceOf(name) : 0);
			}
			out[box] = { baitUnitsPerOpen: r3(units), currentBaitValuePerOpen: r2(cur), proposedBaitValuePerOpen: r2(prop), proposedIfSlotGrantsAPack: r2(prop * PARAMS.pricing.packSize) };
		}
		return out;
	}

	// ---------------------------------------------------------------------------------------------
	// Provisional lifecycle, mirroring scripts/economy/5b/curve.js step for step (1-minute steps,
	// highest unlocked biome, 60 XP × level daily, a tier bought after saving purchaseHours of the
	// no-bait stage income), with bait bought every cast from baitOption(). With policy 'none' it must
	// reproduce curve.json; bandCheck-independent cross-check reported as baselineMatchesCurveJson.
	const lcCache = new Map();
	function lcRates(biome, tier, overheadS, policy) {
		const key = `${biome}|${tier}|${overheadS}|${policy}`;
		if (!lcCache.has(key)) {
			const stage = { biome, tier, overheadS };
			const g = stageGear(stage);
			const o = outcome(g, null);
			const h = F.hourly(o, overheadS);
			const opt = policy === 'none' ? { bait: null, costPerCast: 0, extraValuePerCast: 0, extraXpPerCast: 0 } : baitOption(stage, { goal: policy });
			lcCache.set(key, {
				grossNoBait: h.cash,
				cash: h.cash + h.casts * (opt.extraValuePerCast - opt.costPerCast),
				xp: h.xp + h.casts * opt.extraXpPerCast,
				xpNoBait: h.xp,
				xpBait: h.casts * opt.extraXpPerCast,
				spend: h.casts * opt.costPerCast,
				extra: h.casts * opt.extraValuePerCast,
				bait: opt.bait,
			});
		}
		return lcCache.get(key);
	}

	/**
	 * @param policy 'none' | 'cash' | 'xp' (baitOption goal, bait bought every cast)
	 * @param archName an F.ARCHETYPES name
	 * @param opts { detail: also return the unrounded figures (step index and XP by source at each
	 *   milestone, run totals) that validateSystem() compares with the shared core; off by default }
	 */
	function lifecycle(policy = 'none', archName = 'regular', { detail = false } = {}) {
		const arch = PROVISIONAL.archetypes[archName];
		const { dailyXpPerLevel, purchaseHours, stepH, maxLevel } = PROVISIONAL.lifecycle;
		const order = PROVISIONAL.tierOrder;
		let xp = 0;
		let h = 0;
		let steps = 0;
		let tierIdx = 0;
		let saving = 0;
		let spend = 0;
		let extra = 0;
		let gross = 0;
		const xpBy = { fishing: 0, bait: 0, daily: 0 };
		const xpAt = {};
		const rawAt = {};
		const dayH = arch.minutesPerDay / 60;
		const reached = {};
		const baitsUsed = new Set();
		while (h < 2000) {
			const L = F.levelForXp(xp);
			const cur = order[tierIdx];
			const next = order[tierIdx + 1];
			const r = lcRates(biomeAt(L), cur, arch.overheadS, policy);
			if (r.bait) baitsUsed.add(r.bait);
			if (next && L >= TIERS[next].level) {
				saving += r.cash * stepH;
				if (saving >= r.grossNoBait * purchaseHours) {
					tierIdx++;
					saving = 0;
				}
			}
			xp += r.xp * stepH;
			xpBy.fishing += r.xpNoBait * stepH;
			xpBy.bait += r.xpBait * stepH;
			spend += r.spend * stepH;
			extra += r.extra * stepH;
			gross += r.grossNoBait * stepH;
			const before = h;
			h += stepH;
			steps++;
			if (Math.floor(h / dayH) !== Math.floor(before / dayH)) {
				xp += dailyXpPerLevel * L;
				xpBy.daily += dailyXpPerLevel * L;
			}
			const L2 = F.levelForXp(xp);
			for (const T of F.LIFECYCLE.milestones) {
				if (!reached[T] && L2 >= T) {
					reached[T] = r2(h);
					const tot = xpBy.fishing + xpBy.bait + xpBy.daily;
					xpAt[T] = { day: Math.ceil(h / dayH), fishingShare: r4(xpBy.fishing / tot), baitShare: r4(xpBy.bait / tot), dailyShare: r4(xpBy.daily / tot) };
					rawAt[T] = { step: steps, day: xpAt[T].day, xpBy: { ...xpBy } };
				}
			}
			if (L2 >= maxLevel) break;
		}
		const out = {
			policy, archetype: archName, gear: gearSource, hoursToLevel: reached, xpSources: xpAt,
			baitSpendShareOfIncome: r4(spend / gross), baitExtraValueShareOfIncome: r4(extra / gross), netEffectShareOfIncome: r4((extra - spend) / gross),
			baitsUsed: [...baitsUsed],
		};
		if (detail) out.detail = { milestones: rawAt, totals: { steps, spend, extra, gross, xpBy: { ...xpBy } } };
		return out;
	}

	function lifecycleSensitivity() {
		const regular = Object.fromEntries(['none', 'cash', 'xp'].map((p) => [p, lifecycle(p, 'regular')]));
		const grinder = Object.fromEntries(['none', 'xp'].map((p) => [p, lifecycle(p, 'grinder')]));
		const casual = Object.fromEntries(['none', 'cash'].map((p) => [p, lifecycle(p, 'casual')]));
		const ref = CURVE_JSON.archetypes?.regular || {};
		const matches = Object.entries(regular.none.hoursToLevel).every(([L, hrs]) => ref[L] === undefined || Math.abs(ref[L].hours - hrs) < 0.02);
		const curveMatches = CURVE_JSON.chosen === F.CURVE.quartic;
		// Approved windows (curve.json targets) for the regular player, with and without bait.
		const windows = Object.entries(CURVE_JSON.targets || {}).map(([L, [lo, hi]]) => {
			const row = { level: Number(L), window: [lo, hi] };
			for (const p of ['none', 'cash', 'xp']) {
				const hrs = regular[p].hoursToLevel[L];
				row[p] = { hours: hrs, inWindow: hrs >= lo && hrs <= hi, speedupVsNoBait: r4(1 - hrs / regular.none.hoursToLevel[L]) };
			}
			return row;
		});
		const maxSpeedup = Math.max(...Object.keys(regular.none.hoursToLevel).filter((L) => Number(L) >= 20).map((L) => 1 - regular.xp.hoursToLevel[L] / regular.none.hoursToLevel[L]));
		return {
			regular, grinder, casual, windows,
			xpBaitSpeedupCheck: { maxSpeedup: r4(maxSpeedup), limit: PARAMS.pricing.maxXpBaitSpeedup, pass: maxSpeedup <= PARAMS.pricing.maxXpBaitSpeedup + 1e-9 },
			baselineMatchesCurveJson: matches && curveMatches, curveJsonQuartic: CURVE_JSON.chosen, frameworkQuartic: F.CURVE.quartic,
		};
	}

	// ---------------------------------------------------------------------------------------------
	/** Current -> proposed rows for all 10 baits (proposed metrics at each home stage). */
	function currentVsProposed() {
		const cur = Object.fromEntries(currentBaits().map((c) => [c.name, c]));
		const p = prices();
		return BAIT_NAMES.map((name) => {
			const b = PARAMS.baits[name];
			const c = cur[name];
			return {
				bait: name,
				current: {
					price: c.price, consumption: c.consumption, biomes: c.biomes, capabilities: c.capabilities, engineStats: c.engineStats, xpMultiplier: c.xpMultiplier,
					bestReturnPerDollarOldRod: c.bestReturnPerDollar, bestBiome: c.bestBiome, costPerCastRange: c.costPerCastRange, medianExtraXpPerCast: c.medianExtraXpPerCast, medianCostPerExtraXp: c.medianCostPerExtraXp,
				},
				proposed: {
					role: b.role, band: b.band, price: p[name].price, rawPrice: p[name].rawPrice, levelRequirement: p[name].levelRequirement,
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

	function report() {
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
			matrix: baitMatrix(),
			strongAccess: strongAccessByBiome(),
			stageOptions: stageOptions(),
			consumption: consumptionModel(),
			chase: chaseMetrics(),
			boosterPack: boosterPackOdds(),
			gacha: gachaBaitValue(),
			lifecycle: lifecycleSensitivity(),
		};
	}

	return {
		tiers: TIERS, gearSource,
		stageGear, baitEffect, prices, priceOf, evaluate, baitOption,
		baitMatrix, bandCheck, strongAccessByBiome, consumptionModel, chaseMetrics, boosterPackOdds, gachaBaitValue,
		lifecycle, lifecycleSensitivity, currentVsProposed, stageOptions, report,
	};
}

const DEFAULT = createBaitModel();

// ---------------------------------------------------------------------------------------------
// SYSTEM (framework 5b.3): bait on the shared lifecycle core (lifecycle.js). The core steps time and
// accrues every cast into ledger source 'fishing', the bait's effect included. This system only picks
// the bait, applies it to the cast and pays for it. It writes no ledger source and one spend item.
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
 *               (ctx.path[input.tier], F.gearPath() by default) }, { goal: policy }), memoised per stage in
 *               state.sys.bait.stages. When a bait fits, it adds the bait's stats to input.stats (Rare Find,
 *               Trophy Chance, Luck, xpBonus, and Spinner's extra-fish chance as stats.multiChance) and
 *               strong access for the starter baits (input.qualities). It then pushes the per-cast cost
 *               { category: 'optional', item: 'bait', perCast: shop price per cast }: one unit per cast,
 *               only where the bait works (PARAMS.consumption). Nothing happens where no bait fits.
 *   onCasts     the bait's marginal effect this step, measured on the core's own cast: value and XP
 *               (account and public) of the cast minus the same cast without the bait (other systems'
 *               changes kept), from the same outcome function the core used. It is added to the totals,
 *               byBait[name] and stages[biome/tier].
 *   on          'levelUp': snapshots the totals at each recorded milestone (milestones /
 *               publicMilestones), next to the core's ledger snapshots
 * Ledgers: the core's 'fishing' XP and cash already include the bait's effect. The system writes no
 * XP or cash source. Its only ledger item is ledger.spend.optional.bait. A report that splits XP by
 * source takes the bait's share from state.sys.bait (extraXp / extraPublicXp) and never edits 'fishing'.
 * Profile: the choice is baitOption's (normal-profile stage economics, fixed shop prices). A Founder
 * also uses one unit per cast (PARAMS.consumption.profileIndependent). The marginal is measured on the
 * profile's actual cast (the outcome override honours the input), so a Founder's is its own.
 * Box contents: bait units inside boxes are valued by the system that grants the box (counting rule),
 * never here, and they do not offset the bait bought per cast.
 * @param {object} opts { policy: 'cash' (default: best positive net cash) | 'xp' (best XP-class bait, else
 *   'cash') | a bait name (that bait wherever it works) | 'none' (no-op, validation baseline) }
 */
function system(opts = {}) {
	const policy = opts.policy ?? 'cash';
	if (!POLICIES.includes(policy) && !PARAMS.baits[policy]) throw new Error(`Unknown bait policy ${policy} (${POLICIES.join(' | ')} | a bait name)`);
	const own = (state) => state.sys[SYSTEM_NAME];

	/** What the policy equips at a biome with a path tier (memoised per run; shop prices are fixed). */
	function stageChoice(s, biome, tierIdx, ctx) {
		const gear = ctx.path[tierIdx];
		const key = gear.key || F.TIER_KEYS[tierIdx] || `tier${tierIdx}`;
		const id = `${biome}/${key}`;
		if (!s.stages[id]) {
			const opt = policy === 'none' ? NO_BAIT : DEFAULT.baitOption({ biome, tier: key, gear }, { goal: policy });
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
			const b = PARAMS.baits[stage.bait];
			const add = { ...b.stats, ...(b.multiChance ? { multiChance: b.multiChance } : {}) };
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
			const baseCasts = (ctx.stepH * 3600) / (base.cooldownMs / 1000 + ctx.arch.overheadS);
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
// Validation (5b.3): system() on the shared core against lifecycle().
/**
 * lifecycle()'s gear rule as a system (validation only; the assumption lifecycle() made): once the next
 * tier's level is reached, save each step's NET cash (with-bait income minus the bait bought) until it
 * covers F.PURCHASE.saveHours of the stage's NO-BAIT income, then equip the tier. The price of a tier does
 * not depend on bait use; bait spend delays it. The arithmetic is lifecycle()'s, so the replay is step-exact.
 * It reads the bait the system chose at the stage (state.sys.bait.stages).
 */
function lifecycleRods({ saveHours = F.PURCHASE.saveHours } = {}) {
	const name = 'baitLifecycleRods';
	return {
		name,
		init(state) {
			state.sys[name] = { saving: 0 };
		},
		beforeStep(state, ctx, rates) {
			const next = ctx.path[state.equippedTier + 1];
			if (!next || rates.blocked || state.stepStartLevel < next.level) return;
			const s = state.sys[name];
			const key = ctx.path[state.equippedTier].key;
			const h = F.hourly(outcome(DEFAULT.stageGear({ biome: rates.biome, tier: key }), null), ctx.arch.overheadS);
			const stage = state.sys[SYSTEM_NAME]?.stages[`${rates.biome}/${key}`];
			const opt = stage ? { extraValuePerCast: stage.designExtraValuePerCast, costPerCast: stage.costPerCast } : NO_BAIT;
			s.saving += (h.cash + h.casts * (opt.extraValuePerCast - opt.costPerCast)) * ctx.stepH;
			if (s.saving >= h.cash * saveHours) {
				state.equippedTier++;
				s.saving = 0;
			}
		},
	};
}

/**
 * Milestone XP on lifecycle()'s basis (validation only; runs after LC.provisionalDaily). lifecycle() adds
 * the day's daily XP inside the day's final step, before it checks levels. The core records a level
 * reached by that step's fishing before onDayEnd. For such milestones this re-records the XP after the
 * daily. Hours are identical either way.
 */
function validationProbe() {
	const name = 'baitValidationProbe';
	const snap = (state) => ({ xp: { ...state.ledger.xp }, baitXp: state.sys[SYSTEM_NAME]?.extraXp ?? 0 });
	return {
		name,
		init(state) {
			state.sys[name] = {};
		},
		on(event, payload, state) {
			if (event !== 'levelUp' || payload.kind !== 'real') return;
			for (const T of numericKeys(state.milestones)) if (!(T in state.sys[name])) state.sys[name][T] = snap(state);
		},
		onDayEnd(state, ctx) {
			// A session cut short by the stop level has no day end in lifecycle().
			if (Math.floor(state.h / (ctx.arch.minutesPerDay / 60)) === state.playDay) return;
			const h = +state.h.toFixed(4);
			for (const [T, m] of Object.entries(state.milestones)) if (m.hours === h) state.sys[name][T] = snap(state);
		},
	};
}

const VALIDATION_POLICIES = ['none', 'cash', 'xp'];
/**
 * Symmetric relative difference of a part of `scale` (e.g. one XP source of the milestone's total XP).
 * Float noise (a gap under 1e-9 of the scale, from a different summation order) counts as equal. Without
 * that floor the starter baits' XP delta, which is 0 up to rounding (strong access changes species, not
 * rarity), would compare two rounding residues of about 1e-12.
 */
const relDiff = (a, b, scale = Math.max(Math.abs(a), Math.abs(b))) => {
	const gap = Math.abs(a - b);
	return gap <= 1e-9 * scale ? 0 : gap / Math.max(Math.abs(a), Math.abs(b));
};

/**
 * One core run on the shared gear path: system({ policy }), a gear rule ('lifecycle': lifecycle()'s,
 * 'provisional': LC.provisionalRods), LC.provisionalDaily (lifecycle()'s daily XP) and the probe.
 */
function coreRun(archName, policy, rods = 'lifecycle') {
	return LC.simulate({
		archetype: archName,
		systems: [system({ policy }), rods === 'lifecycle' ? lifecycleRods() : LC.provisionalRods(), LC.provisionalDaily(), validationProbe()],
	});
}

/** lifecycle()'s income figures from a core run: bait spend and extra value against no-bait income. */
function coreIncome(core) {
	const b = core.sys[SYSTEM_NAME];
	const spend = core.ledger.spend.optional.bait || 0;
	const gross = (core.ledger.cash.fishing || 0) - b.extraValue;
	return {
		spend, extra: b.extraValue, gross,
		shares: { baitSpendShareOfIncome: r4(spend / gross), baitExtraValueShareOfIncome: r4(b.extraValue / gross), netEffectShareOfIncome: r4((b.extraValue - spend) / gross) },
	};
}

/**
 * system() on the core vs lifecycle(policy, archetype): milestone hours (step-exact: lifecycle() rounds
 * hours to 0.01 h, under one step, so both are compared as step indices), XP by source at each milestone
 * (fishing without bait, bait, daily), and run totals (bait spend, bait extra value, no-bait income, steps).
 */
function compareRun(archName, policy) {
	const stepH = F.LIFECYCLE.stepH;
	const old = DEFAULT.lifecycle(policy, archName, { detail: true });
	const core = coreRun(archName, policy);
	const probe = core.sys.baitValidationProbe;
	const out = { maxRel: 0, worst: null, maxFloatGap: 0, milestonesCompared: 0, exactMilestones: 0, missing: [] };
	const note = (key, d) => {
		if (d > out.maxRel) {
			out.maxRel = d;
			out.worst = key;
		}
	};
	/** Compares a part of `scale`; also tracks the largest gap (relative to its scale) the floor absorbed. */
	const compare = (key, a, b, scale = Math.max(Math.abs(a), Math.abs(b))) => {
		note(key, relDiff(a, b, scale));
		if (scale > 0) out.maxFloatGap = Math.max(out.maxFloatGap, Math.abs(a - b) / scale);
	};
	const milestones = {};
	for (const T of F.LIFECYCLE.milestones) {
		const o = old.detail.milestones[T];
		const c = core.milestones[T];
		if (!o || !c) {
			if (Boolean(o) !== Boolean(c)) out.missing.push(T);
			continue;
		}
		out.milestonesCompared++;
		const steps = Math.round(c.hours / stepH) - o.step;
		if (steps === 0) out.exactMilestones++;
		note(`L${T} hours`, Math.abs(steps) / o.step);
		const p = probe[T];
		const xp = { fishing: (p.xp.fishing || 0) - p.baitXp, bait: p.baitXp, daily: p.xp.daily || 0 };
		const total = o.xpBy.fishing + o.xpBy.bait + o.xpBy.daily;
		for (const k of Object.keys(xp)) compare(`L${T} xp.${k}`, xp[k], o.xpBy[k], total);
		milestones[T] = { hours: { old: old.hoursToLevel[T], core: c.hours }, steps, day: { old: o.day, core: c.day }, baitXp: { old: Math.round(o.xpBy.bait), core: Math.round(xp.bait) } };
	}
	const t = old.detail.totals;
	const inc = coreIncome(core);
	note('run steps', Math.abs(Math.round(core.hours / stepH) - t.steps) / t.steps);
	compare('bait spend', inc.spend, t.spend, t.gross);
	compare('bait extra value', inc.extra, t.extra, t.gross);
	compare('no-bait income', inc.gross, t.gross);
	const baitsUsed = { old: [...old.baitsUsed].sort(), core: Object.keys(core.sys[SYSTEM_NAME].byBait).sort() };
	const oldShares = { baitSpendShareOfIncome: old.baitSpendShareOfIncome, baitExtraValueShareOfIncome: old.baitExtraValueShareOfIncome, netEffectShareOfIncome: old.netEffectShareOfIncome };
	return {
		maxRel: out.maxRel, worst: out.worst, maxFloatGap: out.maxFloatGap, milestonesCompared: out.milestonesCompared, exactMilestones: out.exactMilestones, missing: out.missing,
		baitsMatch: JSON.stringify(baitsUsed.old) === JSON.stringify(baitsUsed.core), baitsUsed,
		incomeShares: { old: oldShares, core: inc.shares },
		milestones,
	};
}

let validation = null;
/**
 * validateSystem(): system() on the shared core (LC.simulate) vs this module's lifecycle(), for every
 * archetype (F.ARCHETYPES) and the policies 'none', 'cash' and 'xp'. The baseline systems are the
 * assumptions lifecycle() made: its gear rule (lifecycleRods) and its daily XP (LC.provisionalDaily).
 * Also reports how much the gear rule matters (LC.provisionalRods instead, regular player).
 */
function validateSystem() {
	if (validation) return validation;
	const archetypes = Object.keys(F.ARCHETYPES);
	const byArchetype = Object.fromEntries(archetypes.map((a) => [a, Object.fromEntries(VALIDATION_POLICIES.map((p) => [p, compareRun(a, p)]))]));
	const runs = archetypes.flatMap((a) => VALIDATION_POLICIES.map((p) => ({ archetype: a, policy: p, r: byArchetype[a][p] })));
	const worst = runs.reduce((w, x) => (x.r.maxRel > w.maxRelativeDifference ? { maxRelativeDifference: x.r.maxRel, archetype: x.archetype, policy: x.policy, at: x.r.worst } : w), { maxRelativeDifference: 0, archetype: null, policy: null, at: null });
	const complete = runs.every((x) => !x.r.missing.length && x.r.baitsMatch);
	const tolerance = 0.005;

	// The gear rule: LC.provisionalRods saves the with-bait gross (bait spend ignored) against saveHours of the
	// with-bait gross, so the price of a tier moves with bait use. lifecycle()'s rule is the one the integrated
	// core follows (the rods system buys at a fixed assembly cost out of money that has already paid for bait).
	const ref = F.REFERENCE_ARCHETYPE;
	const purchaseRule = Object.fromEntries(VALIDATION_POLICIES.map((p) => {
		const a = coreRun(ref, p);
		const b = coreRun(ref, p, 'provisional');
		const rows = Object.fromEntries(F.LIFECYCLE.milestones.filter((T) => a.milestones[T] && b.milestones[T]).map((T) => [T, { lifecycleRule: a.milestones[T].hours, provisionalRods: b.milestones[T].hours, rel: r4((b.milestones[T].hours - a.milestones[T].hours) / a.milestones[T].hours) }]));
		return [p, { maxAbsRel: Math.max(...Object.values(rows).map((x) => Math.abs(x.rel))), hours: rows }];
	}));

	validation = {
		method: 'LC.simulate(system({ policy }) + lifecycle()\'s gear rule (lifecycleRods: F.PURCHASE.saveHours of no-bait stage income, saved from net cash after bait) + LC.provisionalDaily + a milestone probe) on the shared gear path vs lifecycle(policy, archetype), every archetype x policy. Compared: milestone hours as step indices, XP by source at each milestone (fishing without bait = ledger fishing - state.sys.bait.extraXp; bait; daily), run totals (bait spend = ledger.spend.optional.bait, bait extra value, no-bait income, steps) and the baits used.',
		archetypes, policies: VALIDATION_POLICIES,
		matches: complete && worst.maxRelativeDifference < tolerance,
		exact: complete && worst.maxRelativeDifference === 0,
		tolerance,
		maxRelativeDifference: worst.maxRelativeDifference,
		worst,
		maxFloatGap: Math.max(...runs.map((x) => x.r.maxFloatGap)),
		milestonesCompared: runs.reduce((a, x) => a + x.r.milestonesCompared, 0),
		exactMilestones: runs.reduce((a, x) => a + x.r.exactMilestones, 0),
		notes: [
			'Hours are compared, not days: the core counts a level reached on a day\'s final step in that day; lifecycle() used ceil(h / dayH), the next day. Both are reported.',
			'Gaps below 1e-9 of the compared total (milestone XP, run income) count as equal: float summation order differs (the core accrues casts x the per-cast outcome with the bait in the cast; lifecycle() adds hourly no-bait rates and the bait\'s per-cast delta). The starter baits\' XP delta is 0 up to such rounding (strong access changes species, not rarity).',
			'The core runs onDayEnd once more after the stop level is reached mid-day (one extra daily XP after L60); lifecycle() stops at once. Milestone XP is taken before it, and cash is unaffected.',
			'state.sys.bait.extraValue / extraXp are measured on the core\'s actual cast (cast minus the same cast without the bait). Here that equals lifecycle()\'s baitOption delta. With buffs or the Founder profile it includes their interaction with the bait.',
		],
		purchaseRuleSensitivity: { archetype: ref, byPolicy: purchaseRule, note: 'LC.provisionalRods in place of lifecycle()\'s gear rule. lifecycle()\'s rule is kept: a tier\'s price must not depend on bait use, and bait bought is money not saved. The integrated rods system follows the same rule (a fixed assembly cost paid from money after the bait spend).' },
		byArchetype,
	};
	return validation;
}

/** The system's contract and its validation, for report(). */
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
		integration: 'integrate.run({ variant: { bait: \'cash\' | \'xp\' } }) adds system({ policy })',
		validation: validateSystem(),
	};
}

module.exports = {
	PARAMS, STAGES, PROVISIONAL,
	withGear: createBaitModel,
	currentBaits,
	...DEFAULT,
	SYSTEM_NAME, SPEND_ITEM, system, validateSystem,
	report: (opts = {}) => ({ ...(opts.gearPath ? createBaitModel(opts.gearPath).report() : DEFAULT.report()), system: systemReport() }),
};

if (require.main === module) process.stdout.write(`${JSON.stringify(module.exports.report(), null, 1)}\n`);
