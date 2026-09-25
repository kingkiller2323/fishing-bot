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
//   consumptionModel()           per-cast vs per-fish consumption numbers by rod tier and for Founder
//   chaseMetrics()               Legendary+/Lucky catch rates and $ per extra catch for luck baits
//   boosterPackOdds()            Lucky-item (Booster Pack) odds with luck baits (disclosed, never valued)
//   gachaBaitValue()             bait liquid value per box open at current vs proposed prices
//   currentBaits()               today's catalog + measured Old Rod economics (measurements.json)
//   lifecycleSensitivity()       provisional lifecycle (mirrors curve.js) with/without bait
//   report()                     all of the above, plus frameworkVersion
const F = require('./framework');
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
// Provisional inputs shared with curve.js. curve.js does not export them (requiring it runs its
// sweep and prints JSON), so they are mirrored here verbatim; see frameworkChangeRequests. They are
// the task's provisional normal rod path and player archetypes, not bait design choices.
const PROVISIONAL = deepFreeze({
	tiers: {
		old: { level: 0, mean: 1.0, qualities: ['weak'], stats: {} },
		t1: { level: 20, mean: 1.15, qualities: ['weak', 'strong'], stats: { rareFind: 0.2, luck: 0.1 } },
		t2: { level: 30, mean: 1.3, qualities: ['weak', 'strong'], stats: { rareFind: 0.4, luck: 0.2, trophyChance: 0.1, fishingSpeed: 0.05 } },
		t3: { level: 40, mean: 1.5, qualities: ['weak', 'strong'], stats: { rareFind: 0.6, luck: 0.4, trophyChance: 0.3, fishingSpeed: 0.1 } },
		t4: { level: 50, mean: 1.65, qualities: ['weak', 'strong'], stats: { rareFind: 0.9, luck: 0.6, trophyChance: 0.5, fishingSpeed: 0.15 } },
	},
	tierOrder: ['old', 't1', 't2', 't3', 't4'],
	// The tier a player typically holds while fishing each biome (biome unlock level = tier level).
	typicalTier: { 'Ocean': 'old', 'River': 'old', 'Lake': 't1', 'Pond': 't2', 'Coast': 't3', 'Swamp': 't4' },
	archetypes: {
		casual: { minutesPerDay: 12.5, overheadS: 7 },
		regular: { minutesPerDay: 45, overheadS: 4 },
		active: { minutesPerDay: 120, overheadS: 3 },
		grinder: { minutesPerDay: 300, overheadS: 2 },
	},
	lifecycle: { dailyXpPerLevel: 60, purchaseHours: 1.5, stepH: 1 / 60, maxLevel: 60 },
});

// ---------------------------------------------------------------------------------------------
// Design parameters (the only hard-coded bait numbers).
const FRESH = ['River', 'Lake', 'Pond', 'Swamp'];
const SALT = ['Ocean', 'Coast'];
const ALL = ['Ocean', 'River', 'Lake', 'Pond', 'Coast', 'Swamp'];
const PARAMS = deepFreeze({
	consumption: {
		unit: 'cast',
		perCast: 1,
		// Consumed only on a successful cast in a biome where the bait works; elsewhere it does
		// nothing (no stats, no XP) and is not used. Failed casts (NO_CATCH, broken rod...) use none.
		onlyWhereItWorks: true,
		profileIndependent: true, // Founder uses exactly 1 per cast too
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
		'Shrimp': {
			role: 'strong access (saltwater starter)', band: 'starter', biomes: SALT, levelFromBiome: 'Ocean',
			grantsStrong: true, stats: {}, multiChance: 0, pricing: 'money', homeStages: ['ocean-old'],
			description: 'Saltwater starter bait. Lets any rod reach strong fish in Ocean and Coast.',
		},
		'Worm': {
			role: 'strong access (freshwater starter)', band: 'starter', biomes: FRESH, levelFromBiome: 'River',
			grantsStrong: true, stats: {}, multiChance: 0, pricing: 'money', homeStages: ['river-old'],
			description: 'Freshwater starter bait. Lets any rod reach strong fish in fresh water.',
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
			grantsStrong: false, stats: { xpBonus: 0.25 }, multiChance: 0, pricing: 'xp', homeStages: ['lake-t1', 'pond-t2'],
			description: '+25% XP in Lake and Pond.',
		},
		'Bloodworm': {
			role: 'rarity + trophy (late)', band: 'late', biomes: ['Coast', 'Swamp'], levelFromBiome: 'Coast',
			grantsStrong: false, stats: { rareFind: 1.0, trophyChance: 0.75 }, multiChance: 0, pricing: 'money', homeStages: ['coast-t3', 'swamp-t4'],
			description: 'Rare Find +100% and Trophy Chance +75% in Coast and Swamp.',
		},
		'Magic Lure': {
			role: 'endgame all-rounder (XP + every rarity stat)', band: 'late', biomes: ['Coast', 'Swamp'], levelFromBiome: 'Coast',
			grantsStrong: false, stats: { rareFind: 0.75, trophyChance: 0.75, luck: 0.75, xpBonus: 0.3 }, multiChance: 0, pricing: 'xp', homeStages: ['coast-t3', 'swamp-t4'],
			description: '+30% XP and +75% Rare Find, Trophy Chance and Luck in Coast and Swamp.',
		},
		'Strong Magnet': {
			role: 'luck / collection completion, any biome', band: 'universal', biomes: ALL, levelFromBiome: 'Coast',
			grantsStrong: true, stats: { luck: 4.0 }, multiChance: 0, pricing: 'money', homeStages: ['swamp-t4'],
			description: 'Luck +400% (Legendary and Lucky 5x) and strong-fish access in every biome. Priced for Swamp.',
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

/** Normalises a stage to castOutcome input. */
function stageGear(stage) {
	const s = typeof stage === 'string' ? STAGES[stage] : stage;
	if (!s) throw new Error(`Unknown stage ${stage}`);
	const biome = cap(s.biome);
	const tierName = s.tier || PROVISIONAL.typicalTier[biome] || 'old';
	const gear = s.gear || (s.qualities || s.stats || s.mean || s.multiChance !== undefined ? s : PROVISIONAL.tiers[tierName]);
	const multiChance = gear.multiChance !== undefined ? gear.multiChance : F.chanceForMean(gear.mean || 1);
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

const rowOut = (x) => ({
	bait: x.bait, biome: x.biome, tier: x.tier, applies: x.applies, price: x.price,
	extraValuePerCast: r2(x.extraValuePerCast), extraXpPerCast: r3(x.extraXpPerCast),
	cashReturn: r2(x.cashReturn), utilityReturn: r2(x.utilityReturn),
	netCostPerXp: r2(x.netCostPerXp), stageCashPerXp: r2(x.stageCashPerXp), xpPriceRatio: r2(x.xpPriceRatio),
	netShareOfCast: r4(x.netShareOfCast), baseValuePerCast: r2(x.baseValuePerCast),
});

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

// ---------------------------------------------------------------------------------------------
/** Per-cast vs per-fish consumption by rod tier (framework multi-catch) and for today's Founder. */
function consumptionModel() {
	const tiers = PROVISIONAL.tierOrder.map((t) => {
		const d = F.fishDistribution(F.chanceForMean(PROVISIONAL.tiers[t].mean));
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

/** Collection-chase metrics for the luck baits (and Magic Lure) at their home stages and in Ocean. */
function chaseMetrics() {
	const rows = [];
	const cases = [
		['Magnet', 'lake-t1'], ['Magnet', 'pond-t2'],
		['Strong Magnet', 'coast-t3'], ['Strong Magnet', 'swamp-t4'], ['Strong Magnet', 'ocean-old'], ['Strong Magnet', 'river-old'],
		['Magic Lure', 'coast-t3'], ['Magic Lure', 'swamp-t4'],
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
			bait: name, stage: s, price,
			castsPerLegendaryPlus: { without: Math.round(1 / lp0), with: Math.round(1 / lp1) },
			castsPerLuckyFish: { without: Math.round(1 / lu0), with: Math.round(1 / lu1) },
			netCostPerExtraLegendaryPlus: Math.round(net / (lp1 - lp0)),
			netCostPerExtraLegendaryPlusInHoursOfIncome: r2(net / (lp1 - lp0) / F.hourly(o0).cash),
		});
	}
	return rows;
}

/** Booster Pack (Lucky item) odds with luck baits. Disclosed only: never valued in any model. */
function boosterPackOdds() {
	const rows = [];
	for (const [name, s] of [[null, 'ocean-old'], [null, 'swamp-t4'], ['Magnet', 'pond-t2'], ['Strong Magnet', 'swamp-t4'], ['Strong Magnet', 'ocean-old'], ['Magic Lure', 'swamp-t4']]) {
		const g = stageGear(s);
		const b = name ? PARAMS.baits[name] : null;
		const o = outcome(g, b);
		const sp = drawSplit(g, b, o.table);
		const perCast = sp.booster * o.fishPerCast;
		rows.push({
			bait: name, stage: s,
			castsPerBoosterPack: Math.round(1 / perCast),
			hoursPerBoosterPackRegular: Math.round(1 / perCast / F.hourly(o, 4).casts),
			baitSpendPerBoosterPack: name ? Math.round(priceOf(name) / perCast) : 0,
		});
	}
	// Founder today (per draw; Founder draw counts belong to the Founder design).
	const fg = { ...stageGear('swamp-t4'), table: F.FOUNDER_RARITY_TABLE };
	const f0 = drawSplit(fg, null, outcome(fg, null).table);
	const fsm = drawSplit(fg, PARAMS.baits['Strong Magnet'], outcome(fg, PARAMS.baits['Strong Magnet']).table);
	return {
		note: 'Lucky items are excluded from castOutcome value; Booster Packs stay an Easter egg and are counted in no income or progression model.',
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
		out[box] = { baitUnitsPerOpen: r3(units), currentBaitValuePerOpen: r2(cur), proposedBaitValuePerOpen: r2(prop) };
	}
	return out;
}

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
			perBiome,
		};
	});
}

// ---------------------------------------------------------------------------------------------
// Provisional lifecycle, mirroring scripts/economy/5b/curve.js step for step (1-minute steps,
// highest unlocked biome, 60 XP × level daily, a tier bought after saving purchaseHours of the
// no-bait stage income), with bait bought every cast from baitOption(). With policy 'none' it must
// reproduce curve.json; bandCheck-independent cross-check reported as baselineMatchesCurveJson.
const biomeAt = (L) => [...ALL].reverse().find((b) => L >= F.BIOME_LEVEL[b]);
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
			spend: h.casts * opt.costPerCast,
			extra: h.casts * opt.extraValuePerCast,
			bait: opt.bait,
		});
	}
	return lcCache.get(key);
}

function lifecycle(policy = 'none', archName = 'regular') {
	const arch = PROVISIONAL.archetypes[archName];
	const { dailyXpPerLevel, purchaseHours, stepH, maxLevel } = PROVISIONAL.lifecycle;
	const order = PROVISIONAL.tierOrder;
	let xp = 0;
	let h = 0;
	let tierIdx = 0;
	let saving = 0;
	let spend = 0;
	let extra = 0;
	let gross = 0;
	const dayH = arch.minutesPerDay / 60;
	const reached = {};
	const baitsUsed = new Set();
	while (h < 2000) {
		const L = F.levelForXp(xp);
		const cur = order[tierIdx];
		const next = order[tierIdx + 1];
		const r = lcRates(biomeAt(L), cur, arch.overheadS, policy);
		if (r.bait) baitsUsed.add(r.bait);
		if (next && L >= PROVISIONAL.tiers[next].level) {
			saving += r.cash * stepH;
			if (saving >= r.grossNoBait * purchaseHours) {
				tierIdx++;
				saving = 0;
			}
		}
		xp += r.xp * stepH;
		spend += r.spend * stepH;
		extra += r.extra * stepH;
		gross += r.grossNoBait * stepH;
		const before = h;
		h += stepH;
		if (Math.floor(h / dayH) !== Math.floor(before / dayH)) xp += dailyXpPerLevel * L;
		const L2 = F.levelForXp(xp);
		for (const T of [10, 20, 30, 40, 50, 60]) if (!reached[T] && L2 >= T) reached[T] = r2(h);
		if (L2 >= maxLevel) break;
	}
	return {
		policy, archetype: archName, hoursToLevel: reached,
		baitSpendShareOfIncome: r4(spend / gross), baitExtraValueShareOfIncome: r4(extra / gross), netEffectShareOfIncome: r4((extra - spend) / gross),
		baitsUsed: [...baitsUsed],
	};
}

function lifecycleSensitivity() {
	const regular = Object.fromEntries(['none', 'cash', 'xp'].map((p) => [p, lifecycle(p, 'regular')]));
	const grinder = Object.fromEntries(['none', 'xp'].map((p) => [p, lifecycle(p, 'grinder')]));
	const casual = Object.fromEntries(['none', 'cash'].map((p) => [p, lifecycle(p, 'casual')]));
	const ref = CURVE_JSON.archetypes?.regular || {};
	const matches = Object.entries(regular.none.hoursToLevel).every(([L, hrs]) => ref[L] === undefined || Math.abs(ref[L].hours - hrs) < 0.02);
	const curveMatches = CURVE_JSON.chosen === F.CURVE.quartic;
	return { regular, grinder, casual, baselineMatchesCurveJson: matches && curveMatches, curveJsonQuartic: CURVE_JSON.chosen, frameworkQuartic: F.CURVE.quartic };
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
				bestReturnPerDollarOldRod: c.bestReturnPerDollar, bestBiome: c.bestBiome, costPerCastRange: c.costPerCastRange, medianExtraXpPerCast: c.medianExtraXpPerCast,
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
		frameworkVersion: F.FRAMEWORK_VERSION,
		curve: { ...F.CURVE },
		params: {
			consumption: PARAMS.consumption,
			pricing: PARAMS.pricing,
			bands: PARAMS.bands,
		},
		prices: prices(),
		currentVsProposed: currentVsProposed(),
		bandCheck: bandCheck(),
		matrix: baitMatrix(),
		stageOptions: stageOptions(),
		consumption: consumptionModel(),
		chase: chaseMetrics(),
		boosterPack: boosterPackOdds(),
		gacha: gachaBaitValue(),
		lifecycle: lifecycleSensitivity(),
	};
}

module.exports = {
	PARAMS, STAGES, PROVISIONAL,
	stageGear, baitEffect, prices, priceOf, evaluate, baitOption,
	baitMatrix, bandCheck, consumptionModel, chaseMetrics, boosterPackOdds, gachaBaitValue,
	currentBaits, lifecycle, lifecycleSensitivity, currentVsProposed, report,
};

if (require.main === module) process.stdout.write(`${JSON.stringify(report(), null, 1)}\n`);
