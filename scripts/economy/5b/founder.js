// Phase 5B subsystem: FOUNDER COMPENSATION AND PUBLIC LEVEL (framework 5b.4). ANALYSIS ONLY: nothing here
// touches the live game, src/ or production data.
//
// The Founder profile is a SYSTEM on the shared lifecycle core (lifecycle.js), composed by integrate.js as the
// 'founder' variant. This module never steps time: every per-cast number comes from the framework's
// castOutcome() (founderCast() below), and every number over a player's lifecycle comes from integrate.run()
// (the reference core loop: rods, world, quests, streak, buffs) with variant.founder and gate 'public' |
// 'real', against the same loop without it (Normal). Other inputs: today's real-engine data
// (measurements.json, simulation.json, gacha-ev.json), the rods design's crate helpers, and today's production
// Founder profile (src/engine/balance.js PROFILES.founder), whose kept parts are read, never copied.
// The private values (XP and sell multipliers, luck, durability efficiency) are SOLVED from explicit targets
// (solve(); its time-to-level target runs integrated lifecycles), not hand-set. Only PARAMS is hand-set, and
// every non-obvious choice is a PROPOSED decision in DECISIONS (only the user approves).
// docs/economy/5b/founder.md's tables are generated from markdownTables() by render-docs.js.
//
//   node scripts/economy/5b/founder.js           prints report() as JSON
//   node scripts/economy/5b/render-docs.js       fills docs/economy/5b/founder.md from markdownTables()
//
// Exports (pure and synchronous; no database, no randomness):
//   PARAMS, DECISIONS            design parameters; the proposed decisions (decisions.js shape, joined there)
//   founderProfile()             the PROPOSED Founder profile (balance.js PROFILES.founder shape plus the new
//                                fields): kept rarity table, stats, pity and gacha luck; solved private
//                                multipliers (xp, sell), luck and durability efficiency; visible bonus fish
//                                capped at the normal maximum; questXp/questCash; Lucky-item rule; level gate
//   profileWith({luck, xp, sell, durabilityEfficiency})
//                                the same profile with trial values (the solver and the counterfactual use it)
//   founderOutcome(stage, {profile, overheadS}), normalOutcome(stage, {overheadS})
//                                per-cast and per-hour Founder / Normal outcome at a stage (a tier index of
//                                F.gearPath(), a gear-path step, or {tier, biome, overheadS}), with the ratios
//   visibleDistribution(multiChance, bonusFish, maxFish), visibleFromChain(chain, bonusFish, maxFish)
//                                P(n visible fish) for a cast: the normal chain roll + Founder bonus, capped
//   pityLegendaryPlus(perDraw, table, visible, rule)
//                                exact renewal model of the per-cast Legendary+ pity (FOUNDER_PITY)
//   founderCastOutcome(input, profile)
//                                the Founder outcome for a lifecycle.js cast input (the system's outcome hook)
//   system({gate, profile}), systemDescription()
//                                the lifecycle.js SYSTEM (integrate.js 'founder' variant) and its contract
//   lifecycle(archetype, {profile, gating, horizon})
//                                one INTEGRATED lifecycle (integrate.run: the reference loop, plus system() when
//                                `profile` is set; null = Normal): hours to each real and public level, XP by
//                                source (base and profile bonus), tier purchases, the public tell, day 30
//   today()                      TODAY's Founder power per stage and as ratios to TODAY's Normal (measured)
//   solve()                      the private values from the targets (cached); M2 on integrated lifecycles
//   gacha(), founderCrates(t)    Founder vs Normal box luck; exact crates-to-assemble for tier t
//   publicLevelStatus()          F1: what shipped (commit 14e27f1) and what stays proposed, read from src/
//   publicXpDefinition()         the model's public XP against the shipped definition (integrated ledgers)
//   RETIRED_LOOP_PARITY          the recorded parity of system() with the retired private loop (a83b5f0)
//   report(), markdownTables()
const fs = require('node:fs');
const nodePath = require('node:path');
const F = require('./framework');
const LC = require('./lifecycle');
const rods = require('./rods');
const { PROFILES, RARITIES, STAT_CAPS, BALANCE_VERSION, levelForXp: levelForXpToday } = require('../../../src/engine/balance');
const { buildTable, applyPity } = require('../../../src/engine/rarity');
const { baseTable } = require('../../../src/engine/gacha');
const { resolveModifiers } = require('../../../src/engine/modifiers');
const MEASURED = require('../../../docs/economy/measurements.json');
const SIMULATED = require('../../../docs/economy/simulation.json');
const GACHA_EV = require('../../../docs/economy/gacha-ev.json');
const BOX_CATALOG = require('../../../src/bootstrap/data/gacha');
// integrate.js loads this module through its registry, and quests/buffs read founderProfile(): all lazy.
const INTEGRATE = () => require('./integrate');
const QUESTS = () => require('./quests');
const BUFFS = () => require('./buffs');

const deepFreeze = (o) => {
	for (const v of Object.values(o)) if (v && typeof v === 'object' && !Object.isFrozen(v)) deepFreeze(v);
	return Object.freeze(o);
};

// Today's production Founder profile (src/engine/balance.js). The parts this design KEEPS are read
// from here, never copied: rarity table, stats (durability efficiency, fishing speed), bonus-draw
// distribution, quest multipliers, pity and gacha luck.
const TODAY = PROFILES.founder;

// ---------------------------------------------------------------------------------------------
// Design parameters (the only hand-set numbers in this subsystem). Every choice here is in DECISIONS.
const PARAMS = deepFreeze({
	id: 'founder-5b',
	visible: {
		// Founder bonus fish per cast, added to the rod's NORMAL multi-catch roll (framework chain).
		// Kept at today's per-cast distribution, so the Old Rod looks exactly as it does today. The total is
		// capped at the normal maximum (F.MULTI.maxFish), so every Founder catch card is one a normal player
		// can also get; only the frequency differs.
		bonusFish: { ...TODAY.bonusDraws },
	},
	targets: {
		// Headroom above the binding target, for every solved value ("err on the side of absurd").
		margin: 1.1,
		// Today's measured rod that stands for each new tier when ratios are compared at equal gear.
		// Where two rods bracket a tier, the higher ratio is the target.
		todayRodOfTier: {
			0: ['Old Rod'],
			1: ['Custom (Uncommon parts)'],
			2: ['Custom (Rare parts)'],
			3: ['Custom (Rare parts)', 'Custom (Legendary parts)'],
			4: ['Custom (Legendary parts)'],
			5: ['Custom (Legendary parts)'],
		},
		// Time to afford: the two gear purchases that exist today (simulation.json stages) and the new
		// tier set bought at the same milestone.
		todayPurchaseOfTier: { 1: 'c20', 2: 'c30' },
		todayStageBefore: { c20: 'old', c30: 'c20' },
		// Both level-gate options are solved; the multipliers satisfy the targets under either.
		gatingModes: ['public', 'real'],
	},
	rounding: { smallStep: 0.5, largeStep: 5, largeFrom: 10, luckStep: 0.05, efficiencyStep: 0.05 },
	durability: {
		// Today the engine charges max(1, ceil(n x (1 - eff))) per cast, so efficiency never takes a cast
		// below 1 and the Founder's faster casting would wear a rod out FASTER per hour than a normal
		// player's. Proposed rule (framework P-DURABILITY): stochastic rounding of n x (1 - eff), no minimum
		// (identical for eff 0, i.e. every normal rod). The Founder's efficiency is then solved so rod life
		// in hours of play, relative to Normal, is at least today's (never below today's, never above
		// STAT_CAPS).
		rule: 'stochastic',
	},
	plausibility: {
		// Private luck restores Legendary+ per hour, but the share of PUBLIC catch cards that show a
		// Legendary or Lucky fish must stay at or below this (the card shows rarity).
		maxLegendaryCardShare: 1 / 3,
	},
	// Lucky items (Booster Pack, Gold Rod Piece) come from a Lucky draw 20% of the time today, so the
	// Founder's Lucky table multiplies them. The framework's proposed P-LUCKY pins the item branch to the
	// NORMAL base table for every profile and every luck source; the Founder's extra Lucky mass becomes
	// Lucky fish.
	luckyItems: 'normal-base',
	publicLevel: {
		// SHIPPED (14e27f1): the publicXp field. PROPOSED: a stored publicLevel (no-demotion floor at the
		// curve change, like level).
		xpField: 'publicXp',
		levelField: 'publicLevel',
		// Recommended (framework P-FOUNDER-GATE): every gameplay level gate (biomes, permits, rod level cap,
		// shop, quests, level-scaled rewards) reads the PUBLIC level, so a public card never shows a catch
		// the public level could not have made. 'real' is the alternative (and what is live today).
		gate: 'public',
		// /dev xp add|set applies to both xp and publicXp (shipped rule).
		devGrantDefaultScope: 'both',
	},
});

// Solver search (numerical, not a design choice): the XP multiplier's time-to-level need is bracketed
// by doubling from `start`, then bisected `steps` times (the result is always on the feasible side).
const XP_SEARCH = deepFreeze({ start: 64, max: 4096, steps: 16 });

// Parts of today's measured crafted rods (scripts/economy/measure.js, the "Custom (...)" scenarios).
const MEASURED_ROD_PARTS = {
	'Custom (Common parts)': ['Wooden Rod Piece', 'Plastic Reel', 'Barbed Hook', 'Wooden Handle'],
	'Custom (Uncommon parts)': ['Bamboo Rod Piece', 'Aluminum Reel', 'Circle Hook', 'Cork Handle'],
	'Custom (Rare parts)': ['Graphite Rod Piece', 'Jigging Reel', 'Treble Hook', 'EVA Handle'],
	'Custom (Legendary parts)': ['Composite Rod Piece', 'Sage Green Reel', 'Worm Hook', 'Composite Handle'],
};
// cast.js drawTemplates: a Lucky draw returns a Lucky catalog item 20% of the time (engine constant).
const LUCKY_ITEM_SHARE = 0.2;
const TODAY_RODS = ['Old Rod', 'Custom (Uncommon parts)', 'Custom (Rare parts)', 'Custom (Legendary parts)'];

// ---------------------------------------------------------------------------------------------
// Helpers
const round = (x, d = 2) => (Number.isFinite(x) ? Number(x.toFixed(d)) : x);
const sum = (a) => a.reduce((s, x) => s + x, 0);
const maxOf = (a) => Math.max(...a);
const minOf = (a) => Math.min(...a);
const niceUp = (x, step) => Math.ceil(x / step - 1e-9) * step;
const niceMultiplier = (x) => round(x < PARAMS.rounding.largeFrom ? niceUp(x, PARAMS.rounding.smallStep) : niceUp(x, PARAMS.rounding.largeStep), 4);
const lplus = (rarity) => (rarity.legendary || 0) + (rarity.lucky || 0);
const gear = (t) => (typeof t === 'object' && t ? t : F.gearPath()[t]);
const normalChance = (tier) => F.chanceForMean(tier.meanFish);
const numericKeys = (o) => Object.keys(o || {}).filter((k) => /^\d+$/.test(k)).map(Number).sort((a, b) => a - b);
const mapValues = (o, fn) => Object.fromEntries(Object.entries(o).map(([k, v]) => [k, fn(v, k)]));
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
function mean(a) {
	return a.length ? sum(a) / a.length : 0;
}
const bisect = (ok, lo, hi, iters = 60) => {
	for (let i = 0; i < iters; i++) {
		const mid = (lo + hi) / 2;
		if (ok(mid)) hi = mid;
		else lo = mid;
	}
	return hi;
};

// ---------------------------------------------------------------------------------------------
// The profile
/** Founder profile with trial private values (luck added to today's stats; efficiency; xp/sell multipliers). */
function profileWith({ luck = 0, xp = 1, sell = 1, durabilityEfficiency = TODAY.stats.durabilityEfficiency } = {}) {
	const stats = { ...TODAY.stats, durabilityEfficiency };
	if (luck) stats.luck = round((stats.luck || 0) + luck, 4);
	return {
		name: 'founder',
		competitiveEligible: false,
		rarityTable: { ...TODAY.rarityTable },
		stats,
		bonusDraws: { ...PARAMS.visible.bonusFish },
		multipliers: { xp, sell, questXp: TODAY.multipliers.questXp, questCash: TODAY.multipliers.questCash },
		limits: { maxDraws: F.MULTI.maxFish, maxPerDraw: 1 },
		pity: TODAY.pity,
		gacha: TODAY.gacha,
		luckyItems: PARAMS.luckyItems,
		levelGate: PARAMS.publicLevel.gate,
	};
}

/** Gear stats + profile stats, added then clamped exactly like resolveModifiers (STAT_CAPS). */
function combinedStats(tier, profile) {
	const s = { ...(tier.stats || {}) };
	for (const [k, v] of Object.entries(profile ? profile.stats : {})) s[k] = (s[k] || 0) + v;
	for (const k of Object.keys(s)) if (STAT_CAPS[k]) s[k] = Math.min(STAT_CAPS[k].max, Math.max(STAT_CAPS[k].min, s[k]));
	return s;
}

// ---------------------------------------------------------------------------------------------
// Visible catch distribution
/**
 * P(n fish on the public card) from the NORMAL multi-catch roll `chain` (P(n fish), any length) plus the
 * Founder's bonus fish, capped at maxFish. Returns { dist[0..maxFish], mean, pOne, p3plus, p5 }.
 */
function visibleFromChain(chain, bonusFish = PARAMS.visible.bonusFish, maxFish = F.MULTI.maxFish) {
	const total = sum(Object.values(bonusFish));
	const dist = new Array(maxFish + 1).fill(0);
	chain.forEach((pn, n) => {
		if (!pn) return;
		for (const [b, pb] of Object.entries(bonusFish)) dist[Math.min(maxFish, n + Number(b))] += (pn * pb) / total;
	});
	const visibleMean = dist.reduce((s, p, n) => s + p * n, 0);
	return { dist, mean: visibleMean, pOne: dist[1], p3plus: sum(dist.slice(3)), p5: dist[maxFish] };
}

/** visibleFromChain on the framework chain for a rod multi-catch chance (F.fishDistribution). */
function visibleDistribution(multiChance, bonusFish = PARAMS.visible.bonusFish, maxFish = F.MULTI.maxFish) {
	return visibleFromChain(F.fishDistribution(multiChance).dist, bonusFish, maxFish);
}

// ---------------------------------------------------------------------------------------------
// Pity (FOUNDER_PITY legendaryPlus, per cast). Exact renewal over the "casts since Legendary+" counter;
// the per-draw Legendary+ probability of a pity-raised table is mapped through the biome's acceptance
// ratio (separable approximation). The Lucky rule is not modelled (it only raises Lucky further), so
// Legendary+ rates are a slight UNDER-estimate for the Founder (conservative for the targets).
function pityLegendaryPlus(perDrawLplus, table, visible, rule) {
	const m0 = lplus(table);
	const noPity = { perCast: visible.mean * perDrawLplus, cardShare: 1 - visible.dist.reduce((s, p, n) => s + p * (1 - perDrawLplus) ** n, 0) };
	if (!rule || !(m0 > 0) || !(perDrawLplus > 0)) return { ...noPity, perFish: perDrawLplus, withPity: false, castsPerHit: 1 / Math.max(noPity.cardShare, 1e-12) };
	const k = (perDrawLplus * (1 - m0)) / ((1 - perDrawLplus) * m0);
	let S = 1;
	let sumS = 0;
	let sumHits = 0;
	let sumCard = 0;
	for (let c = 0; c < rule.hard; c++) {
		const raised = applyPity(table, { [rule.counter]: c }, { legendaryPlus: rule }).table;
		const m = lplus(raised);
		const p = (m * k) / (m * k + 1 - m);
		const guaranteed = c + 1 >= rule.hard;
		const miss = guaranteed ? 0 : visible.dist.reduce((s, pn, n) => s + pn * (1 - p) ** n, 0);
		const expected = guaranteed ? 1 + (visible.mean - 1) * p : visible.mean * p;
		sumS += S;
		sumHits += S * expected;
		sumCard += S * (1 - miss);
		S *= miss;
		if (S < 1e-15) break;
	}
	return { perCast: sumHits / sumS, perFish: sumHits / sumS / visible.mean, cardShare: sumCard / sumS, castsPerHit: sumS, withPity: true, noPity };
}

// ---------------------------------------------------------------------------------------------
// Outcomes
const tierSignatures = new WeakMap();
/**
 * Cache key of a gear-path step: its index plus everything an outcome reads from it, so steps of different
 * paths never share a cache entry.
 */
function tierKey(tier) {
	let k = tierSignatures.get(tier);
	if (!k) {
		k = `${tier.tier}|${JSON.stringify([tier.meanFish, tier.qualities, tier.stats])}`;
		tierSignatures.set(tier, k);
	}
	return k;
}

const normalCache = new Map();
/** Normal outcome at a stage (framework chain on the tier's mean fish). */
function normalOutcome(stage, { overheadS = stage?.overheadS ?? F.DESIGN_OVERHEAD_S } = {}) {
	const tier = gear(stage?.tier ?? stage);
	const biome = stage?.biome || F.biomeAt(tier.level);
	const key = `${tierKey(tier)}|${biome}|${overheadS}`;
	if (!normalCache.has(key)) {
		const o = F.castOutcome({ biome, qualities: tier.qualities, stats: tier.stats, multiChance: normalChance(tier) });
		const h = F.hourly(o, overheadS);
		const perDrawLplus = lplus(o.rarity);
		normalCache.set(key, {
			tier: tier.tier, biome, overheadS, outcome: o, hourly: h,
			legendaryPlusPerCast: o.fishPerCast * perDrawLplus,
			legendaryPlusPerHour: h.casts * o.fishPerCast * perDrawLplus,
			legendaryCardShare: 1 - F.fishDistribution(normalChance(tier)).dist.reduce((s, p, n) => s + p * (1 - perDrawLplus) ** n, 0),
		});
	}
	return normalCache.get(key);
}

// One fish exactly: the per-DRAW outcome (the visible count is applied separately).
const ONE_FISH = Object.freeze([0, 1]);
/**
 * The Founder's cast from explicit inputs; founderOutcome() and the lifecycle system (system()) share it.
 * g: { biome, qualities, stats (gear and any other stat source; the profile's stats are added, then
 * clamped to STAT_CAPS), chain (P(n fish) of the NORMAL multi-catch roll), sellMult, xpMult (public
 * multipliers such as buffs: in base AND final), fish, fishKey, rules (F.castOutcome overrides) }.
 * Per-draw XP/value come from F.castOutcome with the Founder rarity table and the combined stats; the
 * visible count (chain + bonus fish, capped) multiplies them (every visible fish is a draw from the same
 * table). Base = without the profile's private multipliers (the public card, publicXp); final = x them.
 */
function founderCast(g, p) {
	const stats = combinedStats({ stats: g.stats }, p);
	const per = F.castOutcome({ biome: g.biome, qualities: g.qualities, stats, fishDist: ONE_FISH, table: p.rarityTable, sellMult: g.sellMult, xpMult: g.xpMult, fish: g.fish, fishKey: g.fishKey, rules: g.rules });
	const visible = visibleFromChain(g.chain, p.bonusDraws, p.limits.maxDraws);
	const table = buildTable(p.rarityTable, stats);
	const pity = pityLegendaryPlus(lplus(per.rarity), table, visible, p.pity?.legendaryPlus || null);
	const eff = stats.durabilityEfficiency || 0;
	const durabilityByRule = {
		ceil: visible.dist.reduce((s, q, n) => s + (n > 0 ? q * Math.max(1, Math.ceil(n * (1 - eff) - 1e-9)) : 0), 0),
		stochastic: visible.mean * (1 - eff),
	};
	const xpBase = visible.mean * per.xpPerCast;
	const valueBase = visible.mean * per.valuePerCast;
	return { stats, per, visible, pity, durabilityByRule, xpBase, valueBase, xp: xpBase * p.multipliers.xp, value: valueBase * p.multipliers.sell };
}

const founderCache = new Map();
/**
 * Founder outcome at a stage under `profile` (default: the proposed founderProfile()), from founderCast()
 * on the tier's stats and the framework chain for the tier's mean fish.
 * Base = without the profile multipliers (what the public card shows and publicXp receives);
 * final = what the account receives. Pity is applied to the Legendary+ frequency only (its XP/value
 * uplift is left out, so XP/$ are slight under-estimates: conservative for the targets).
 */
function founderOutcome(stage, { profile = null, overheadS = stage?.overheadS ?? F.DESIGN_OVERHEAD_S } = {}) {
	const p = profile || founderProfile();
	const tier = gear(stage?.tier ?? stage);
	const biome = stage?.biome || F.biomeAt(tier.level);
	const key = `${JSON.stringify([p.stats, p.multipliers, p.bonusDraws, p.limits])}|${tierKey(tier)}|${biome}|${overheadS}`;
	if (founderCache.has(key)) return founderCache.get(key);
	const c = founderCast({ biome, qualities: tier.qualities, stats: tier.stats, chain: F.fishDistribution(normalChance(tier)).dist }, p);
	const { stats, per, visible, pity } = c;
	const durabilityPerCast = PARAMS.durability.rule === 'stochastic' ? c.durabilityByRule.stochastic : c.durabilityByRule.ceil;
	const perCast = {
		fish: visible.mean,
		xpBase: c.xpBase,
		xp: c.xpBase * p.multipliers.xp,
		valueBase: c.valueBase,
		value: c.valueBase * p.multipliers.sell,
		durability: durabilityPerCast,
		legendaryPlus: pity.perCast,
		baitUnits: 1,
	};
	const casts = 3600 / (per.cooldownMs / 1000 + overheadS);
	const hourly = Object.fromEntries(Object.entries(perCast).map(([k, v]) => [k, v * casts]));
	hourly.casts = casts;
	const n = normalOutcome({ tier, biome }, { overheadS });
	const result = {
		tier: tier.tier, biome, overheadS, cooldownMs: per.cooldownMs, stats,
		visible, perDraw: { xp: per.xpPerCast, value: per.valuePerCast, legendaryPlus: lplus(per.rarity), rarity: per.rarity },
		perCast, hourly, pity,
		durabilityByRule: c.durabilityByRule,
		legendaryCardShare: pity.cardShare,
		normal: { fishPerCast: n.outcome.fishPerCast, xpPerHour: n.hourly.xp, cashPerHour: n.hourly.cash, casts: n.hourly.casts, fishPerHour: n.hourly.fish, cooldownMs: n.outcome.cooldownMs, legendaryPlusPerHour: n.legendaryPlusPerHour, legendaryCardShare: n.legendaryCardShare, durabilityPerCast: n.outcome.durabilityPerCast, p3plus: n.outcome.jackpot3plus },
		ratio: {
			xpBase: hourly.xpBase / n.hourly.xp,
			xp: hourly.xp / n.hourly.xp,
			cashBase: hourly.valueBase / n.hourly.cash,
			cash: hourly.value / n.hourly.cash,
			legendaryPlus: hourly.legendaryPlus / n.legendaryPlusPerHour,
			casts: casts / n.hourly.casts,
			fish: visible.mean / n.outcome.fishPerCast,
			durabilityPerFish: (durabilityPerCast / visible.mean) / (n.outcome.durabilityPerCast / n.outcome.fishPerCast),
		},
	};
	founderCache.set(key, result);
	return result;
}

// ---------------------------------------------------------------------------------------------
// TODAY: real-engine measurements (1,000 casts per scenario, Founder casts persisted so pity advances).
const scenario = (rod, biome, profile) => MEASURED.results.find((r) => r.key === `${biome.toLowerCase()}|${rod}|-|${profile}`) || null;

/** Today's per-hour rates for a measured scenario at a cadence (recomputed from per-cast totals). */
function todayRates(rod, biome, profile, overheadS = F.DESIGN_OVERHEAD_S) {
	const s = scenario(rod, biome, profile);
	if (!s) return null;
	const casts = 3600 / (s.cooldownMs / 1000 + overheadS);
	const k = casts / s.casts;
	const items = Object.values(s.items || {}).reduce((a, b) => a + b, 0);
	return {
		rod, biome, profile, cooldownMs: s.cooldownMs, castsPerHour: casts, fishPerCast: s.units / s.casts,
		xpPerHour: s.xpFinal * k, xpBasePerHour: s.xpBase * k, cashPerHour: s.valueFinal * k, cashBasePerHour: s.valueBase * k,
		durabilityPerCast: s.durability / s.casts, legendaryPlusPerHour: lplus(s.rarityUnits) * k,
		luckyItemsPerHour: items * k, boosterPacksPerHour: ((s.items || {})['Booster Pack'] || 0) * k, sample: { casts: s.casts, units: s.units, legendaryPlus: lplus(s.rarityUnits) },
	};
}

/** Today's NORMAL Legendary+ per fish, exact (legacy crafted-rod stats through resolveModifiers). */
const todayNormalCache = new Map();
function todayNormalLegendaryPlusPerFish(rod, biome) {
	const key = `${rod}|${biome}`;
	if (!todayNormalCache.has(key)) {
		let qualities = ['weak'];
		let stats = {};
		const names = MEASURED_ROD_PARTS[rod];
		if (names) {
			const list = names.map((n) => rods.CATALOG.find((p) => p.name === n));
			const m = resolveModifiers({ profile: { name: 'normal', ...PROFILES.normal }, rod: { name: rod, type: 'customrod', capabilities: rods.legacyCombine(list) }, rodParts: list });
			qualities = m.qualities;
			stats = { rareFind: m.stats.rareFind, luck: m.stats.luck, trophyChance: m.stats.trophyChance };
		}
		todayNormalCache.set(key, lplus(F.castOutcome({ biome, qualities, stats, multiChance: 0 }).rarity));
	}
	return todayNormalCache.get(key);
}

let todayMemo = null;
/** TODAY's Founder power per stage and as ratios to TODAY's Normal on the same rod and biome. */
function today() {
	if (todayMemo) return todayMemo;
	const byRod = {};
	for (const rod of TODAY_RODS) {
		const biomes = {};
		let fN = 0;
		let fF = 0;
		let lpF = 0;
		let lpN = 0;
		let unitsF = 0;
		let lpUnitsF = 0;
		for (const biome of F.LIVE_BIOMES) {
			const n = todayRates(rod, biome, 'normal');
			const f = todayRates(rod, biome, 'founder');
			const lpNh = n.castsPerHour * n.fishPerCast * todayNormalLegendaryPlusPerFish(rod, biome);
			biomes[biome] = {
				xpRatio: f.xpPerHour / n.xpPerHour, cashRatio: f.cashPerHour / n.cashPerHour,
				founder: { xpPerHour: f.xpPerHour, cashPerHour: f.cashPerHour, legendaryPlusPerHour: f.legendaryPlusPerHour },
				normal: { xpPerHour: n.xpPerHour, cashPerHour: n.cashPerHour, legendaryPlusPerHour: lpNh },
			};
			fN += n.fishPerCast;
			fF += f.fishPerCast;
			lpF += f.legendaryPlusPerHour;
			lpN += lpNh;
			unitsF += f.sample.units;
			lpUnitsF += f.sample.legendaryPlus;
		}
		const f0 = todayRates(rod, F.LIVE_BIOMES[0], 'founder');
		const n0 = todayRates(rod, F.LIVE_BIOMES[0], 'normal');
		const k = F.LIVE_BIOMES.length;
		byRod[rod] = {
			fishPerCast: { normal: fN / k, founder: fF / k },
			cooldownMs: { normal: n0.cooldownMs, founder: f0.cooldownMs },
			castsPerHour: { normal: n0.castsPerHour, founder: f0.castsPerHour },
			xpRatio: { min: minOf(Object.values(biomes).map((b) => b.xpRatio)), max: maxOf(Object.values(biomes).map((b) => b.xpRatio)) },
			cashRatio: { min: minOf(Object.values(biomes).map((b) => b.cashRatio)), max: maxOf(Object.values(biomes).map((b) => b.cashRatio)) },
			legendaryPlusPerHour: { founder: lpF / k, normal: lpN / k, ratio: lpF / lpN, founderPerFish: lpUnitsF / unitsF },
			durabilityPerFish: { normal: n0.durabilityPerCast / n0.fishPerCast, founder: fF ? (sum(F.LIVE_BIOMES.map((b) => todayRates(rod, b, 'founder').durabilityPerCast)) / k) / (fF / k) : null },
			// Rod life in hours of play, Founder / Normal, on the same rod (durability cancels out).
			rodLifeRatio: mean(F.LIVE_BIOMES.map((b) => {
				const n = todayRates(rod, b, 'normal');
				const f = todayRates(rod, b, 'founder');
				return (n.durabilityPerCast * n.castsPerHour) / (f.durabilityPerCast * f.castsPerHour);
			})),
			luckyItemsPerHour: { founder: sum(F.LIVE_BIOMES.map((b) => todayRates(rod, b, 'founder').luckyItemsPerHour)) / k, boosterPacks: sum(F.LIVE_BIOMES.map((b) => todayRates(rod, b, 'founder').boosterPacksPerHour)) / k },
			biomes,
		};
	}
	const lifecycles = {};
	for (const a of Object.keys(F.ARCHETYPES)) {
		const fo = SIMULATED.players[a]?.founder;
		const co = SIMULATED.players[a]?.core;
		if (!fo || !co) continue;
		const day30 = (p) => p.timeline.find((x) => x.day === 30) || p.timeline[p.timeline.length - 1];
		lifecycles[a] = {
			founderHours: Object.fromEntries(F.LIFECYCLE.milestones.map((L) => [L, fo.milestones[`level${L}`]?.hours ?? null])),
			normalHours: Object.fromEntries(F.LIFECYCLE.milestones.map((L) => [L, co.milestones[`level${L}`]?.hours ?? null])),
			day30: { founder: { level: day30(fo).level, xp: day30(fo).xp, money: day30(fo).money }, normal: { level: day30(co).level, xp: day30(co).xp, money: day30(co).money } },
		};
	}
	todayMemo = { byRod, lifecycles };
	return todayMemo;
}

// ---------------------------------------------------------------------------------------------
// Gacha: Founder vs Normal box luck (FOUNDER_GACHA_STATS and FOUNDER_GACHA_PITY, both kept).
/** Steady-state P(open holds a Legendary+) with a pity rule, for `slots` independent slots. */
function boxLegendaryRate(table, slots, rule) {
	const m0 = lplus(table);
	const noPity = 1 - (1 - m0) ** slots;
	if (!rule || !(m0 > 0)) return { perOpen: noPity, noPity, opensPerHit: 1 / Math.max(noPity, 1e-12) };
	let S = 1;
	let sumS = 0;
	for (let c = 0; c < rule.hard; c++) {
		const m = lplus(applyPity(table, { [rule.counter]: c }, { legendaryPlus: rule }).table);
		const hit = c + 1 >= rule.hard ? 1 : 1 - (1 - m) ** slots;
		sumS += S;
		S *= 1 - hit;
		if (S < 1e-15) break;
	}
	return { perOpen: 1 / sumS, noPity, opensPerHit: sumS };
}

const SLOT_OF_TYPE = Object.fromEntries(Object.entries(rods.SLOTS).map(([s, t]) => [t, s]));
const rankOf = (r) => rods.RARITY_ORDER.findIndex((x) => x.toLowerCase() === String(r).toLowerCase());
const PART_POOLS = Object.fromEntries(RARITIES.map((r) => [r, rods.CATALOG.filter((p) => p.rarity.toLowerCase() === r)]));

/** Exact crates-until-complete for a (possibly Founder) crate definition: same chain as rods.cratesDistribution. */
function crateChain(def, need, maxN = 5000) {
	const rules = Object.values(def.pity || {});
	if (rules.length > 1) throw new Error('one pity rule per box is modelled');
	const rule = rules[0] || null;
	const full = (1 << need.length) - 1;
	const hitMask = (picks) => need.reduce((m, x, j) => (picks.some((p) => SLOT_OF_TYPE[p.type] === x.slot && rankOf(p.rarity) >= rankOf(x.rarity)) ? m | (1 << j) : m), 0);
	const trans = new Map();
	const transFor = (c) => {
		if (!trans.has(c)) {
			const agg = new Map();
			for (const o of rods.openOutcomes(def, rule ? c : null)) {
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
	const quantile = (q) => survival.findIndex((x) => 1 - x >= q);
	return { expected: sum(survival), median: quantile(0.5), p90: quantile(0.9) };
}

/** The Founder's view of rods tier crate t: Founder gacha stats on the box table, plus Founder pity. */
function founderCrateDefinition(t) {
	const def = rods.crateDefinition(t);
	const boxBase = baseTable(def, PART_POOLS);
	const table = buildTable(boxBase, TODAY.gacha.stats);
	// Engine rule: box pity + profile pity, skipping rules for tiers the box cannot award. A Founder
	// Legendary+ rule on a box whose every slot is Legendary+ (floor) can never fire, so it is omitted.
	const founderRule = TODAY.gacha.pity?.legendaryPlus;
	const canAward = founderRule && founderRule.tiers.some((r) => boxBase[r] > 0);
	const alwaysHits = founderRule && RARITIES.every((r) => founderRule.tiers.includes(r) || !(boxBase[r] > 0));
	let pity = def.pity || null;
	if (canAward && !alwaysHits) {
		if (pity) throw new Error(`crate ${t}: box and Founder pity together are not modelled`);
		pity = { legendaryPlus: founderRule };
	}
	return { ...def, id: `${def.id}@founder`, rarityTable: table, pity };
}

const crateMemo = new Map();
/** Crates to assemble tier t's reference set: Normal (validated against rods) and Founder. */
function founderCrates(t) {
	if (!crateMemo.has(t)) {
		const ref = rods.cratesDistribution(t);
		const normal = crateChain(rods.crateDefinition(t), ref.need);
		const fdef = founderCrateDefinition(t);
		const founder = crateChain(fdef, ref.need);
		const price = rods.cratePrice(t);
		crateMemo.set(t, {
			tier: t, crate: rods.crateDefinition(t).name, price,
			normal: { expected: normal.expected, p90: normal.p90, expectedCost: normal.expected * price, matchesRods: Math.abs(normal.expected - ref.expected) < 1e-9 },
			founder: { expected: founder.expected, p90: founder.p90, expectedCost: founder.expected * price, pity: fdef.pity ? Object.keys(fdef.pity) : [] },
			founderCrateFactor: founder.expected / normal.expected,
			legendaryPlusPerSlot: { normal: lplus(baseTable(rods.crateDefinition(t), PART_POOLS)), founder: lplus(fdef.rarityTable) },
		});
	}
	return crateMemo.get(t);
}

let gachaMemo = null;
/** Founder vs Normal box luck: today's boxes (P(open has Legendary+)) and the rods tier crates. */
function gacha() {
	if (gachaMemo) return gachaMemo;
	const boxes = {};
	for (const name of ['Fishing Crate', 'Daily Box', 'Voter\'s Crate']) {
		const g = GACHA_EV[name];
		const normal = boxLegendaryRate(g.rarityTable, g.slots, null);
		const fTable = buildTable(g.rarityTable, TODAY.gacha.stats);
		const founder = boxLegendaryRate(fTable, g.slots, TODAY.gacha.pity?.legendaryPlus || null);
		boxes[name] = { slots: g.slots, normalPerOpen: normal.perOpen, founderNoPity: founder.noPity, founderWithPity: founder.perOpen, ratio: founder.perOpen / normal.perOpen, opensPerLegendaryPlus: { normal: normal.opensPerHit, founder: founder.opensPerHit } };
	}
	const crates = Object.fromEntries([1, 2, 3, 4, 5].map((t) => [t, founderCrates(t)]));
	gachaMemo = { boxes, crates };
	return gachaMemo;
}

// ---------------------------------------------------------------------------------------------
// Framework 5b.3+: the Founder profile as a SYSTEM on the shared lifecycle core (lifecycle.js).
// integrate.js runs it as the 'founder' variant.
const SYSTEM_NAME = 'founder';
const TOP_LIVE_BIOME = F.LIVE_BIOMES[F.LIVE_BIOMES.length - 1];

/** The NORMAL multi-catch roll of a lifecycle.js cast input: fishDist when set, else the framework chain. */
function inputChain(input) {
	if (input.fishDist) {
		const total = input.fishDist.reduce((a, b) => a + (b || 0), 0);
		return input.fishDist.map((q) => (q || 0) / total);
	}
	// As F.castOutcome: the rod's chance plus the additive multiChance stat (clamped), at most 1.
	const extra = F.clampStats({ multiChance: input.stats?.multiChance || 0 }).multiChance;
	return F.fishDistribution(Math.min(1, (input.multiChance || 0) + extra), input.multiOpts).dist;
}

/**
 * The Founder outcome for a lifecycle.js cast input (the system's outcome hook; founderCast() underneath,
 * as founderOutcome()). Honours every input field other systems set: biome, qualities, stats (gear, bait,
 * ...; the profile's stats are added, then clamped to STAT_CAPS), multiChance + stats.multiChance (the
 * normal chain) or fishDist (a full P(n fish) chain override), multiOpts, sellMult / xpMult (public
 * multipliers: in base AND final), fish / fishKey, rules (durability and Lucky-item rules, default
 * F.RULES). The profile brings its own base rarity table, so an input.table is refused.
 * Returns the core's fields (fishPerCast, xpPerCast = final, xpBasePerCast, valuePerCast = final,
 * valueBasePerCast, cooldownMs, durabilityPerCast) plus the visible fishDist, Lucky-item split,
 * Legendary+ per cast with pity and the card share.
 */
function founderCastOutcome(input, profile = null) {
	const p = profile || founderProfile();
	if (input.table) throw new Error(`${SYSTEM_NAME}: input.table is set, but the Founder profile brings its own base rarity table (two base tables cannot both apply)`);
	const c = founderCast({
		biome: input.biome, qualities: input.qualities || ['weak'], stats: input.stats || {}, chain: inputChain(input),
		sellMult: input.sellMult, xpMult: input.xpMult, fish: input.fish, fishKey: input.fishKey, rules: input.rules,
	}, p);
	const rule = { ...F.RULES, ...(input.rules || {}) }.durability;
	const eff = c.stats.durabilityEfficiency || 0;
	return {
		profile: SYSTEM_NAME, biome: input.biome, tier: input.tier,
		fishPerCast: c.visible.mean, fishDist: c.visible.dist, jackpot3plus: c.visible.p3plus, jackpot5: c.visible.p5,
		xpPerCast: c.xp, xpBasePerCast: c.xpBase,
		valuePerCast: c.value, valueBasePerCast: c.valueBase,
		valuePerFish: c.per.valuePerFish * p.multipliers.sell, valueBasePerFish: c.per.valuePerFish,
		cooldownMs: c.per.cooldownMs,
		durabilityPerCast: c.visible.dist.reduce((s, q, n) => s + (n > 0 ? q * F.durabilityCost(n, eff, rule) : 0), 0),
		fishSharePerDraw: c.per.fishSharePerDraw, itemPerDraw: c.per.itemPerDraw, boosterPerDraw: c.per.boosterPerDraw,
		itemsPerCast: c.visible.mean * c.per.itemPerDraw, luckyItemShare: c.per.luckyItemShare,
		legendaryPlusPerCast: c.pity.perCast, legendaryCardShare: c.pity.cardShare,
		multipliers: { xp: p.multipliers.xp, sell: p.multipliers.sell },
		stats: c.stats, rarity: c.per.rarity, table: c.per.table,
	};
}

/** Everything of a profile the cast outcome depends on (the core's outcome cache key). */
const profileKey = (p) => JSON.stringify([p.rarityTable, p.stats, p.multipliers, p.bonusDraws, p.limits, p.pity]);

/**
 * The Founder SYSTEM (lifecycle.js hooks). Per-run state lives in state.sys.founder only.
 *   init            sets state.profile = 'founder': rods (Founder crate luck), quests (questXp/questCash,
 *                   Daily Box sell), streak and buffs (Founder box odds and sell) read it and take the
 *                   Founder's values from founderProfile(). Refuses a run whose gate (simulate({ gate }))
 *                   is not opts.gate: the level gate is a profile rule (PARAMS.publicLevel.gate).
 *   outcome         founderCastOutcome(input): replaces F.castOutcome on every cast. The core credits
 *                   its final XP and value to ledger.xp.fishing / ledger.cash.fishing and its base XP to
 *                   ledger.publicXp.fishing (fishing profile bonus = xp.fishing - publicXp.fishing).
 *   outcomeCacheKey the profile (the outcome is a pure function of the input and the profile).
 *   beforeStep      the public tell: steps fished on a biome or rod tier above the PUBLIC level (possible
 *                   only under gate 'real'): hours, first step, first step on the top live biome, last.
 *   onCasts         base (public) fish value (the core ledgers the final cash only), Legendary+ caught
 *                   (with pity) and the fishing totals, in state.sys.founder.fishing.
 * No goals, no spend, no ledger source of its own, no daily minimum (no sessionDone).
 * @param {object} opts { gate: 'public' (default, PARAMS.publicLevel.gate) | 'real', profile: a
 *   profileWith() trial profile for the cast outcome (default founderProfile(); the other systems always
 *   read founderProfile()) }
 */
function system(opts = {}) {
	const gate = opts.gate || PARAMS.publicLevel.gate;
	if (!PARAMS.targets.gatingModes.includes(gate)) throw new Error(`${SYSTEM_NAME}: unknown gate ${gate} (${PARAMS.targets.gatingModes.join(' | ')})`);
	const own = (state) => state.sys[SYSTEM_NAME];
	return {
		name: SYSTEM_NAME,
		init(state, ctx) {
			if (ctx.gate !== gate) throw new Error(`${SYSTEM_NAME} system built for gate '${gate}' but the run gates on '${ctx.gate}': pass the same gate to simulate()`);
			const profile = opts.profile || founderProfile();
			state.profile = SYSTEM_NAME;
			state.sys[SYSTEM_NAME] = {
				gate, profile, key: `${SYSTEM_NAME}|${profileKey(profile)}`,
				fishing: { casts: 0, fish: 0, xp: 0, xpBase: 0, value: 0, valueBase: 0, legendaryPlus: 0 },
				tell: { hours: 0, firstAt: null, topBiomeFirstAt: null, lastAt: null },
			};
		},
		outcome(input, state) {
			return founderCastOutcome(input, own(state).profile);
		},
		outcomeCacheKey(input, state) {
			return own(state).key;
		},
		beforeStep(state, ctx, rates) {
			if (rates.blocked) return;
			const Lp = state.publicLevel;
			if (!(F.BIOME_LEVEL[rates.biome] > Lp || ctx.path[rates.tier].level > Lp)) return;
			const t = own(state).tell;
			const at = { hours: +state.h.toFixed(4), day: state.day + 1, publicLevel: Lp, realLevel: state.level, biome: rates.biome, tier: rates.tier };
			t.hours += ctx.stepH;
			if (!t.firstAt) t.firstAt = at;
			if (!t.topBiomeFirstAt && rates.biome === TOP_LIVE_BIOME) t.topBiomeFirstAt = at;
			t.lastAt = { ...at, hours: +(state.h + ctx.stepH).toFixed(4) };
		},
		onCasts(state, ctx, { casts, fish, rates }) {
			const f = own(state).fishing;
			f.casts += casts;
			f.fish += fish;
			f.xp += rates.xp;
			f.xpBase += rates.xpBase;
			f.value += rates.cash;
			f.valueBase += rates.cashBase;
			f.legendaryPlus += casts * (rates.outcome?.legendaryPlusPerCast || 0);
		},
	};
}

/** The system contract, for report().integration and the integrator's documentation. */
function systemDescription() {
	return {
		name: SYSTEM_NAME,
		options: { gate: '\'public\' (default: PARAMS.publicLevel.gate, framework decision P-FOUNDER-GATE) | \'real\'; must equal simulate({ gate }); integrate.run passes variant.gate', profile: 'trial profile for the cast outcome (default founderProfile())' },
		hooks: {
			init: 'state.profile = \'founder\'; state.sys.founder = { gate, profile, key, fishing, tell }; throws if the run\'s gate differs',
			outcome: 'founderCastOutcome(input): visible fish = normal chain (input.multiChance + stats.multiChance, or input.fishDist) + Founder bonus fish, capped at F.MULTI.maxFish; per draw = F.castOutcome with the Founder rarity table and gear + other systems\' + profile stats (clamped to STAT_CAPS), input sellMult / xpMult, fish / fishKey and rules; base = visible mean x per draw (public card, publicXp); final = base x profile xp / sell; durability per F.RULES.durability (or input.rules); an input.table is refused (the profile brings its own base table)',
			outcomeCacheKey: 'the profile (the outcome is a pure function of the input and the profile)',
			beforeStep: 'the public tell (gate \'real\' only): steps fished on a biome or tier above the public level; hours, first step, first step on the top live biome, last step',
			onCasts: 'base (public) fish value, Legendary+ caught (with pity) and fishing totals (state.sys.founder.fishing)',
		},
		ledger: {
			sources: 'none of its own: the core books its outcome under \'fishing\' (xp.fishing = final, publicXp.fishing = base, cash.fishing = final); base cash is state.sys.founder.fishing.valueBase (the core keeps no public cash ledger)',
			spend: 'none; no goals, no \'box\' events, no sessionDone',
		},
		reads: 'state.publicLevel / state.level (tell); ctx.path (tier levels)',
		readBy: 'rods (state.profile: Founder crate luck via founderCrates), quests (founderProfile().multipliers questXp / questCash; Daily Box fish at the Founder sell), streak and buffs (Founder box odds and sell)',
		integration: 'integrate.run({ variant: { founder: true, gate } }); integrate.run stops a Founder run when its PUBLIC level reaches the stop level',
	};
}

// ---------------------------------------------------------------------------------------------
// Retired private loop: the record of system()'s parity with it. The loop (lifecycle() on its own 1-minute
// steps with the 5b.1 placeholder purchase rule and level-scaled daily XP) and validateSystem() were
// deleted at the 5b.4 final migration; this is validateSystem()'s output at commit a83b5f0 (founder.js,
// lifecycle.js and the framework were unchanged from a83b5f0 until the deletion).
const RETIRED_LOOP_PARITY = deepFreeze({
	commit: 'a83b5f0',
	source: 'validateSystem() output at a83b5f0 (deleted with the private loop)',
	method: 'LC.simulate with system({ gate }) plus validation-only systems that reproduced the retired lifecycle()\'s placeholder rules (its purchase rule: F.PURCHASE.saveHours of Normal stage income x the Founder crate factor; its daily: F.DAILY.xpPerLevel x level, base at the public level, final at the gate level x questXp) and its XP-source basis, against the retired lifecycle(); every archetype under both gates, and Normal (the same baseline without the founder system). Compared step-exact: real and public milestone hours, XP by source at every milestone, the real level at each public milestone, tier upgrade hours, the public-tell points and hours, XP and money at the stop.',
	archetypes: ['casual', 'regular', 'active', 'grinder'],
	gates: ['public', 'real'],
	runs: { founder: 8, normal: 4 },
	milestonesCompared: 144,
	exactMilestones: 144,
	upgradesCompared: 52,
	exactUpgrades: 52,
	tellRuns: 8,
	tellPointsMatch: 8,
	stopTotalsCompared: 12,
	maxRelativeDifference: 0,
	tolerance: 0.005,
});

// The solved values before this migration (records, not inputs), for the doc's "what moved" table: the 5b.2
// design stage (provisional gear path, the retired loop; docs/economy/5b/founder.md at 991e09e) and the
// retired loop at 5b.4 on the rods path (solve() of this module as of a83b5f0, unchanged until this
// migration, run on framework 5b.4).
const EARLIER_SOLVES = deepFreeze([
	{ id: '5b.2', label: '5b.2 design stage (provisional gear path, retired loop)', source: 'docs/economy/5b/founder.md at 991e09e', xp: 45, sell: 50, luck: 0.95, durabilityEfficiency: 0.85, binding: { xp: 'M2: casual, public gate, ×40.7', sell: 'M4: T1, ×48.4', luck: 'M5: T5, +0.931', durabilityEfficiency: 'M6: T1, 0.846' } },
	{ id: '5b.4-loop', label: '5b.4, retired loop (rods path)', source: 'solve() of founder.js as of a83b5f0 (unchanged until this migration) on framework 5b.4', xp: 45, sell: 55, luck: 0.6, durabilityEfficiency: 0.85, binding: { xp: 'M2: casual, public gate, ×44.77', sell: 'M4: T1, ×50.86', luck: 'M5: T5, +0.570', durabilityEfficiency: 'M6: T1, 0.843' } },
]);

// ---------------------------------------------------------------------------------------------
// INTEGRATED lifecycle: every lifecycle number this module reports is an integrate.run() of the reference
// core loop (rods, world, quests, streak, buffs); the Founder adds system() through variant.founder with its
// gate. Normal = the same loop without it.
const HORIZONS = deepFreeze({
	// integrate.run's default stop: Normal at the maximum level, the Founder when its PUBLIC level reaches it.
	lifecycle: {},
	// Until the REAL level reaches the maximum level (the solver's time-to-level target, the counterfactual).
	real: { stopOn: 'real', stopAtLevel: F.LIFECYCLE.maxLevel },
	// Thirty calendar days whatever the level (today's simulation reports day 30).
	day30: { stopAtLevel: null, days: 30, checkpoints: [30] },
});
// XP ledger sources grouped as R2 groups them (r2.js); anything unlisted lands in 'other'.
const XP_GROUPS = { fishing: ['fishing'], quests: ['story', 'repeatable'], daily: ['daily', 'weekly'], buffs: ['buff'] };
const groupOf = (src) => Object.keys(XP_GROUPS).find((g) => XP_GROUPS[g].includes(src)) || 'other';

const runMemo = new Map();
/**
 * One integrated run: the reference loop, plus the founder system with cast profile `profile` (null =
 * Normal) under `gate`, to `horizon` (HORIZONS). Memoised unless cache is false (the solver's trials).
 */
function runIntegrated(archetype, { profile = null, gate = PARAMS.publicLevel.gate, horizon = 'lifecycle', cache = true } = {}) {
	if (!HORIZONS[horizon]) throw new Error(`${SYSTEM_NAME}: unknown horizon ${horizon} (${Object.keys(HORIZONS).join(' | ')})`);
	const founder = profile !== null;
	const key = `${archetype}|${founder ? `${gate}|${profileKey(profile)}` : 'normal'}|${horizon}`;
	if (cache && runMemo.has(key)) return runMemo.get(key);
	const r = INTEGRATE().run({
		archetype,
		variant: founder ? { founder: true, gate } : {},
		...(founder ? { systemOpts: { founder: { profile } } } : {}),
		...HORIZONS[horizon],
	});
	if (cache) runMemo.set(key, r);
	return r;
}

/** Account and public XP by source group from a core ledger snapshot. */
function xpByGroup(ledger) {
	const account = { fishing: 0, quests: 0, daily: 0, buffs: 0, other: 0 };
	const pub = { ...account };
	for (const [src, v] of Object.entries(ledger.xp)) account[groupOf(src)] += v;
	for (const [src, v] of Object.entries(ledger.publicXp)) pub[groupOf(src)] += v;
	return { account, public: pub, otherSources: Object.keys(ledger.xp).filter((s) => groupOf(s) === 'other') };
}

/**
 * One INTEGRATED lifecycle (integrate.run; never a private loop).
 * @param archetype an F.ARCHETYPES name (or F.MINIMUM_DAILY.name)
 * @param opts { profile: null = Normal (the reference loop only) | a Founder cast profile (founderProfile() or a
 *   profileWith() trial; quests, streak and buffs always read founderProfile()), gating: 'public' | 'real' (the
 *   Founder's gate), horizon: 'lifecycle' (default stop) | 'real' (until real Lv max) | 'day30' }
 * @returns { archetype, gating, model, systems, real: { [L]: { hours, day } }, public: { ... }, upgrades:
 *   { [tier]: hours }, sourcesAtRealMilestone, sourcesAtPublicMilestone (+ realLevel), end, tell, fishing,
 *   day30 (timeline row), ledger (totals) }
 */
function lifecycle(archetype, { profile = null, gating = PARAMS.publicLevel.gate, horizon = 'lifecycle' } = {}) {
	const r = runIntegrated(archetype, { profile, gate: gating, horizon });
	const founder = profile !== null;
	const at = (m) => Object.fromEntries(numericKeys(m).map((L) => [L, { hours: m[L].hours, day: m[L].day }]));
	const tiers = r.purchases.filter((p) => /^rods:T\d+$/.test(p.id));
	return {
		archetype, gating: founder ? gating : 'n/a', horizon,
		model: `integrated (${r.systems.join(', ')})`, systems: r.systems,
		real: at(r.milestones),
		public: at(r.publicMilestones),
		upgrades: Object.fromEntries(tiers.map((p) => [Number(p.id.replace('rods:T', '')), p.hours])),
		sourcesAtRealMilestone: Object.fromEntries(numericKeys(r.milestones).map((L) => [L, xpByGroup(r.milestones[L].ledger)])),
		sourcesAtPublicMilestone: Object.fromEntries(numericKeys(r.publicMilestones).map((L) => {
			const m = r.publicMilestones[L];
			return [L, { ...xpByGroup(m.ledger), realLevel: F.levelForXp(sum(Object.values(m.ledger.xp))) }];
		})),
		end: { hours: r.hours, days: r.days, realLevel: r.final.level, publicLevel: r.final.publicLevel, realXp: Math.round(r.final.xp), publicXp: Math.round(r.final.publicXp), money: Math.round(r.final.money), tier: r.final.tier },
		tell: founder ? r.sys[SYSTEM_NAME].tell : null,
		fishing: founder ? r.sys[SYSTEM_NAME].fishing : null,
		day30: r.timeline.find((x) => x.day === 30) || null,
		ledger: { xp: { ...r.ledger.xp }, publicXp: { ...r.ledger.publicXp }, cash: { ...r.ledger.cash } },
	};
}

// ---------------------------------------------------------------------------------------------
// Solver: private durability efficiency -> luck -> sell -> xp, each the smallest value meeting every target
// x margin, rounded up. The xp step's time-to-level target (M2) runs integrated lifecycles.
let solveMemo = null;
// While solve() runs its integrated lifecycles, quests, streak and buffs read founderProfile() (quest
// multipliers, sell multiplier, gacha stats). They get the profile solved so far: identical to the final
// one except multipliers.xp, which is bound to the solved value once solve() finishes and throws if
// anything reads it before (only the founder system's own casts depend on it, and they use the trial).
let solving = null;
function provisionalProfile(p) {
	const multipliers = { ...p.multipliers };
	Object.defineProperty(multipliers, 'xp', {
		enumerable: true,
		get() {
			if (!solveMemo) throw new Error(`${SYSTEM_NAME}: multipliers.xp was read while solve() is still solving it (only the founder system's own casts may depend on it)`);
			return solveMemo.xp;
		},
	});
	return { ...p, multipliers };
}

/** The smallest x >= lo with ok(x) (ok monotone): doubling bracket from XP_SEARCH.start, then bisection. */
function smallestPassing(ok, lo = 1) {
	if (ok(lo)) return lo;
	let hi = XP_SEARCH.start;
	while (!ok(hi)) {
		lo = hi;
		hi *= 2;
		if (hi > XP_SEARCH.max) throw new Error(`${SYSTEM_NAME}: no XP multiplier up to ${XP_SEARCH.max} meets the time-to-level target`);
	}
	return bisect(ok, lo, hi, XP_SEARCH.steps);
}

function solve() {
	if (solveMemo) return solveMemo;
	const path = F.gearPath();
	const margin = PARAMS.targets.margin;
	const T = today();
	const tiers = path.map((t) => t.tier);
	const targetOf = (t, pick) => maxOf(PARAMS.targets.todayRodOfTier[t].map((rod) => pick(T.byRod[rod])));

	// 0. Durability efficiency: rod life in hours of play, Founder / Normal, >= today's on every crafted
	//    tier (the Old Rod is unbreakable under the rods design). Never below today's value.
	const effCap = STAT_CAPS.durabilityEfficiency.max;
	const lifeRatio = (t, eff) => {
		const fo = founderOutcome({ tier: t }, { profile: profileWith({ durabilityEfficiency: eff }) });
		return (fo.normal.durabilityPerCast * fo.normal.casts) / (fo.perCast.durability * fo.hourly.casts);
	};
	const crafted = tiers.filter((t) => t > 0);
	const lifeTarget = Object.fromEntries(crafted.map((t) => [t, targetOf(t, (r) => r.rodLifeRatio)]));
	const effNeed = Object.fromEntries(crafted.map((t) => [t, lifeRatio(t, TODAY.stats.durabilityEfficiency) >= lifeTarget[t] * margin ? TODAY.stats.durabilityEfficiency : bisect((e) => lifeRatio(t, e) >= lifeTarget[t] * margin, TODAY.stats.durabilityEfficiency, effCap)]));
	const durabilityEfficiency = round(Math.min(effCap, niceUp(maxOf(Object.values(effNeed)), PARAMS.rounding.efficiencyStep)), 4);
	const withEff = (x) => profileWith({ durabilityEfficiency, ...x });

	// 1. Private luck: Legendary+ per hour ratio to Normal at equal gear (home biome) >= today's.
	const luckTarget = Object.fromEntries(tiers.map((t) => [t, targetOf(t, (r) => r.legendaryPlusPerHour.ratio)]));
	const luckRatio = (t, luck) => founderOutcome({ tier: t }, { profile: withEff({ luck }) }).ratio.legendaryPlus;
	const luckNeed = Object.fromEntries(tiers.map((t) => [t, luckRatio(t, 0) >= luckTarget[t] * margin ? 0 : bisect((x) => luckRatio(t, x) >= luckTarget[t] * margin, 0, 20)]));
	let luck = niceUp(maxOf(Object.values(luckNeed)), PARAMS.rounding.luckStep);
	// Plausibility cap: at most maxLegendaryCardShare of public cards show a Legendary+ at any tier.
	const cardShare = (x) => maxOf(tiers.map((t) => founderOutcome({ tier: t }, { profile: withEff({ luck: x }) }).legendaryCardShare));
	const cap = PARAMS.plausibility.maxLegendaryCardShare;
	let luckCapped = false;
	if (cardShare(luck) > cap) {
		luck = Math.floor(bisect((x) => cardShare(x) > cap, 0, luck) / PARAMS.rounding.luckStep) * PARAMS.rounding.luckStep;
		luckCapped = true;
	}
	luck = round(luck, 4);

	// 2. Sell: (a) $/h ratio to Normal at equal gear, every tier x biome >= today's ratio (same biome);
	//    (b) time to afford the tier set bought at today's purchase milestones <= today's.
	const base = withEff({ luck });
	const cashNeed = [];
	const xpRatioNeed = [];
	for (const t of tiers) {
		for (const biome of F.LIVE_BIOMES) {
			const fo = founderOutcome({ tier: t, biome }, { profile: base });
			const cashTarget = targetOf(t, (r) => r.biomes[biome].cashRatio);
			const xpTarget = targetOf(t, (r) => r.biomes[biome].xpRatio);
			cashNeed.push({ tier: t, biome, target: cashTarget, baseRatio: fo.ratio.cashBase, need: (cashTarget * margin) / fo.ratio.cashBase });
			xpRatioNeed.push({ tier: t, biome, target: xpTarget, baseRatio: fo.ratio.xpBase, need: (xpTarget * margin) / fo.ratio.xpBase });
		}
	}
	const afford = [];
	for (const [t, stage] of Object.entries(PARAMS.targets.todayPurchaseOfTier)) {
		const tier = path[Number(t)];
		const st = SIMULATED.stages[stage];
		const prev = SIMULATED.stages[PARAMS.targets.todayStageBefore[stage]];
		const crate = BOX_CATALOG.find((b) => b.name === 'Fishing Crate');
		const todayCost = st.crates * crate.price;
		const biome = F.biomeAt(st.level);
		const todayIncome = todayRates(prev.founderMeasured || prev.measured, biome, 'founder').cashPerHour;
		const todayHours = todayCost / todayIncome;
		const newCost = founderCrates(Number(t)).founder.expectedCost;
		const newBaseIncome = founderOutcome({ tier: path[Number(t) - 1], biome: F.biomeAt(tier.level) }, { profile: base }).hourly.valueBase;
		afford.push({ tier: Number(t), todayStage: stage, todayCost, todayIncomePerHour: todayIncome, todayMinutes: todayHours * 60, newCost, newBaseIncomePerHour: newBaseIncome, need: (newCost / (newBaseIncome * todayHours)) * margin });
	}
	const bindingCash = [...cashNeed].sort((a, b) => b.need - a.need)[0];
	const bindingAfford = [...afford].sort((a, b) => b.need - a.need)[0];
	const sell = niceMultiplier(Math.max(bindingCash.need, bindingAfford.need));

	// 3. XP: (a) XP/h ratio to Normal at equal gear >= today's (every tier x biome);
	//    (b) hours of play to every real-level milestone <= today's Founder, every archetype, both gate
	//    options, on the INTEGRATED model: integrate.run with the reference loop and the founder system
	//    casting with the trial profile, until the real level reaches the maximum level.
	const bindingXpRatio = [...xpRatioNeed].sort((a, b) => b.need - a.need)[0];
	const timeNeed = [];
	solving = provisionalProfile(withEff({ luck, sell }));
	try {
		for (const a of Object.keys(F.ARCHETYPES)) {
			const target = T.lifecycles[a]?.founderHours;
			if (!target) continue;
			for (const gating of PARAMS.targets.gatingModes) {
				const ok = (m) => {
					const hours = LC.milestoneHours(runIntegrated(a, { profile: withEff({ luck, sell, xp: m }), gate: gating, horizon: 'real', cache: false }));
					return F.LIFECYCLE.milestones.every((L) => target[L] == null || (hours[L] != null && hours[L] <= target[L]));
				};
				const raw = smallestPassing(ok);
				timeNeed.push({ archetype: a, gating, need: raw * margin, raw });
			}
		}
	}
	finally {
		solving = null;
	}
	const bindingTime = [...timeNeed].sort((a, b) => b.need - a.need)[0];
	const xp = niceMultiplier(Math.max(bindingXpRatio.need, bindingTime.need));

	solveMemo = {
		durabilityEfficiency, effNeed, lifeTarget, luck, luckCapped, luckNeed, luckTarget, sell, xp,
		// What each value would be from one target family alone (the doc's "without M4" / "without M2").
		sellFromCashRatioOnly: niceMultiplier(bindingCash.need), xpFromRatioOnly: niceMultiplier(bindingXpRatio.need),
		binding: { durability: Object.entries(effNeed).sort((a, b) => b[1] - a[1])[0], luck: Object.entries(luckNeed).sort((a, b) => b[1] - a[1])[0], cash: bindingCash, afford: bindingAfford, xpRatio: bindingXpRatio, xpTime: bindingTime },
		cashNeed, xpRatioNeed, afford, timeNeed,
		timeModel: `integrate.run (${INTEGRATE().REFERENCE.join(', ')} + founder), until the real level reaches the maximum level`,
	};
	return solveMemo;
}

/** The proposed Founder profile (for balance.js PROFILES.founder at implementation). */
function founderProfile() {
	if (solving) return solving;
	const s = solve();
	return profileWith({ luck: s.luck, xp: s.xp, sell: s.sell, durabilityEfficiency: s.durabilityEfficiency });
}

// ---------------------------------------------------------------------------------------------
// Public level (F1). SHIPPED in production as a standalone correctness/privacy hotfix (commit 14e27f1 on main,
// cherry-picked here as 70a0eb7): src/engine/publicLevel.js. What stays proposed is listed in DECISIONS.
const F1_COMMITS = deepFreeze({ main: '14e27f1', branch: '70a0eb7', breakdown: 'a2ab9a8' });
const SRC = nodePath.join(__dirname, '../../../src');
const srcText = (rel) => {
	try {
		return fs.readFileSync(nodePath.join(SRC, rel), 'utf8');
	}
	catch {
		return '';
	}
};
const GATE_FILES = ['commands/slash/Fish/biome.js', 'commands/slash/User/startQuest.js', 'class/Quest.js', 'components/buttons/buy-rod.js', 'components/buttons/buy-bait.js', 'components/buttons/buy-other.js'];

/**
 * F1 status read from src/ at report time (evidence, so the doc cannot claim a surface is fixed when the
 * code says otherwise): each surface, the level or amount it shows, and whether that is shipped, proposed
 * or an open public tell.
 */
function publicLevelStatus() {
	const fish = srcText('commands/slash/Fish/fish.js');
	const profile = srcText('commands/slash/User/profile.js');
	const inventory = srcText('commands/slash/User/inventory.js');
	const balance = srcText('commands/slash/Economy/balance.js');
	const pagination = srcText('buttonPagination.js');
	const presentation = srcText('engine/presentation.js');
	const cast = srcText('engine/cast.js');
	const dev = srcText('engine/dev.js');
	const migrations = srcText('bootstrap/migrations.js');
	const schema = srcText('schemas/UserSchema.js');
	const publicDefer = /deferReply\(\)/.test(pagination);
	const evidence = {
		castWritesPublicXp: /publicXp:\s*publicXpOfResult\(result\)/.test(cast),
		castPublicLevel: /public:\s*\{\s*xpBefore/.test(cast),
		fishCardPublicLevelUp: /result\.level\.public\.levelUp/.test(fish),
		profilePublicLevel: /getPublicLevel\(\)/.test(profile),
		inventoryPublicLevel: /getPublicLevel\(\)/.test(inventory),
		fishingStatsBothLevels: /Public level/.test(presentation) && /level:\s*\{\s*real:/.test(cast),
		devGrantsMoveBoth: /publicXp:\s*newPublic/.test(dev),
		migration: /migratePublicXp/.test(migrations),
		schemaPublicXp: /publicXp:\s*\{/.test(schema),
		schemaPublicLevel: /publicLevel:\s*\{/.test(schema),
		profileFounderBadgeInPublicReply: /👑 Founder/.test(profile) && publicDefer,
		inventoryRealBalance: /Balance:\*\*\s*\$\$\{inventory\.money/.test(inventory) && publicDefer,
		inventoryFinalValue: /Inventory value/.test(inventory) && /f\.value \* f\.count/.test(srcText('class/User.js')),
		balanceCommandPublic: /deferReply\(\)/.test(balance) && /getMoney\(\)/.test(balance),
		gatesReadRealLevel: GATE_FILES.filter((f) => /getLevel\(\)/.test(srcText(f)) && !/getPublicLevel|getGateLevel/.test(srcText(f))),
	};
	const shipped = (ok) => (ok ? `shipped (${F1_COMMITS.main})` : '**not found in src/**');
	const surfaces = [
		{ surface: '`/fish` catch card: "⭐ Level up!"', shows: 'public level (`result.level.public`)', status: shipped(evidence.fishCardPublicLevelUp && evidence.castPublicLevel), where: 'src/commands/slash/Fish/fish.js, src/engine/cast.js' },
		{ surface: '`/profile` (public reply)', shows: 'public level and progress', status: shipped(evidence.profilePublicLevel), where: 'src/commands/slash/User/profile.js, User.getPublicLevel()' },
		{ surface: '`/inventory` level line (public reply)', shows: 'public level and progress', status: shipped(evidence.inventoryPublicLevel), where: 'src/commands/slash/User/inventory.js' },
		{ surface: '`/fishing-stats` (ephemeral)', shows: 'real level and public level', status: shipped(evidence.fishingStatsBothLevels), where: 'src/engine/presentation.js privateStatsFields, cast.fishingStats' },
		{ surface: 'Catch card XP and quest lines', shows: 'base rewards (`rewards.*.base`)', status: `shipped (${F1_COMMITS.breakdown})`, where: 'src/engine/cast.js rewardBreakdown' },
		{ surface: 'Gameplay gates: biomes, quests, shop, rod parts, permits', shows: evidence.gatesReadRealLevel.length ? 'the REAL level (`getLevel()`)' : 'no real-level gate found', status: 'proposed: the public level (framework `P-FOUNDER-GATE`)', where: evidence.gatesReadRealLevel.map((f) => `src/${f}`).join(', ') },
		{ surface: '`/inventory` "Balance" and "Inventory value" (public reply)', shows: evidence.inventoryRealBalance || evidence.inventoryFinalValue ? 'real money and final (private-multiplied) fish values' : 'no real-money line found', status: evidence.inventoryRealBalance || evidence.inventoryFinalValue ? '**open public tell** (`P-FOUNDER-WALLET`)' : 'closed', where: 'src/commands/slash/User/inventory.js, User.getInventoryValue()' },
		{ surface: '`/balance` (public reply)', shows: evidence.balanceCommandPublic ? 'real money' : 'no public money reply found', status: evidence.balanceCommandPublic ? '**open public tell** (`P-FOUNDER-WALLET`)' : 'closed', where: 'src/commands/slash/Economy/balance.js' },
		{ surface: '`/profile` title when the Founder views its own profile (public reply)', shows: evidence.profileFounderBadgeInPublicReply ? '"👑 Founder"' : 'no badge', status: evidence.profileFounderBadgeInPublicReply ? '**open public tell (F0, fix first)**' : 'closed', where: 'src/commands/slash/User/profile.js title, src/buttonPagination.js deferReply()' },
		{ surface: 'Any future level leaderboard', shows: 'public level, competitive (Normal-profile) accounts only', status: 'proposed (`P-FOUNDER-SURFACES`)', where: 'none yet' },
	];
	return { commits: F1_COMMITS, evidence, surfaces, storedPublicLevel: evidence.schemaPublicLevel };
}

// The public XP definition, shipped vs model (component by component).
const PUBLIC_XP_COMPONENTS = deepFreeze([
	{ component: 'Catch XP (per-fish roll x rarity weight), every visible fish including Founder bonus fish', shipped: 'in: `catchXpWithoutProfile`', model: 'in: `publicXp.fishing` (founder outcome `xpBasePerCast`)' },
	{ component: 'Gear and bait XP bonus', shipped: 'in: `xp.withoutProfile` (gear)', model: 'in: castOutcome `stats.xpBonus`' },
	{ component: 'Active buffs (Double XP)', shipped: 'in: `xp.withoutProfile` (buffs)', model: 'in: `publicXp.buff` (the buff bonus on base XP; `P-BUFFS-PUBLIC`)' },
	{ component: 'Event XP multiplier', shipped: 'in: `xp.withoutProfile` (event)', model: 'none modelled (`P-EVENTS`: no XP events)' },
	{ component: 'Quest XP, base (quest XP x event)', shipped: 'in: `reward.xp.base`', model: 'in: `publicXp.daily` / `weekly` / `repeatable` / `story` (quests system)' },
	{ component: 'Founder catch XP multiplier', shipped: 'excluded: `profileBonus`', model: 'excluded: `xp.fishing` = `publicXp.fishing` x profile xp' },
	{ component: 'Founder quest XP multiplier (`questXp`)', shipped: 'excluded: `profileBonus`', model: 'excluded: quest `xp` = `publicXp` x questXp' },
	{ component: 'Streak', shipped: 'no XP', model: 'no XP (`P-STREAK-NO-CASH-XP`)' },
	{ component: 'Developer XP grants', shipped: 'move `publicXp` with `xp`, clamped to [0, xp], audited', model: 'not modelled (no grants in a lifecycle)' },
	{ component: 'Public level', shipped: 'derived on read: `levelForXp(min(publicXp, xp))`; no stored field', model: 'core `publicLevel` = max(previous, curve(publicXp)): identical while XP only rises on a fixed curve' },
]);

let definitionMemo = null;
/**
 * The model's public XP against the shipped definition, on the integrated ledgers of the reference
 * archetype: for the Founder every XP source's account XP must equal its public XP times exactly the
 * profile multiplier that applies to it (xp for fishing and buffs, questXp for quest sources), and for
 * Normal public XP must equal XP for every source (the shipped invariant publicXp === xp).
 */
function publicXpDefinition() {
	if (definitionMemo) return definitionMemo;
	const prof = founderProfile();
	const ref = F.REFERENCE_ARCHETYPE;
	const gate = PARAMS.publicLevel.gate;
	const normal = runIntegrated(ref);
	const founder = runIntegrated(ref, { profile: prof, gate });
	const questSources = QUESTS().QUEST_SOURCES;
	const buffSources = BUFFS().LEDGER_SOURCES.xp;
	const multiplierOf = (src) => (src === 'fishing' || buffSources.includes(src) ? prof.multipliers.xp : questSources.includes(src) ? prof.multipliers.questXp : null);
	const close = (a, b) => Math.abs(a - b) <= 1e-9 * Math.max(Math.abs(a), Math.abs(b), 1);
	const sources = Object.keys(founder.ledger.xp).map((src) => {
		const xp = founder.ledger.xp[src];
		const pub = founder.ledger.publicXp[src] || 0;
		const expected = multiplierOf(src);
		return { source: src, group: groupOf(src), xp: Math.round(xp), publicXp: Math.round(pub), multiplier: pub > 0 ? xp / pub : null, expected, matches: expected !== null && close(xp, pub * expected) };
	});
	const normalPublicEqualsXp = Object.keys(normal.ledger.xp).every((src) => close(normal.ledger.xp[src], normal.ledger.publicXp[src] || 0));
	definitionMemo = {
		archetype: ref, gate, components: PUBLIC_XP_COMPONENTS, sources, normalPublicEqualsXp,
		founderExcludesProfileOnly: sources.every((s) => s.matches),
		matchesShipped: normalPublicEqualsXp && sources.every((s) => s.matches),
		differences: [
			'Rounding: the engine floors XP per cast (integers); the model is continuous.',
			'Public level: the engine stores no public level (derived from publicXp on read); the core keeps publicLevel = max(previous, curve(publicXp)). They differ only when the curve changes (P-FOUNDER-PUBLIC-LEVEL).',
			'Gate \'real\' (live today): quest rewards are scaled at the real level in both, and their base enters publicXp in both.',
		],
	};
	return definitionMemo;
}

// ---------------------------------------------------------------------------------------------
// PROPOSED decisions (status 'proposed' only: only the user approves). get() reads what the model runs;
// decisions.verify() checks it against `expected`. The framework-level entries this design relies on live in
// decisions.js: P-FOUNDER-GATE (which level gates gameplay), P-DURABILITY (stochastic durability rule,
// from this design's D5), P-LUCKY (Lucky items pinned, extended to the Founder); the streak design's
// P-STREAK-FOUNDER and the buffs design's P-BUFFS-PUBLIC cover the Founder's boxes and buffs.
const solvedRow = (id) => {
	const s = solve();
	const b = s.binding;
	const m = PARAMS.targets.margin;
	return {
		xp: `×${s.xp}: the binding need rounded up to a ×${PARAMS.rounding.largeStep} step. Binding: M2 time to level on the integrated model (${b.xpTime.archetype}, ${b.xpTime.gating} gate: ×${round(b.xpTime.raw, 2)} × margin ${m} = ×${round(b.xpTime.need, 2)}); M1 (XP/h ratio at equal gear) alone needs ×${round(b.xpRatio.need, 2)}`,
		sell: `×${s.sell}: the binding need rounded up to a ×${PARAMS.rounding.largeStep} step. Binding: M4 time to afford (T${b.afford.tier}, margin ${m} included: ×${round(b.afford.need, 2)}); M3 ($/h ratio at equal gear) alone needs ×${round(b.cash.need, 2)}`,
		luck: `+${s.luck} Luck: the binding need rounded up to a ${PARAMS.rounding.luckStep} step. Binding: M5 (Legendary+ per hour ratio at equal gear ≥ today's × margin ${m}) at T${b.luck[0]}: +${round(b.luck[1], 3)}${s.luckCapped ? '; capped by plausibility' : ''}. Cap: at most ${round(PARAMS.plausibility.maxLegendaryCardShare * 100, 1)}% of public cards show a Legendary+`,
		durabilityEfficiency: `${s.durabilityEfficiency}: the binding need rounded up to a ${PARAMS.rounding.efficiencyStep} step. Binding: M6 (rod life in hours, Founder ÷ Normal ≥ today's × margin ${m}) at T${b.durability[0]}: ${round(b.durability[1], 3)}; never below today's, never above STAT_CAPS; needs P-DURABILITY`,
	}[id];
};
const DECISIONS = [
	{
		id: 'P-FOUNDER-VISIBLE', status: 'proposed',
		title: 'Founder visible catch: today\'s bonus-fish distribution added to the rod\'s normal multi-catch roll, the total capped at the normal maximum; one fish per draw',
		get modelled() {
			return `bonus fish ${Object.entries(PARAMS.visible.bonusFish).map(([n, p]) => `${n}: ${p}`).join(', ')}; limits maxDraws ${F.MULTI.maxFish} (= F.MULTI.maxFish), maxPerDraw 1 (today ${TODAY.limits.maxDraws} / ${TODAY.limits.maxPerDraw})`;
		},
		alternatives: ['today\'s limits (tens of fish on one card: a public tell)', 'a smaller bonus (fewer visible fish; more private compensation)', 'no cap (casts a normal player can never land)'],
		source: 'founder design', why: 'every Founder card is one a normal player can also land (approved direction A-FOUNDER-VISIBLE); the Old Rod card is today\'s (Visible catch)',
		get: () => {
			const p = founderProfile();
			return { bonusFish: PARAMS.visible.bonusFish, maxDraws: p.limits.maxDraws, maxPerDraw: p.limits.maxPerDraw };
		},
		expected: { bonusFish: { 0: 0.1, 1: 0.25, 2: 0.3, 3: 0.25, 4: 0.1 }, maxDraws: 5, maxPerDraw: 1 },
	},
	{
		id: 'P-FOUNDER-TARGETS', status: 'proposed',
		title: 'What "preserved" means: six targets (M1-M6) met at today\'s value x a margin on today\'s rods mapped to the new tiers, under both gate options; solved values rounded up',
		get modelled() {
			return `margin ×${PARAMS.targets.margin}; tier map ${Object.entries(PARAMS.targets.todayRodOfTier).map(([t, r]) => `${t === '0' ? 'Old Rod' : `T${t}`} = ${r.join(' / ')}`).join('; ')}; gates ${PARAMS.targets.gatingModes.join(' and ')}; rounding ×${PARAMS.rounding.smallStep} below ×${PARAMS.rounding.largeFrom}, ×${PARAMS.rounding.largeStep} above, luck and efficiency ${PARAMS.rounding.luckStep}`;
		},
		alternatives: ['no margin (exactly today\'s values)', 'ratio targets only (drops M2 time-to-level and M4 time-to-afford: much smaller multipliers, a slower Founder than today)'],
		source: 'founder design', why: 'the approved direction keeps the Founder\'s effective power "absurd"; the steeper curve and the repriced gear are compensated like the lost visible volume (Targets)',
		get: () => ({ margin: PARAMS.targets.margin, todayRodOfTier: PARAMS.targets.todayRodOfTier, todayPurchaseOfTier: PARAMS.targets.todayPurchaseOfTier, gatingModes: PARAMS.targets.gatingModes, rounding: PARAMS.rounding }),
		expected: {
			margin: 1.1,
			todayRodOfTier: { 0: ['Old Rod'], 1: ['Custom (Uncommon parts)'], 2: ['Custom (Rare parts)'], 3: ['Custom (Rare parts)', 'Custom (Legendary parts)'], 4: ['Custom (Legendary parts)'], 5: ['Custom (Legendary parts)'] },
			todayPurchaseOfTier: { 1: 'c20', 2: 'c30' },
			gatingModes: ['public', 'real'],
			rounding: { smallStep: 0.5, largeStep: 5, largeFrom: 10, luckStep: 0.05, efficiencyStep: 0.05 },
		},
	},
	{
		id: 'P-FOUNDER-XP', status: 'proposed',
		title: 'Private XP multiplier (solved; public output shows base XP)',
		get modelled() {
			return solvedRow('xp');
		},
		alternatives: ['today\'s ×5 (a regular Founder reaches Lv 50 hours later than today: Counterfactual)', 'the M1 ratio-only value (drops the time-to-level target)'],
		source: 'founder design (solve())', why: 'the steeper curve and the capped visible volume both slow the Founder; the approved time-to-level target absorbs both (Targets; Hours to each level)',
		get: () => founderProfile().multipliers.xp, expected: 45,
	},
	{
		id: 'P-FOUNDER-SELL', status: 'proposed',
		title: 'Private sell multiplier (solved; baked into each fish\'s stored value; valueBase stays public)',
		get modelled() {
			return solvedRow('sell');
		},
		alternatives: ['today\'s ×10', 'the M3 ratio-only value (drops the time-to-afford target: repriced gear takes the Founder longer to buy than today)'],
		source: 'founder design (solve())', why: 'gear was repriced upwards like the curve was steepened; the Founder is compensated for both (Targets; Time to afford)',
		get: () => founderProfile().multipliers.sell, expected: 55,
	},
	{
		id: 'P-FOUNDER-LUCK', status: 'proposed',
		title: 'Private Luck on the Founder profile (solved), capped so at most a set share of public cards show a Legendary+',
		get modelled() {
			return solvedRow('luck');
		},
		alternatives: ['no private luck (Legendary+ per hour below today\'s ratio at some tiers: Private luck)'],
		source: 'founder design D2 (solve())', why: 'restores Legendary+ per hour at equal gear to today\'s ratio at every tier while fewer fish are visible; the card-share cap keeps it plausibly lucky (Private luck)',
		get: () => ({ luck: founderProfile().stats.luck ?? 0, maxLegendaryCardShare: PARAMS.plausibility.maxLegendaryCardShare }),
		expected: { luck: 0.6, maxLegendaryCardShare: 1 / 3 },
	},
	{
		id: 'P-FOUNDER-DURABILITY-EFF', status: 'proposed',
		title: 'Founder durability efficiency (solved), under the stochastic durability rule',
		get modelled() {
			return solvedRow('durabilityEfficiency');
		},
		alternatives: ['today\'s efficiency under today\'s max(1, ceil) rule (Founder rods wear out faster per hour than a normal player\'s: Durability)'],
		source: 'founder design D5 (solve())', why: 'the Founder casts faster, so under today\'s rule its rods would last fewer hours than Normal\'s; this keeps rod life at or above today\'s ratio (Durability)',
		get: () => founderProfile().stats.durabilityEfficiency, expected: 0.85,
	},
	{
		id: 'P-FOUNDER-KEPT', status: 'proposed',
		title: 'Kept from today\'s profile: rarity table, fishing speed, pity, gacha stats and gacha pity; still non-competitive',
		modelled: 'read from src/engine/balance.js PROFILES.founder, never copied',
		alternatives: ['reduce speed or table (would need larger private multipliers)', 'raise them (visible, a tell)'],
		source: 'founder design', why: 'per-fish rarity and cadence are part of today\'s Founder feel; the quests, streak and buffs designs assume them (Current → proposed)',
		get: () => {
			const p = founderProfile();
			return { rarityTable: same(p.rarityTable, TODAY.rarityTable), fishingSpeed: p.stats.fishingSpeed === TODAY.stats.fishingSpeed, pity: same(p.pity, TODAY.pity), gachaStats: same(p.gacha.stats, TODAY.gacha.stats), gachaPity: same(p.gacha.pity, TODAY.gacha.pity), competitiveEligible: p.competitiveEligible };
		},
		expected: { rarityTable: true, fishingSpeed: true, pity: true, gachaStats: true, gachaPity: true, competitiveEligible: false },
	},
	{
		id: 'P-FOUNDER-QUEST-MULT', status: 'proposed',
		title: 'Founder quest multipliers (questXp / questCash) kept at today\'s values',
		get modelled() {
			const p = founderProfile();
			return `questXp ×${p.multipliers.questXp}, questCash ×${p.multipliers.questCash} (today ×${TODAY.multipliers.questXp} / ×${TODAY.multipliers.questCash}); base quest XP enters publicXp`;
		},
		alternatives: ['scale them with the catch multipliers', 'drop them (quests pay the Founder like anyone)'],
		source: 'founder design; the quests design reads them (quests.md Founder section)', why: 'the per-completion ratio is unchanged and quest completions are capped per day by the quests design; quest XP is a small share of Founder XP (XP sources)',
		get: () => {
			const p = founderProfile();
			return { questXp: p.multipliers.questXp, questCash: p.multipliers.questCash };
		},
		expected: { questXp: 5, questCash: 5 },
	},
	{
		id: 'P-FOUNDER-PUBLIC-LEVEL', status: 'proposed',
		title: 'Public level fields: keep the shipped publicXp (base rewards only) as the Phase 5B rule; at the curve change the public level follows the real level\'s rule (framework P-CURVE-EXISTING), so under its no-demotion freeze a stored publicLevel floor is added',
		modelled: 'publicXp: shipped (14e27f1): base catch XP (gear, bait, buffs, events) + base quest XP, never a profile bonus. publicLevel: proposed stored field written at the curve change; public level = max(stored publicLevel, curve(publicXp)). The core tracks exactly that rule (lifecycles start new players, so the floor never binds in the model)',
		alternatives: ['derive the public level on read only (as shipped): under the freeze, a member\'s public level would drop at the curve change while the real level does not (public levels demoted, and real and public levels diverge for normal players)', 'under P-CURVE-EXISTING\'s rescale alternative: rescale publicXp with xp and keep deriving on read (no new field)'],
		source: 'founder design F1 (approved direction A-PUBLIC-LEVEL); framework P-CURVE-EXISTING', why: 'the steeper curve maps today\'s XP to lower levels and levels never drop; the public level needs the same protection as the real level (Public level)',
		get: () => ({ xpField: PARAMS.publicLevel.xpField, levelField: PARAMS.publicLevel.levelField }),
		expected: { xpField: 'publicXp', levelField: 'publicLevel' },
	},
	{
		id: 'P-FOUNDER-SURFACES', status: 'proposed',
		title: 'Which surfaces show which level: every public surface the public level; /fishing-stats (ephemeral) both; future level leaderboards the public level of competitive accounts only',
		modelled: 'shipped (14e27f1): /fish level-ups, /profile, /inventory level line, /fishing-stats; proposed: any future level leaderboard',
		alternatives: ['show the real level on the owner\'s own public replies (a tell)'],
		source: 'founder design F1', why: 'a public card never reveals a private bonus; the owner sees both levels privately (Public level)',
	},
	{
		id: 'P-FOUNDER-WALLET', status: 'proposed',
		title: 'Wallet privacy: /balance and the money lines of /inventory become ephemeral for every player; inventory value uses the stored public value (valueBase)',
		modelled: 'not a model value: a presentation rule (the Founder\'s money is private-multiplied)',
		alternatives: ['a public money field for the Founder (like publicXp)', 'hide money for the Founder only (itself a tell)', 'accept the tell'],
		source: 'founder design D4', why: 'the /inventory Balance and Inventory value lines and /balance show the Founder\'s real, private-multiplied money in public replies today (Fix first)',
	},
	{
		id: 'P-FOUNDER-DEV-GRANTS', status: 'proposed',
		title: 'Developer XP grants move xp and publicXp together (publicXp never above xp), both audited',
		modelled: 'default scope \'both\' (shipped 14e27f1: set applies the same value, add the same delta, publicXp clamped to [0, xp], audit stores both)',
		alternatives: ['a scope option real | public for one-field corrections (design stage; not shipped)'],
		source: 'founder design F1', why: 'an admin correction never makes a normal player\'s public level diverge from their level',
		get: () => PARAMS.publicLevel.devGrantDefaultScope, expected: 'both',
	},
	{
		id: 'P-FOUNDER-MIGRATION', status: 'proposed',
		title: 'Migrations stay additive and idempotent: publicXp as shipped; at the curve change a stored publicLevel where missing (with P-CURVE-EXISTING\'s freeze); existing Founder fish keep their stored value',
		modelled: 'publicXp: shipped (14e27f1: accounts without it get xp minus every profile bonus in their applied cast journals, three result shapes; members get publicXp = xp). Proposed: publicLevel = today\'s-curve level of publicXp, written only where missing, before the new curve applies; new catches use the new sell multiplier, stored fish values are never rewritten; PROFILES.founder is code (a BALANCE_VERSION bump), not player data',
		alternatives: ['recompute stored Founder fish values at the new multiplier (rewrites player documents)'],
		source: 'founder design', why: 'no player document is rewritten; running any step twice is a no-op (Migrations)',
	},
];

// ---------------------------------------------------------------------------------------------
// Report
const decisionRows = () => DECISIONS.map((d) => ({ ...Object.fromEntries(Object.entries(d).filter(([k]) => k !== 'get' && k !== 'expected')), recordMatchesModel: d.get ? same(d.get(), d.expected) : null }));

let reportMemo = null;
function report() {
	if (reportMemo) return reportMemo;
	const path = F.gearPath();
	const T = today();
	const s = solve();
	const prof = founderProfile();
	const G = gacha();
	const ref = F.REFERENCE_ARCHETYPE;
	const archetypes = Object.keys(F.ARCHETYPES);
	const gates = PARAMS.targets.gatingModes;

	// Visible distribution and plausibility per tier (home biome).
	const visible = path.map((t) => {
		const fo = founderOutcome({ tier: t.tier }, { profile: prof });
		const nd = F.fishDistribution(normalChance(t));
		return {
			tier: t.tier, key: t.key, level: t.level, biome: fo.biome,
			normal: { dist: nd.dist.slice(1).map((p) => round(p, 4)), mean: round(nd.mean, 3), p3plus: round(nd.p3plus, 4), p5: round(nd.p5, 4), legendaryCardShare: round(fo.normal.legendaryCardShare, 4) },
			founder: { dist: fo.visible.dist.slice(1).map((p) => round(p, 4)), mean: round(fo.visible.mean, 3), pOne: round(fo.visible.pOne, 4), p3plus: round(fo.visible.p3plus, 4), p5: round(fo.visible.p5, 4), legendaryCardShare: round(fo.legendaryCardShare, 4) },
			todayFounderFishPerCast: round(T.byRod[PARAMS.targets.todayRodOfTier[t.tier][0]].fishPerCast.founder, 2),
		};
	});

	// New power per tier: home biome detail + all-biome ranges of the ratios.
	const power = path.map((t) => {
		const fo = founderOutcome({ tier: t.tier }, { profile: prof });
		const all = F.LIVE_BIOMES.map((b) => founderOutcome({ tier: t.tier, biome: b }, { profile: prof }));
		const tgtXp = F.LIVE_BIOMES.map((b) => maxOf(PARAMS.targets.todayRodOfTier[t.tier].map((rod) => T.byRod[rod].biomes[b].xpRatio)));
		const tgtCash = F.LIVE_BIOMES.map((b) => maxOf(PARAMS.targets.todayRodOfTier[t.tier].map((rod) => T.byRod[rod].biomes[b].cashRatio)));
		const nl = founderOutcome({ tier: t.tier }, { profile: profileWith({ xp: s.xp, sell: s.sell, durabilityEfficiency: s.durabilityEfficiency }) });
		return {
			tier: t.tier, key: t.key, level: t.level, homeBiome: fo.biome,
			cooldownMs: { normal: fo.normal.cooldownMs, founder: fo.cooldownMs },
			castsPerHour: { normal: round(fo.normal.casts, 1), founder: round(fo.hourly.casts, 1) },
			home: {
				xpPerHour: { normal: Math.round(fo.normal.xpPerHour), founderBase: Math.round(fo.hourly.xpBase), founder: Math.round(fo.hourly.xp) },
				cashPerHour: { normal: Math.round(fo.normal.cashPerHour), founderBase: Math.round(fo.hourly.valueBase), founder: Math.round(fo.hourly.value) },
				legendaryPlusPerHour: { normal: round(fo.normal.legendaryPlusPerHour, 2), founder: round(fo.hourly.legendaryPlus, 1), founderNoPity: round(fo.pity.noPity ? fo.pity.noPity.perCast * fo.hourly.casts : fo.hourly.legendaryPlus, 1) },
				durabilityPerFish: { normal: round(fo.normal.durabilityPerCast / fo.normal.fishPerCast, 3), founder: round(fo.perCast.durability / fo.perCast.fish, 3) },
			},
			ratio: {
				xp: { min: round(minOf(all.map((x) => x.ratio.xp)), 1), max: round(maxOf(all.map((x) => x.ratio.xp)), 1), today: [round(minOf(tgtXp), 1), round(maxOf(tgtXp), 1)], minOverTarget: round(minOf(all.map((x, i) => x.ratio.xp / tgtXp[i])), 3) },
				cash: { min: round(minOf(all.map((x) => x.ratio.cash)), 1), max: round(maxOf(all.map((x) => x.ratio.cash)), 1), today: [round(minOf(tgtCash), 1), round(maxOf(tgtCash), 1)], minOverTarget: round(minOf(all.map((x, i) => x.ratio.cash / tgtCash[i])), 3) },
				legendaryPlus: { new: round(fo.ratio.legendaryPlus, 1), today: round(s.luckTarget[t.tier], 1) },
				xpBase: round(fo.ratio.xpBase, 2),
				cashBase: round(fo.ratio.cashBase, 2),
				durabilityPerFish: round(fo.ratio.durabilityPerFish, 3),
				fishPerCast: round(fo.ratio.fish, 2),
				fishPerHour: round(fo.ratio.fish * fo.ratio.casts, 2),
				casts: round(fo.ratio.casts, 2),
			},
			// Decision P-FOUNDER-LUCK alternative: the same profile without the private luck.
			noLuck: { legendaryPlusRatio: round(nl.ratio.legendaryPlus, 1), vsToday: round(nl.ratio.legendaryPlus / s.luckTarget[t.tier], 3), legendaryCardShare: round(nl.legendaryCardShare, 4), perFish: round(nl.pity.perFish, 4) },
			legendaryPlusPerFish: round(fo.pity.perFish, 4),
		};
	});

	// Counterfactual: TODAY's Founder profile (xp, sell, no luck, today's efficiency) under the new rules, on
	// the integrated model. Its cast profile is today's; quests, boxes and buffs read the proposed profile
	// (box and quest money, not the cast XP).
	const unchanged = (() => {
		const p0 = profileWith({ xp: TODAY.multipliers.xp, sell: TODAY.multipliers.sell });
		const lc = Object.fromEntries(gates.map((g) => [g, lifecycle(ref, { profile: p0, gating: g, horizon: 'real' })]));
		const rows = path.map((t) => {
			const fo = founderOutcome({ tier: t.tier }, { profile: p0 });
			const todayL = maxOf(PARAMS.targets.todayRodOfTier[t.tier].map((rod) => T.byRod[rod].legendaryPlusPerHour.founder));
			return { tier: t.tier, fishPerCast: round(fo.visible.mean, 2), xpRatio: round(fo.ratio.xp, 1), cashRatio: round(fo.ratio.cash, 1), legendaryPlusPerHour: round(fo.hourly.legendaryPlus, 1), todayFounderLegendaryPlusPerHour: round(todayL, 1), legendaryPlusDrop: round(todayL / fo.hourly.legendaryPlus, 1) };
		});
		// XP for Lv 50: the new curve against today's (100·L², balance.js levelForXp).
		const todayXpForL50 = F.xpForLevel(50, { ...F.CURVE, quartic: 0 });
		if (levelForXpToday(todayXpForL50) !== 50 || levelForXpToday(todayXpForL50 - 1) !== 49) throw new Error(`${SYSTEM_NAME}: today's curve is not 100·L² (balance.js levelForXp)`);
		return {
			profile: { xp: p0.multipliers.xp, sell: p0.multipliers.sell, luck: 0, durabilityEfficiency: p0.stats.durabilityEfficiency },
			regularRealL50Hours: { realGate: lc.real.real[50]?.hours ?? null, publicGate: lc.public.real[50]?.hours ?? null, todayFounder: T.lifecycles[ref]?.founderHours?.[50] ?? null },
			l50XpVsToday: round(F.xpForLevel(50) / todayXpForL50, 2),
			byTier: rows,
		};
	})();

	// Upkeep (durability): reference sets from rods (maxDurability, repairCost), Founder vs Normal.
	const upkeep = path.filter((t) => t.tier > 0).map((t) => {
		const rod = rods.craftRod(rods.referenceSet(t.tier));
		const fo = founderOutcome({ tier: t.tier }, { profile: prof });
		const fToday = founderOutcome({ tier: t.tier }, { profile: profileWith({ luck: s.luck, xp: s.xp, sell: s.sell }) });
		const nLife = rod.maxDurability / (fo.normal.durabilityPerCast * fo.normal.casts);
		const life = (perCast) => rod.maxDurability / (perCast * fo.hourly.casts);
		const fLife = life(fo.perCast.durability);
		return {
			tier: t.tier, maxDurability: rod.maxDurability, repairCost: rod.repairCost,
			durabilityPerCast: { normal: round(fo.normal.durabilityPerCast, 3), founderTodayRuleTodayEff: round(fToday.durabilityByRule.ceil, 3), founderStochasticTodayEff: round(fToday.durabilityByRule.stochastic, 3), founderProposed: round(fo.perCast.durability, 3) },
			lifeHours: { normal: round(nLife, 2), founderTodayRuleTodayEff: round(life(fToday.durabilityByRule.ceil), 2), founderProposed: round(fLife, 2) },
			lifeRatio: { todayTarget: round(s.lifeTarget[t.tier], 3), todayRuleTodayEff: round(life(fToday.durabilityByRule.ceil) / nLife, 3), proposed: round(fLife / nLife, 3) },
			upkeepShare: { normal: round(rod.repairCost / (nLife * fo.normal.cashPerHour), 4), founder: round(rod.repairCost / (fLife * fo.hourly.value), 6) },
			durabilityPerFish: { normal: round(fo.normal.durabilityPerCast / fo.normal.fishPerCast, 3), founder: round(fo.perCast.durability / fo.perCast.fish, 3) },
		};
	});

	// Lifecycles (integrated): Normal = the reference loop; the Founder under both gate options.
	const normalLc = Object.fromEntries(archetypes.map((a) => [a, lifecycle(a)]));
	const founderLc = Object.fromEntries(gates.map((g) => [g, Object.fromEntries(archetypes.map((a) => [a, lifecycle(a, { profile: prof, gating: g })]))]));
	const timeTable = Object.fromEntries(archetypes.map((a) => {
		const tgt = T.lifecycles[a]?.founderHours || {};
		const row = {};
		for (const L of F.LIFECYCLE.milestones) {
			row[L] = {
				todayFounder: tgt[L] ?? null,
				todayNormal: T.lifecycles[a]?.normalHours?.[L] ?? null,
				newNormal: normalLc[a].real[L]?.hours ?? null,
				founderReal: Object.fromEntries(gates.map((g) => [g, founderLc[g][a].real[L]?.hours ?? null])),
				founderPublic: Object.fromEntries(gates.map((g) => [g, founderLc[g][a].public[L]?.hours ?? null])),
			};
		}
		return [a, row];
	}));
	const timeCheck = archetypes.every((a) => F.LIFECYCLE.milestones.every((L) => {
		const tgt = T.lifecycles[a]?.founderHours?.[L];
		return tgt == null || gates.every((g) => (founderLc[g][a].real[L]?.hours ?? Infinity) <= tgt);
	}));
	const publicPace = Object.fromEntries(archetypes.map((a) => [a, Object.fromEntries(F.LIFECYCLE.milestones.map((L) => {
		const n = normalLc[a].real[L]?.hours;
		const p = founderLc[PARAMS.publicLevel.gate][a].public[L]?.hours;
		return [L, { founderPublicHours: p ?? null, normalHours: n ?? null, speedup: n && p ? round(n / p, 2) : null }];
	}))]));
	// XP sources for the reference archetype, at each PUBLIC milestone (the recommended gate level).
	const decomposition = Object.fromEntries(Object.entries(founderLc[PARAMS.publicLevel.gate][ref].sourcesAtPublicMilestone).map(([L, x]) => {
		const acc = x.account;
		const pub = x.public;
		const tot = sum(Object.values(acc));
		const pubTot = sum(Object.values(pub));
		return [L, {
			realLevel: x.realLevel,
			account: {
				fishingBase: round(pub.fishing / tot, 4), fishingProfileBonus: round((acc.fishing - pub.fishing) / tot, 4),
				questsBase: round((pub.quests + pub.daily) / tot, 4), questsProfileBonus: round((acc.quests + acc.daily - pub.quests - pub.daily) / tot, 4),
				buffs: round(acc.buffs / tot, 4), other: round(acc.other / tot, 4), totalXp: Math.round(tot),
			},
			public: { fishing: round(pub.fishing / pubTot, 4), quests: round(pub.quests / pubTot, 4), daily: round(pub.daily / pubTot, 4), buffs: round(pub.buffs / pubTot, 4), other: round(pub.other / pubTot, 4), totalXp: Math.round(pubTot) },
			otherSources: x.otherSources,
		}];
	}));
	// Day 30 (today's simulation reports day 30): 30 calendar days on the integrated model, any level.
	const day30 = Object.fromEntries(archetypes.map((a) => {
		const n = lifecycle(a, { horizon: 'day30' }).day30;
		const fp = lifecycle(a, { profile: prof, gating: 'public', horizon: 'day30' }).day30;
		const fr = lifecycle(a, { profile: prof, gating: 'real', horizon: 'day30' }).day30;
		const td = T.lifecycles[a]?.day30 || null;
		const row = (x) => ({ hours: x.hours, realLevel: x.level, publicLevel: x.publicLevel, realXp: x.xp, publicXp: x.publicXp, money: x.money, tier: x.tier, biome: x.biome });
		return [a, {
			hours: n.hours, today: td, newNormal: { level: n.level, xp: n.xp, money: n.money },
			founderPublicGate: row(fp), founderRealGate: row(fr),
			xpVsToday: td ? { todayFounderXp: td.founder.xp, newFounderXp: fp.xp, ratio: round(fp.xp / td.founder.xp, 2) } : null,
			moneyRatioToNormal: td ? { today: round(td.founder.money / td.normal.money, 1), new: round(fp.money / n.money, 1) } : null,
		}];
	}));

	// The day-30 money check on the integrated model: for every archetype and gate whose Founder money ÷ Normal
	// falls below today's, the sell multiplier (x5 steps) that would restore today's ratio, and today's x margin.
	// A SENSITIVITY for the user's decision, never a proposal: the solved sell stays M3/M4's. (Trial sell on the
	// Founder's casts; quests, boxes and buffs read the proposed profile.)
	const day30Money = archetypes.flatMap((a) => {
		const tdy = T.lifecycles[a]?.day30;
		if (!tdy) return [];
		const normalRun = lifecycle(a, { horizon: 'day30' });
		const n = normalRun.day30.money;
		const todayRatio = tdy.founder.money / tdy.normal.money;
		const fishingShare = (x) => (x.ledger.cash.fishing || 0) / sum(Object.values(x.ledger.cash));
		return gates.map((g) => {
			const ratioAt = (sell) => lifecycle(a, { profile: profileWith({ luck: s.luck, xp: s.xp, sell, durabilityEfficiency: s.durabilityEfficiency }), gating: g, horizon: 'day30' }).day30.money / n;
			const now = ratioAt(s.sell);
			if (now >= todayRatio) return null;
			const stepUp = (target) => {
				for (let sell = s.sell + PARAMS.rounding.largeStep; sell <= 20 * s.sell; sell += PARAMS.rounding.largeStep) if (ratioAt(sell) >= target) return sell;
				return null;
			};
			const founderRun = lifecycle(a, { profile: prof, gating: g, horizon: 'day30' });
			return { archetype: a, gate: g, todayRatio: round(todayRatio, 1), ratio: round(now, 1), fishingShareOfIncome: { normal: round(fishingShare(normalRun), 4), founder: round(fishingShare(founderRun), 4) }, sellForToday: stepUp(todayRatio), sellForTodayWithMargin: stepUp(todayRatio * PARAMS.targets.margin) };
		}).filter(Boolean);
	});

	// Time to afford each tier set (hours of Founder play at the stage before it; rods crate prices).
	const affordTable = path.filter((t) => t.tier > 0).map((t) => {
		const c = founderCrates(t.tier);
		const fo = founderOutcome({ tier: path[t.tier - 1], biome: F.biomeAt(t.level) }, { profile: prof });
		const no = normalOutcome({ tier: path[t.tier - 1], biome: F.biomeAt(t.level) });
		const a = s.afford.find((x) => x.tier === t.tier);
		return {
			tier: t.tier, crate: c.crate, price: c.price,
			crates: { normal: round(c.normal.expected, 2), founder: round(c.founder.expected, 2) },
			cost: { normal: Math.round(c.normal.expectedCost), founder: Math.round(c.founder.expectedCost) },
			minutes: { normal: round((c.normal.expectedCost / no.hourly.cash) * 60, 1), founder: round((c.founder.expectedCost / fo.hourly.value) * 60, 2), todayFounder: a ? round(a.todayMinutes, 2) : null },
		};
	});

	// Pity model check: the new Old Rod stage is exactly today's Founder Old Rod catch (1 + bonus, table).
	const oldToday = T.byRod['Old Rod'].legendaryPlusPerHour.founderPerFish;
	const oldModel = mean(F.LIVE_BIOMES.map((b) => founderOutcome({ tier: 0, biome: b }, { profile: profileWith() }).pity.perFish));
	const oldModelNoPity = mean(F.LIVE_BIOMES.map((b) => founderOutcome({ tier: 0, biome: b }, { profile: profileWith() }).perDraw.legendaryPlus));

	const definition = publicXpDefinition();
	const status = publicLevelStatus();
	const checks = {
		xpRatioPreserved: power.every((p) => p.ratio.xp.minOverTarget >= 1),
		cashRatioPreserved: power.every((p) => p.ratio.cash.minOverTarget >= 1),
		timeToLevelPreserved: timeCheck,
		affordPreserved: affordTable.every((r) => r.minutes.todayFounder === null || r.minutes.founder <= r.minutes.todayFounder),
		legendaryPlusRatioPreserved: s.luckCapped ? 'capped by plausibility' : power.every((p) => p.ratio.legendaryPlus.new >= p.ratio.legendaryPlus.today),
		visibleWithinNormalMax: visible.every((v) => v.founder.dist.length === F.MULTI.maxFish),
		visibleMeanAtMostFour: visible.every((v) => v.founder.mean <= 4),
		legendaryCardShareWithinCap: visible.every((v) => v.founder.legendaryCardShare <= PARAMS.plausibility.maxLegendaryCardShare + 1e-9),
		normalCrateChainMatchesRods: Object.values(G.crates).every((c) => c.normal.matchesRods),
		rodLifePreserved: upkeep.every((u) => u.lifeRatio.proposed >= u.lifeRatio.todayTarget),
		day30XpAndMoneyRatioPreserved: Object.values(day30).every((d) => !d.today || (d.xpVsToday.ratio >= 1 && d.moneyRatioToNormal.new >= d.moneyRatioToNormal.today)),
		competitiveEligibleFalse: prof.competitiveEligible === false,
		publicXpMatchesShippedDefinition: definition.matchesShipped,
		noPublicTellUnderPublicGate: archetypes.every((a) => founderLc.public[a].tell.hours === 0),
	};
	checks.pass = Object.values(checks).every((v) => v === true || v === 'capped by plausibility');

	reportMemo = {
		...F.stamp(),
		gearPathSource: F.GEAR_PATH_SOURCE,
		subsystem: PARAMS.id,
		method: `framework ${F.FRAMEWORK_VERSION}: per cast, castOutcome/hourly on F.gearPath() (${F.GEAR_PATH_SOURCE}); Founder = Founder rarity table + combined stats, visible count = normal chain + bonus fish capped at ${F.MULTI.maxFish}; lifecycles, integrate.run (${INTEGRATE().REFERENCE.join(', ')}; + founder with its gate); today's numbers from measurements.json / simulation.json / gacha-ev.json at ${F.DESIGN_OVERHEAD_S} s overhead`,
		balanceVersionToday: BALANCE_VERSION,
		proposedProfile: prof,
		solved: {
			durabilityEfficiency: s.durabilityEfficiency, luck: s.luck, luckCapped: s.luckCapped, sell: s.sell, xp: s.xp, margin: PARAMS.targets.margin,
			sellFromCashRatioOnly: s.sellFromCashRatioOnly, xpFromRatioOnly: s.xpFromRatioOnly, timeModel: s.timeModel,
			binding: {
				durability: { tier: Number(s.binding.durability[0]), need: round(s.binding.durability[1], 3) },
				luck: { tier: Number(s.binding.luck[0]), need: round(s.binding.luck[1], 3) },
				cashRatio: { tier: s.binding.cash.tier, biome: s.binding.cash.biome, today: round(s.binding.cash.target, 1), baseRatio: round(s.binding.cash.baseRatio, 2), need: round(s.binding.cash.need, 2) },
				afford: { tier: s.binding.afford.tier, todayMinutes: round(s.binding.afford.todayMinutes, 2), todaySeconds: round(s.binding.afford.todayMinutes * 60, 2), todayCost: s.binding.afford.todayCost, todayIncomePerHour: Math.round(s.binding.afford.todayIncomePerHour), newCost: Math.round(s.binding.afford.newCost), need: round(s.binding.afford.need, 2) },
				xpRatio: { tier: s.binding.xpRatio.tier, biome: s.binding.xpRatio.biome, today: round(s.binding.xpRatio.target, 1), baseRatio: round(s.binding.xpRatio.baseRatio, 2), need: round(s.binding.xpRatio.need, 2) },
				xpTime: { archetype: s.binding.xpTime.archetype, gating: s.binding.xpTime.gating, raw: round(s.binding.xpTime.raw, 2), need: round(s.binding.xpTime.need, 2) },
			},
			lifeTarget: mapValues(s.lifeTarget, (v) => round(v, 3)),
			luckTarget: mapValues(s.luckTarget, (v) => round(v, 1)),
			timeNeed: s.timeNeed.map((x) => ({ ...x, need: round(x.need, 2), raw: round(x.raw, 2) })),
			afford: s.afford.map((x) => ({ tier: x.tier, todayStage: x.todayStage, todayCost: x.todayCost, todayIncomePerHour: Math.round(x.todayIncomePerHour), todayMinutes: round(x.todayMinutes, 2), newCost: Math.round(x.newCost), newBaseIncomePerHour: Math.round(x.newBaseIncomePerHour), need: round(x.need, 2) })),
		},
		today: {
			byRod: Object.fromEntries(Object.entries(T.byRod).map(([rod, r]) => [rod, {
				fishPerCast: { normal: round(r.fishPerCast.normal, 2), founder: round(r.fishPerCast.founder, 2) },
				cooldownMs: r.cooldownMs, castsPerHour: { normal: round(r.castsPerHour.normal, 1), founder: round(r.castsPerHour.founder, 1) },
				xpRatio: { min: round(r.xpRatio.min, 1), max: round(r.xpRatio.max, 1) },
				cashRatio: { min: round(r.cashRatio.min, 1), max: round(r.cashRatio.max, 1) },
				xpPerHour: { normal: Math.round(mean(Object.values(r.biomes).map((b) => b.normal.xpPerHour))), founder: Math.round(mean(Object.values(r.biomes).map((b) => b.founder.xpPerHour))) },
				cashPerHour: { normal: [Math.round(minOf(Object.values(r.biomes).map((b) => b.normal.cashPerHour))), Math.round(maxOf(Object.values(r.biomes).map((b) => b.normal.cashPerHour)))], founder: [Math.round(minOf(Object.values(r.biomes).map((b) => b.founder.cashPerHour))), Math.round(maxOf(Object.values(r.biomes).map((b) => b.founder.cashPerHour)))] },
				legendaryPlusPerHour: { normal: round(r.legendaryPlusPerHour.normal, 2), founder: round(r.legendaryPlusPerHour.founder, 1), ratio: round(r.legendaryPlusPerHour.ratio, 1), founderPerFish: round(r.legendaryPlusPerHour.founderPerFish, 4) },
				durabilityPerFish: { normal: round(r.durabilityPerFish.normal, 3), founder: round(r.durabilityPerFish.founder, 3) },
				rodLifeRatio: round(r.rodLifeRatio, 3),
				luckyItemsPerHour: { founder: round(r.luckyItemsPerHour.founder, 2), boosterPacks: round(r.luckyItemsPerHour.boosterPacks, 2) },
			}])),
			lifecycles: T.lifecycles,
			profile: { multipliers: TODAY.multipliers, stats: TODAY.stats, limits: TODAY.limits, bonusDraws: TODAY.bonusDraws, rarityTable: TODAY.rarityTable },
			pity: TODAY.pity,
			gachaStats: TODAY.gacha.stats,
			gachaPity: TODAY.gacha.pity,
		},
		visible,
		power,
		unchangedProfileUnderNewRules: unchanged,
		upkeep,
		gacha: {
			boxes: Object.fromEntries(Object.entries(G.boxes).map(([k, v]) => [k, { normalPerOpen: round(v.normalPerOpen, 5), founderNoPity: round(v.founderNoPity, 4), founderWithPity: round(v.founderWithPity, 4), ratio: round(v.ratio, 1), opensPerLegendaryPlus: { normal: round(v.opensPerLegendaryPlus.normal, 1), founder: round(v.opensPerLegendaryPlus.founder, 2) } }])),
			crates: Object.fromEntries(Object.entries(G.crates).map(([t, c]) => [t, { crate: c.crate, price: c.price, crates: { normal: round(c.normal.expected, 3), founder: round(c.founder.expected, 3) }, p90: { normal: c.normal.p90, founder: c.founder.p90 }, founderCrateFactor: round(c.founderCrateFactor, 3), legendaryPlusPerSlot: { normal: round(c.legendaryPlusPerSlot.normal, 4), founder: round(c.legendaryPlusPerSlot.founder, 4) }, founderPity: c.founder.pity }])),
		},
		afford: affordTable,
		lifecycle: {
			model: `integrate.run(): ${INTEGRATE().REFERENCE_NOTE}; the Founder adds founder.system({ gate }) (variant.founder) and runs until its public level reaches the maximum level`,
			time: timeTable,
			publicPace,
			tellWindowRealGating: Object.fromEntries(archetypes.map((a) => [a, founderLc.real[a].tell])),
			tellWindowPublicGating: Object.fromEntries(archetypes.map((a) => [a, founderLc.public[a].tell])),
			upgrades: { normal: normalLc[ref].upgrades, ...Object.fromEntries(gates.map((g) => [g, founderLc[g][ref].upgrades])) },
			upgradesByArchetype: Object.fromEntries(archetypes.map((a) => [a, Object.fromEntries(gates.map((g) => [g, founderLc[g][a].upgrades]))])),
			decompositionRegular: decomposition,
			day30,
			day30Money,
		},
		publicLevel: { status, definition },
		integration: { system: systemDescription(), retiredLoopParity: RETIRED_LOOP_PARITY },
		earlierSolves: EARLIER_SOLVES,
		pityModelCheck: { todayFounderOldRodMeasuredPerFish: round(oldToday, 4), modelWithPity: round(oldModel, 4), modelNoPity: round(oldModelNoPity, 4) },
		luckyItems: (() => {
			const pinned = LUCKY_ITEM_SHARE * buildTable(F.NORMAL_RARITY_TABLE).lucky;
			const unpinned = LUCKY_ITEM_SHARE * buildTable(TODAY.rarityTable).lucky;
			const top = path.length - 1;
			const fDraws = founderOutcome({ tier: top }, { profile: prof }).hourly.fish;
			const nDraws = normalOutcome({ tier: top }).hourly.fish;
			return {
				rule: PARAMS.luckyItems, frameworkRule: F.RULES.luckyItems, topTier: top,
				founderTodayPerHour: { oldRod: round(T.byRod['Old Rod'].luckyItemsPerHour.founder, 2), rareRod: round(T.byRod['Custom (Rare parts)'].luckyItemsPerHour.founder, 2), boosterPacksOldRod: round(T.byRod['Old Rod'].luckyItemsPerHour.boosterPacks, 2), boosterPacksRareRod: round(T.byRod['Custom (Rare parts)'].luckyItemsPerHour.boosterPacks, 2) },
				itemPerDraw: { pinnedNormalBase: round(pinned, 8), founderBaseUnpinned: round(unpinned, 6) },
				drawsPerHourTopTier: { founder: Math.round(fDraws), normal: Math.round(nDraws) },
				hoursPerLuckyItemTopTier: { founderPinned: round(1 / (fDraws * pinned), 1), founderUnpinned: round(1 / (fDraws * unpinned), 2), normal: round(1 / (nDraws * pinned), 1) },
			};
		})(),
		checks,
		decisions: decisionRows(),
	};
	return reportMemo;
}

// ---------------------------------------------------------------------------------------------
// Markdown tables for docs/economy/5b/founder.md (render-docs.js). Every number in the doc comes from here.
const esc = (c) => String(c).replace(/\|/g, '\\|');
const mdTable = (head, rows) => [`| ${head.join(' | ')} |`, `| ${head.map(() => '---').join(' | ')} |`, ...rows.map((row) => `| ${row.map(esc).join(' | ')} |`)].join('\n');
const digits = (x, d) => Math.abs(Number(x)).toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d });
/** Sign of x as printed at d decimals (0 when it rounds to zero, so no '-0.00'). */
const signAt = (x, d) => (Number(digits(x, d).replace(/,/g, '')) === 0 ? 0 : Math.sign(x));
const num = (x, d = 2) => `${signAt(x, d) < 0 ? '−' : ''}${digits(x, d)}`;
const pct = (x, d = 1) => `${num(x * 100, d)}%`;
const hrs = (h) => (h === undefined || h === null ? '—' : `${num(h, 2)} h`);
const int = (x) => num(x, 0);
const times = (x, d = 1) => `${num(x, d)}×`;
const yes = (b) => (b ? 'yes' : '**no**');
/** Large amounts compactly: 1,234 / 12.3k / 4.56M / 7.89B. */
const compact = (x) => {
	const a = Math.abs(x);
	const s = a >= 1e9 ? `${num(a / 1e9, 2)}B` : a >= 1e6 ? `${num(a / 1e6, 2)}M` : a >= 1e4 ? `${num(a / 1e3, 1)}k` : int(a);
	return `${x < 0 ? '−' : ''}${s}`;
};
const usd = (x) => `${x < 0 ? '−' : ''}$${compact(Math.abs(x))}`;
const range = (xs, fmt) => {
	const lo = Math.min(...xs);
	const hi = Math.max(...xs);
	return lo === hi ? fmt(lo) : `${fmt(lo)}–${fmt(hi)}`;
};
const tierName = (t) => (Number(t) === 0 ? 'Old Rod' : `T${t}`);
const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);
const pityText = (r) => `from ${r.softStart}, +${num(r.rampPerCast * 100, 1)}% per ${r.counter.startsWith('casts') ? 'cast' : 'open'}, capped at +${num(r.maxBonus * 100, 0)}%, guaranteed at ${r.hard}`;
const statText = (st) => Object.entries(st).map(([k, v]) => `${k} ${num(v, 2)}`).join(', ');

function markdownTables() {
	const R = report();
	const S = R.solved;
	const B = S.binding;
	const L = R.lifecycle;
	const ref = F.REFERENCE_ARCHETYPE;
	const archetypes = Object.keys(F.ARCHETYPES);
	const gates = PARAMS.targets.gatingModes;
	const prof = R.proposedProfile;
	const td = R.today;
	const PR = RETIRED_LOOP_PARITY;
	const P1 = R.publicLevel;
	const T = {};
	const rodRow = { 'Old Rod': 'Old Rod (Lv 0)', 'Custom (Uncommon parts)': 'Uncommon parts (the Lv 20 rod)', 'Custom (Rare parts)': 'Rare parts (the Lv 30 rod)', 'Custom (Legendary parts)': 'Legendary parts' };
	const lastTier = R.power[R.power.length - 1];
	const firstTier = R.power[0];
	const time = (a, lv) => L.time[a][lv];
	const failing = Object.entries(R.checks).filter(([k, v]) => k !== 'pass' && v !== true && v !== 'capped by plausibility').map(([k]) => k);
	const openTells = P1.status.surfaces.filter((x) => /open public tell/.test(x.status));

	// ----- Summary -----
	T['founder-headline'] = mdTable(['Figure', 'Value', 'Table'], [
		['Visible fish per cast (Founder)', `${range(R.visible.map((v) => v.founder.mean), (x) => num(x, 2))} from the Old Rod to T${lastTier.tier}, every cast 1–${F.MULTI.maxFish} fish (today up to ${int(TODAY.limits.maxDraws * TODAY.limits.maxPerDraw)})`, 'Visible catch'],
		['Proposed private profile (solved at 5b.4)', `XP ×${S.xp}, sell ×${S.sell}, Luck +${S.luck}, durability efficiency ${S.durabilityEfficiency}; quests ×${prof.multipliers.questXp} / ×${prof.multipliers.questCash} kept`, 'Current → proposed; Targets'],
		['XP/h at equal gear, Founder ÷ Normal', `${range(R.power.flatMap((p) => [p.ratio.xp.min, p.ratio.xp.max]), (x) => times(x, 0))} (today ${range(R.power.flatMap((p) => p.ratio.xp.today), (x) => times(x, 1))})`, 'Per tier'],
		['$/h at equal gear, Founder ÷ Normal', `${range(R.power.flatMap((p) => [p.ratio.cash.min, p.ratio.cash.max]), (x) => times(x, 0))} (today ${range(R.power.flatMap((p) => p.ratio.cash.today), (x) => times(x, 0))})`, 'Per tier'],
		['Regular Founder, hours to real Lv 50 (integrated)', `${hrs(time(ref, 50).founderReal.public)} (public gate) / ${hrs(time(ref, 50).founderReal.real)} (real gate); today ${hrs(time(ref, 50).todayFounder)}`, 'Hours to each level'],
		['Regular Founder, hours to public Lv 50 (public gate)', `${hrs(time(ref, 50).founderPublic.public)}, against ${hrs(time(ref, 50).newNormal)} for a normal regular player`, 'Hours to each level; Public pace'],
		['Public tell (fishing above the public level)', `none under the public gate; under the real gate ${range(archetypes.map((a) => L.tellWindowRealGating[a].hours), hrs)} of play`, 'Level gate'],
		['F1 public level', `shipped (${F1_COMMITS.main}) for the /fish level-up, /profile, the /inventory level line and /fishing-stats; the model's public XP ${P1.definition.matchesShipped ? 'matches' : '**differs from**'} the shipped definition`, 'Public level'],
		['Open public tells (fix first)', openTells.length ? openTells.map((x) => x.surface.replace(/`/g, '')).join('; ') : 'none', 'Fix first'],
		['Design checks', failing.length ? `**${failing.length} fail:** ${failing.join(', ')}` : `all ${Object.keys(R.checks).length - 1} pass`, 'Checks'],
		['Retired private loop', `system() matched it exactly: ${PR.exactMilestones}/${PR.milestonesCompared} milestones step-exact (${PR.commit})`, 'Retired-loop parity'],
	]);

	// ----- Decisions -----
	T['founder-decisions'] = `${mdTable(['ID', 'Proposed decision', 'Modelled', 'Alternatives', 'Why', 'Record = model'], DECISIONS.map((d) => [
		`\`${d.id}\``, d.title, d.modelled, d.alternatives.join('; '), d.why,
		d.get ? yes(same(d.get(), d.expected)) : 'n/a (not a model value)',
	]))}\n\nStatus of every entry: \`${[...new Set(DECISIONS.map((d) => d.status))].join(', ')}\`. Only the user approves; \`decisions.js\` joins these to the Phase 5B registry, alongside the framework entries this design relies on (\`P-FOUNDER-GATE\`, \`P-DURABILITY\`, \`P-LUCKY\`), and \`check-shared.js\` verifies each record against the model.`;

	// ----- Fix first -----
	const ev = P1.status.evidence;
	const li = R.luckyItems;
	T['founder-fix-first'] = mdTable(['#', 'Public tell', 'Evidence (src/, read at render time)', 'Status', 'Fix'], [
		['F0', 'The Founder badge: `/profile` puts "👑 Founder" in the title when the Founder views its own profile, and the reply is public (`buttonPagination` defers without an ephemeral flag)', ev.profileFounderBadgeInPublicReply ? 'profile.js title; buttonPagination.js `deferReply()`' : 'not found', ev.profileFounderBadgeInPublicReply ? '**open**' : 'closed', 'Remove the badge from the public embed (`/fishing-stats` already shows it privately); regression test: the public `/profile` embed never contains the profile name'],
		['F0b', `Lucky items: today's Founder catches ${num(li.founderTodayPerHour.boosterPacksOldRod, 1)} Booster Packs per hour on the Old Rod and ${num(li.founderTodayPerHour.boosterPacksRareRod, 1)} on a Rare-parts rod (normal players: an Easter egg)`, 'measurements.json Founder scenarios; cast.js `drawTemplates`', li.frameworkRule === 'pinned' ? 'proposed (framework `P-LUCKY`, modelled)' : '**not modelled**', 'Pin the item branch to the normal base table for every profile (Lucky items)'],
		['F1', 'Level: public level-ups, `/profile` and `/inventory` levels came from the real (private-multiplied) level', [ev.castWritesPublicXp && 'cast.js writes publicXp', ev.fishCardPublicLevelUp && 'fish.js reads result.level.public', ev.migration && 'migrations.js migratePublicXp'].filter(Boolean).join('; ') || 'not found', ev.castWritesPublicXp && ev.fishCardPublicLevelUp && ev.profilePublicLevel && ev.inventoryPublicLevel ? `**shipped** (${F1_COMMITS.main}; ${F1_COMMITS.branch} on this branch)` : '**incomplete**', 'Done for these surfaces (Public level)'],
		['F1b', 'Money: `/inventory` "Balance" and "Inventory value" and `/balance` show the Founder\'s real money and final (private-multiplied) fish values in public replies', [ev.inventoryRealBalance && 'inventory.js Balance line', ev.inventoryFinalValue && 'User.getInventoryValue sums stored final values', ev.balanceCommandPublic && 'balance.js public reply'].filter(Boolean).join('; ') || 'not found', ev.inventoryRealBalance || ev.inventoryFinalValue || ev.balanceCommandPublic ? '**open**' : 'closed', '`P-FOUNDER-WALLET`: money lines ephemeral for everyone; inventory value from `valueBase`'],
		['F1c', 'Gates: biome access, quest start, shop and rod-part level checks read the real level, so a Founder fishes above its public level (Level gate)', ev.gatesReadRealLevel.length ? ev.gatesReadRealLevel.map((f) => f.split('/').pop()).join(', ') : 'none found', ev.gatesReadRealLevel.length ? '**open** (live today)' : 'closed', 'Framework `P-FOUNDER-GATE`: gates read the public level'],
	]);

	// ----- Public level (F1) -----
	T['founder-f1-surfaces'] = mdTable(['Surface', 'Shows', 'Status', 'Where'], P1.status.surfaces.map((x) => [x.surface, x.shows, x.status, x.where]));
	const D = P1.definition;
	T['founder-f1-definition'] = `${mdTable(['Component', 'Shipped (src/engine/publicLevel.js, cast.js)', 'Model (integrated ledgers)'], D.components.map((c) => [c.component, c.shipped, c.model]))}\n\n${mdTable(['XP source (regular Founder to public Lv 60, public gate)', 'Account XP', 'Public XP', 'Account ÷ public', 'Profile multiplier that applies', 'Match'], D.sources.map((x) => [x.source, int(x.xp), int(x.publicXp), x.multiplier === null ? '—' : times(x.multiplier, 2), x.expected === null ? '—' : times(x.expected, 0), yes(x.matches)]))}\n\nNormal players (same run without the founder system): public XP equals XP for every source: ${yes(D.normalPublicEqualsXp)}. Remaining differences: ${D.differences.join(' ')}`;

	// ----- Today -----
	T['founder-today-rods'] = mdTable(['Today\'s rod', 'Fish/cast N → F', 'Cooldown N / F', 'Casts/h N / F', 'XP/h N → F (6-biome mean)', 'XP/h ratio', '$/h F (6 biomes)', '$/h ratio', 'Legendary+/h N → F (ratio)', 'Durability per fish (F)', 'Rod life F/N (hours)', 'Lucky items/h F (Booster Packs)'], Object.entries(td.byRod).map(([rod, r]) => [
		rodRow[rod] || rod, `${num(r.fishPerCast.normal, 0)} → ${num(r.fishPerCast.founder, 2)}`, `${num(r.cooldownMs.normal / 1000, 1)} / ${num(r.cooldownMs.founder / 1000, 1)} s`, `${int(r.castsPerHour.normal)} / ${int(r.castsPerHour.founder)}`,
		`${int(r.xpPerHour.normal)} → ${int(r.xpPerHour.founder)}`, `${times(r.xpRatio.min)}–${times(r.xpRatio.max)}`, `${usd(r.cashPerHour.founder[0])}–${usd(r.cashPerHour.founder[1])}`, `${times(r.cashRatio.min, 0)}–${times(r.cashRatio.max, 0)}`,
		`${num(r.legendaryPlusPerHour.normal, 2)} → ${num(r.legendaryPlusPerHour.founder, 1)} (${times(r.legendaryPlusPerHour.ratio, 0)})`, num(r.durabilityPerFish.founder, 3), num(r.rodLifeRatio, 2), `${num(r.luckyItemsPerHour.founder, 1)} (${num(r.luckyItemsPerHour.boosterPacks, 1)})`,
	])) + `\n\nMeasured by the real engine (\`measurements.json\`; Founder casts persisted so pity advanced), recomputed at ${F.DESIGN_OVERHEAD_S} s overhead. Normal Legendary+ rates are exact (\`F.castOutcome\` with the legacy rod stats).`;
	T['founder-today-lifecycle'] = mdTable(['Player', `Founder hours to Lv ${F.LIFECYCLE.milestones.join(' / ')}`, 'Normal Lv 50', 'Day 30: Founder', 'Day 30: Normal'], archetypes.filter((a) => td.lifecycles[a]).map((a) => {
		const l = td.lifecycles[a];
		return [cap(a), F.LIFECYCLE.milestones.map((lv) => (l.founderHours[lv] == null ? '—' : num(l.founderHours[lv], 2))).join(' / ') + ' h', l.normalHours[50] == null ? 'not reached' : hrs(l.normalHours[50]), `Lv ${int(l.day30.founder.level)}, ${compact(l.day30.founder.xp)} XP, ${usd(l.day30.founder.money)}`, `Lv ${int(l.day30.normal.level)}, ${usd(l.day30.normal.money)}`];
	})) + '\n\nToday\'s curve (100·L²), from `simulation.json`.';
	const gb = R.gacha.boxes;
	T['founder-today-gacha'] = mdTable(['Box', 'P(open holds a Legendary+): Normal', 'Founder, no pity', 'Founder, with pity', 'Ratio', 'Opens per Legendary+ N → F'], Object.entries(gb).map(([name, b]) => [name, pct(b.normalPerOpen, 2), pct(b.founderNoPity, 2), pct(b.founderWithPity, 1), times(b.ratio), `${num(b.opensPerLegendaryPlus.normal, 0)} → ${num(b.opensPerLegendaryPlus.founder, 1)}`]))
		+ `\n\nExact from the V2 tables. Founder gacha stats: ${statText(td.gachaStats)}; box pity ${pityText(td.gachaPity.legendaryPlus)} (both kept).`;
	const U = R.unchangedProfileUnderNewRules;
	T['founder-unchanged'] = mdTable(['Tier', 'Fish/cast', 'XP ratio at equal gear', '$ ratio at equal gear', 'Legendary+/h: today\'s Founder → unchanged profile', 'Drop'], U.byTier.map((r) => [tierName(r.tier), num(r.fishPerCast, 2), times(r.xpRatio), times(r.cashRatio), `${num(r.todayFounderLegendaryPlusPerHour, 1)} → ${num(r.legendaryPlusPerHour, 1)}`, times(r.legendaryPlusDrop)]))
		+ `\n\nToday's Founder profile (XP ×${U.profile.xp}, sell ×${U.profile.sell}, no luck, efficiency ${U.profile.durabilityEfficiency}) under the new rules. Lv 50 needs ${times(U.l50XpVsToday, 2)} today's XP. On the integrated model the regular Founder would reach real Lv 50 after **${hrs(U.regularRealL50Hours.realGate)}** of play (real gate) or ${hrs(U.regularRealL50Hours.publicGate)} (public gate), against ${hrs(U.regularRealL50Hours.todayFounder)} today. (Its casts use today's profile; quests, boxes and buffs read the proposed one, which changes box and quest money, not the cast XP.)`;

	// ----- Targets -----
	T['founder-tier-map'] = mdTable(['New tier', 'Today\'s rod it is compared with'], Object.entries(PARAMS.targets.todayRodOfTier).map(([t, list]) => [tierName(t), list.map((r) => rodRow[r] || r).join(' and ') + (list.length > 1 ? ' (the higher ratio)' : '')]));
	const tn = (x) => `${cap(x.archetype)}, ${x.gating} gate`;
	T['founder-targets'] = mdTable(['#', 'Metric', 'Definition', 'Binding case', 'Needed (× margin)', 'Chosen'], [
		['M1', 'XP ratio at equal gear', `Founder final XP/h ÷ Normal XP/h, same tier and biome, ${F.DESIGN_OVERHEAD_S} s overhead; ≥ today's ratio on the mapped rod in all ${F.LIVE_BIOMES.length} biomes × ${R.power.length} tiers`, `${tierName(B.xpRatio.tier)} ${B.xpRatio.biome} (today ${times(B.xpRatio.today)}; Founder base ${times(B.xpRatio.baseRatio, 2)})`, times(B.xpRatio.need, 2), '—'],
		['M2', 'Absolute time to level (integrated)', `Hours of play to real Lv ${F.LIFECYCLE.milestones.join('/')} on the new curve, \`integrate.run\` with every reference system; ≤ today's Founder hours for all ${archetypes.length} archetypes and both gate options`, `${tn(B.xpTime)} (raw ${times(B.xpTime.raw, 2)})`, times(B.xpTime.need, 2), `**XP ×${S.xp}**`],
		['M3', '$ ratio at equal gear', 'Founder final $/h ÷ Normal $/h, same tier and biome; ≥ today\'s ratio in every case', `${tierName(B.cashRatio.tier)} ${B.cashRatio.biome} (today ${times(B.cashRatio.today)}; Founder base ${times(B.cashRatio.baseRatio, 2)})`, times(B.cashRatio.need, 2), '—'],
		['M4', 'Absolute time to afford', 'Minutes of Founder play to buy the tier set at the two purchases that exist today (T1 ↔ the Lv 20 rod, T2 ↔ the Lv 30 rod), rods crate prices and the Founder\'s crate luck; ≤ today\'s', `${tierName(B.afford.tier)}: today ${num(B.afford.todaySeconds, 1)} s (${usd(B.afford.todayCost)} at ${usd(B.afford.todayIncomePerHour)}/h; now ${usd(B.afford.newCost)})`, times(B.afford.need, 2), `**sell ×${S.sell}**`],
		['M5', 'Legendary+ per hour ratio at equal gear', `Legendary+/h ÷ Normal, home biome, with Founder pity; ≥ today's ratio; at most ${pct(PARAMS.plausibility.maxLegendaryCardShare, 1)} of public cards may show a Legendary+`, `${tierName(B.luck.tier)} (today ${times(S.luckTarget[B.luck.tier])})`, `Luck +${num(B.luck.need, 3)}`, `**Luck +${S.luck}**${S.luckCapped ? ' (capped)' : ''}`],
		['M6', 'Rod life', `Hours of play a crafted rod lasts, Founder ÷ Normal, same rod, home biome; ≥ today's (${range(Object.values(S.lifeTarget), (x) => times(x, 2))}); never below today's ${TODAY.stats.durabilityEfficiency}, never above the ${STAT_CAPS.durabilityEfficiency.max} cap`, tierName(B.durability.tier), num(B.durability.need, 3), `**Efficiency ${S.durabilityEfficiency}**`],
	]) + `\n\nEvery target is met at today's value × ${PARAMS.targets.margin} and rounded up. From one family alone: sell would be ×${S.sellFromCashRatioOnly} (M3 without M4) and XP ×${S.xpFromRatioOnly} (M1 without M2).`;
	T['founder-time-need'] = mdTable(['Archetype', ...gates.map((g) => `${cap(g)} gate: raw → × margin`)], archetypes.map((a) => [cap(a), ...gates.map((g) => {
		const x = S.timeNeed.find((y) => y.archetype === a && y.gating === g);
		return x ? `${times(x.raw, 2)} → ${times(x.need, 2)}` : '—';
	})])) + `\n\nM2 per archetype and gate: the smallest XP multiplier whose integrated lifecycle (${S.timeModel}) reaches every real-level milestone no later than today's Founder.`;

	const bindingNow = {
		xp: `M2: ${B.xpTime.archetype}, ${B.xpTime.gating} gate, ×${num(B.xpTime.need, 2)}`,
		sell: `M4: ${tierName(B.afford.tier)}, ×${num(B.afford.need, 2)}`,
		luck: `M5: ${tierName(B.luck.tier)}, +${num(B.luck.need, 3)}`,
		durabilityEfficiency: `M6: ${tierName(B.durability.tier)}, ${num(B.durability.need, 3)}`,
	};
	const fmtValue = { xp: (x) => `×${x}`, sell: (x) => `×${x}`, luck: (x) => `+${x}`, durabilityEfficiency: (x) => `${x}` };
	T['founder-resolve'] = mdTable(['Value', ...R.earlierSolves.map((e) => e.label), '5b.4 integrated (proposed)'], Object.keys(fmtValue).map((k) => [
		{ xp: 'XP multiplier', sell: 'Sell multiplier', luck: 'Private Luck', durabilityEfficiency: 'Durability efficiency' }[k],
		...R.earlierSolves.map((e) => `${fmtValue[k](e[k])} (${e.binding[k]})`),
		`**${fmtValue[k](S[k])}** (${bindingNow[k]})`,
	])) + `\n\nBinding case and its need (margin included) in brackets. Earlier columns are records (${R.earlierSolves.map((e) => e.source).join('; ')}).`;

	// ----- Current -> proposed -----
	const tp = td.profile;
	const rt = (t) => RARITIES.map((r) => num(t[r], 0)).join(' / ');
	T['founder-profile'] = mdTable(['Field', `Today (balance ${R.balanceVersionToday})`, 'Proposed', 'Rationale'], [
		['`competitiveEligible`', 'false', '**false**', 'Standing constraint: Founder catches stay out of every competitive board.'],
		['`rarityTable`', rt(tp.rarityTable), `**unchanged** (${rt(prof.rarityTable)})`, 'The per-fish rarity advantage is kept exactly (`P-FOUNDER-KEPT`).'],
		['`stats.fishingSpeed`', num(tp.stats.fishingSpeed, 2), `**${num(prof.stats.fishingSpeed, 2)} (kept)**`, `Cooldown ${num(firstTier.cooldownMs.founder / 1000, 2)} s on the Old Rod, ${num(lastTier.cooldownMs.founder / 1000, 2)} s from the top tiers (engine floor): ${range(R.power.map((p) => p.castsPerHour.founder), int)} casts/h against Normal's ${range(R.power.map((p) => p.castsPerHour.normal), int)}.`],
		['`stats.durabilityEfficiency`', num(tp.stats.durabilityEfficiency, 2), `**${num(prof.stats.durabilityEfficiency, 2)}** (M6)`, 'Needs the stochastic durability rule (framework `P-DURABILITY`).'],
		['`stats.luck`', tp.stats.luck ? num(tp.stats.luck, 2) : '—', `**+${num(prof.stats.luck, 2)}** (M5)`, `Private. Legendary/Lucky per fish (with pity) from ${range(R.power.map((p) => p.noLuck.perFish), (x) => pct(x, 1))} to ${range(R.power.map((p) => p.legendaryPlusPerFish), (x) => pct(x, 1))}.`],
		['`bonusDraws`', Object.entries(tp.bonusDraws).map(([n, p]) => `${n}: ${p}`).join(', '), '**unchanged**, now added to the rod\'s normal chain roll', `The Old Rod card is today's (mean ${num(R.visible[0].founder.mean, 2)} fish).`],
		['`limits`', `maxDraws ${tp.limits.maxDraws}, maxPerDraw ${tp.limits.maxPerDraw}`, `**maxDraws ${prof.limits.maxDraws} (= \`F.MULTI.maxFish\`), maxPerDraw ${prof.limits.maxPerDraw}**`, 'No cast a normal player could not also land (`P-FOUNDER-VISIBLE`).'],
		['`multipliers.xp`', `×${tp.multipliers.xp}`, `**×${prof.multipliers.xp}** (M2)`, 'Private; public output shows base.'],
		['`multipliers.sell`', `×${tp.multipliers.sell}`, `**×${prof.multipliers.sell}** (M4)`, 'Private, baked into each fish\'s stored `value`; `valueBase` stays the public amount.'],
		['`multipliers.questXp` / `questCash`', `×${tp.multipliers.questXp} / ×${tp.multipliers.questCash}`, `**×${prof.multipliers.questXp} / ×${prof.multipliers.questCash} (kept)**`, 'The quests design reads them (`P-FOUNDER-QUEST-MULT`).'],
		['`pity`', `Legendary+ ${pityText(td.pity.legendaryPlus)}; Lucky ${pityText(td.pity.lucky)}`, '**unchanged**', 'Worth more now: with a few draws per cast the counters actually build up.'],
		['`gacha.stats` / `gacha.pity`', `${statText(td.gachaStats)} / ${pityText(td.gachaPity.legendaryPlus)}`, '**unchanged**', 'Gacha on the new crates.'],
		['Lucky items', `${pct(LUCKY_ITEM_SHARE, 0)} of Lucky draws (${pct(R.luckyItems.itemPerDraw.founderBaseUnpinned, 2)} per Founder draw)`, `**pinned to the normal base table** (${pct(R.luckyItems.itemPerDraw.pinnedNormalBase, 5)} per draw)`, 'F0b; framework `P-LUCKY`.'],
		['Level shown in public', 'public level (shipped)', '**public level**', `Shipped in ${F1_COMMITS.main} (Public level).`],
		['Level that gates gameplay', 'real level', `**${PARAMS.publicLevel.gate} level**`, 'Framework `P-FOUNDER-GATE` (Level gate).'],
	]);
	T['founder-visible'] = mdTable(['Tier (home biome)', 'Normal P(1..5 fish)', 'Normal mean / P(3+) / P(5)', 'Founder P(1..5 fish)', 'Founder mean / P(3+) / P(5)', 'Legendary+ on the card N / F', 'Today\'s Founder fish/cast'], R.visible.map((v) => [
		`${tierName(v.tier)} (${v.biome})`, v.normal.dist.map((p) => num(p * 100, 1)).join(' / ') + '%', `${num(v.normal.mean, 2)} / ${pct(v.normal.p3plus)} / ${pct(v.normal.p5)}`,
		v.founder.dist.map((p) => num(p * 100, 1)).join(' / ') + '%', `**${num(v.founder.mean, 2)}** / ${pct(v.founder.p3plus, 0)} / ${pct(v.founder.p5, 0)}`, `${pct(v.normal.legendaryCardShare)} / ${pct(v.founder.legendaryCardShare)}`, num(v.todayFounderFishPerCast, 1),
	]));
	T['founder-luck'] = mdTable(['Tier', 'Legendary+/h ratio today', 'New, no private luck', `New, +${S.luck} luck`, `Cards with a Legendary+: no luck / +${S.luck}`, 'No luck vs today'], R.power.map((p) => {
		const v = R.visible.find((x) => x.tier === p.tier);
		return [tierName(p.tier), times(p.ratio.legendaryPlus.today, 0), times(p.noLuck.legendaryPlusRatio, 0), times(p.ratio.legendaryPlus.new, 0), `${pct(p.noLuck.legendaryCardShare)} / ${pct(v.founder.legendaryCardShare)}`, pct(p.noLuck.vsToday, 0)];
	})) + `\n\nPity adds a little on top (Legendary+ per hour with and without pity at ${tierName(lastTier.tier)}: ${num(lastTier.home.legendaryPlusPerHour.founder, 1)} and ${num(lastTier.home.legendaryPlusPerHour.founderNoPity, 1)}).`;
	T['founder-durability'] = mdTable(['Tier', 'Durability', 'Normal life', `Founder life, today's rule and ${TODAY.stats.durabilityEfficiency}`, `Founder life, proposed rule and ${S.durabilityEfficiency}`, 'Life ratio F/N: today\'s target / proposed', 'Durability per fish N / F', 'Upkeep share of income N / F'], R.upkeep.map((u) => [
		tierName(u.tier), int(u.maxDurability), hrs(u.lifeHours.normal), `${hrs(u.lifeHours.founderTodayRuleTodayEff)} (${times(u.lifeRatio.todayRuleTodayEff, 2)})`, hrs(u.lifeHours.founderProposed), `${times(u.lifeRatio.todayTarget, 2)} / **${times(u.lifeRatio.proposed, 2)}**`, `${num(u.durabilityPerFish.normal, 2)} / ${num(u.durabilityPerFish.founder, 2)}`, `${pct(u.upkeepShare.normal)} / ${pct(u.upkeepShare.founder, 4)}`,
	])) + '\n\nThe Old Rod is unbreakable (rods design): no row.';
	T['founder-lucky-items'] = mdTable(['', 'Founder, today\'s item rule (unpinned)', 'Founder, proposed (pinned)', `Normal ${tierName(li.topTier)}`], [
		[`Lucky item frequency (${tierName(li.topTier)}, ${F.DESIGN_OVERHEAD_S} s overhead)`, `1 per ${hrs(li.hoursPerLuckyItemTopTier.founderUnpinned)}`, `1 per ${hrs(li.hoursPerLuckyItemTopTier.founderPinned)}`, `1 per ${hrs(li.hoursPerLuckyItemTopTier.normal)}`],
		['Draws per hour', int(li.drawsPerHourTopTier.founder), int(li.drawsPerHourTopTier.founder), int(li.drawsPerHourTopTier.normal)],
	]) + `\n\nPinned: P(item | Lucky roll) = ${LUCKY_ITEM_SHARE} × normal base Lucky ÷ this draw's Lucky, so an item drops at ${pct(li.itemPerDraw.pinnedNormalBase, 5)} per draw for every profile, gear, bait or pity. The framework runs \`${li.frameworkRule}\` (\`P-LUCKY\`).`;

	// ----- Modelled results -----
	T['founder-power'] = mdTable(['Tier (biome)', 'Cooldown N / F', 'Casts/h N / F', 'XP/h: Normal / Founder base / final', '$/h: Normal / Founder base / final', 'XP ratio, 6 biomes (today)', '$ ratio, 6 biomes (today)', 'Worst case vs target: XP / $', 'Public (base) ratio XP / $', 'Fish/h ratio'], R.power.map((p) => [
		`${tierName(p.tier)} (${p.homeBiome})`, `${num(p.cooldownMs.normal / 1000, 2)} / ${num(p.cooldownMs.founder / 1000, 2)} s`, `${int(p.castsPerHour.normal)} / ${int(p.castsPerHour.founder)}`,
		`${compact(p.home.xpPerHour.normal)} / ${compact(p.home.xpPerHour.founderBase)} / **${compact(p.home.xpPerHour.founder)}**`, `${usd(p.home.cashPerHour.normal)} / ${usd(p.home.cashPerHour.founderBase)} / **${usd(p.home.cashPerHour.founder)}**`,
		`**${range([p.ratio.xp.min, p.ratio.xp.max], (x) => times(x, 0))}** (${range(p.ratio.xp.today, (x) => times(x, 1))})`, `**${range([p.ratio.cash.min, p.ratio.cash.max], (x) => times(x, 0))}** (${range(p.ratio.cash.today, (x) => times(x, 0))})`,
		`${times(p.ratio.xp.minOverTarget, 1)} / ${times(p.ratio.cash.minOverTarget, 1)}`, `${times(p.ratio.xpBase, 2)} / ${times(p.ratio.cashBase, 2)}`, times(p.ratio.fishPerHour, 2),
	])) + '\n\nBase = the Founder\'s catch without the profile multipliers (what the public sees); final = what the account receives. Worst case vs target: the smallest of the 36 biome × tier ratios over today\'s ratio.';
	const timeRows = [];
	for (const a of archetypes) {
		const levels = a === ref ? F.LIFECYCLE.milestones : F.LIFECYCLE.milestones.slice(-2);
		for (const lv of levels) {
			const x = time(a, lv);
			timeRows.push([cap(a), lv, hrs(x.todayFounder), hrs(x.newNormal), `${a === ref && lv === 50 ? '**' : ''}${hrs(x.founderReal.public)} / ${hrs(x.founderReal.real)}${a === ref && lv === 50 ? '**' : ''}`, `${hrs(x.founderPublic.public)} / ${hrs(x.founderPublic.real)}`]);
		}
	}
	T['founder-time'] = mdTable(['Player', 'Level', 'Today: Founder', 'New: Normal', 'New Founder, real level (public gate / real gate)', 'New Founder, public level (public gate / real gate)'], timeRows)
		+ `\n\nHours of play, integrated model (${L.model}). Every real-level milestone is at or under today's Founder time for every archetype and both gates: ${yes(R.checks.timeToLevelPreserved)}.`;
	T['founder-public-pace'] = mdTable(['Player', ...F.LIFECYCLE.milestones.map((lv) => `Lv ${lv}`)], archetypes.map((a) => [cap(a), ...F.LIFECYCLE.milestones.map((lv) => {
		const x = L.publicPace[a][lv];
		return x.speedup === null ? '—' : `${times(x.speedup, 1)} (${hrs(x.founderPublicHours)})`;
	})])) + '\n\nHow much sooner the Founder reaches each PUBLIC level than a normal player of the same archetype reaches that level (public gate; the Founder\'s public hours in brackets). Observers see levels, not play hours.';
	T['founder-day30'] = mdTable(['Player (hours)', 'Today: Founder', 'New: Normal', 'New: Founder (public gate)', 'New: Founder (real gate)', 'Real XP vs today\'s Founder', 'Money ÷ Normal: today → new'], archetypes.map((a) => {
		const d = L.day30[a];
		const f = (x) => `real Lv ${int(x.realLevel)} / public Lv ${int(x.publicLevel)}, ${compact(x.realXp)} XP, ${usd(x.money)}`;
		return [`${cap(a)} (${num(d.hours, 2)} h)`, d.today ? `Lv ${int(d.today.founder.level)}, ${compact(d.today.founder.xp)} XP, ${usd(d.today.founder.money)}` : '—', `Lv ${int(d.newNormal.level)}, ${usd(d.newNormal.money)}`, f(d.founderPublicGate), f(d.founderRealGate), d.xpVsToday ? `**${times(d.xpVsToday.ratio, 2)}**` : '—', d.moneyRatioToNormal ? `${times(d.moneyRatioToNormal.today, 0)} → **${times(d.moneyRatioToNormal.new, 0)}**` : '—'];
	})) + '\n\n30 calendar days on the integrated model (money = cash left after every purchase). Real levels look lower than today\'s only because the curve is steeper; compare XP.'
		+ (L.day30Money.length ? `\n\n**Below today's money ratio** (a sensitivity for the decision, not a proposal: the solved sell multiplier stays M4's):\n\n${mdTable(['Player', 'Gate', 'Founder money ÷ Normal: today → new', 'Fishing share of day-30 income: Normal / Founder', 'Sell to restore today\'s ratio', `Sell for today's × ${PARAMS.targets.margin}`], L.day30Money.map((x) => [cap(x.archetype), x.gate, `${times(x.todayRatio, 0)} → **${times(x.ratio, 0)}**`, `${pct(x.fishingShareOfIncome.normal)} / ${pct(x.fishingShareOfIncome.founder)}`, x.sellForToday ? `×${x.sellForToday}` : 'none found', x.sellForTodayWithMargin ? `×${x.sellForTodayWithMargin}` : 'none found']))}\n\nTrial sell multipliers on the Founder's casts; quests, boxes and buffs keep the proposed profile's.` : '');
	T['founder-afford'] = mdTable(['Tier set', 'Crate (price)', 'Crates N / F', 'Cost N / F', 'Normal: minutes of stage income', 'Founder: minutes', 'Today\'s Founder, same purchase'], R.afford.map((r) => [
		tierName(r.tier), `${r.crate} (${usd(r.price)})`, `${num(r.crates.normal, 2)} / ${num(r.crates.founder, 2)}`, `${usd(r.cost.normal)} / ${usd(r.cost.founder)}`, num(r.minutes.normal, 1), `**${num(r.minutes.founder, 2)}**`, r.minutes.todayFounder === null ? '—' : `${num(r.minutes.todayFounder, 2)}`,
	]));
	T['founder-crates'] = mdTable(['Crate', 'Crates to assemble N → F', 'P90 N → F', 'Legendary+ per slot N → F', 'Founder pity'], Object.entries(R.gacha.crates).map(([t, c]) => [
		`${tierName(t)} ${c.crate}`, `${num(c.crates.normal, 2)} → ${num(c.crates.founder, 2)}${Math.abs(c.founderCrateFactor - 1) > 0.005 ? ` (${num((c.founderCrateFactor - 1) * 100, 0)}%)` : ''}`, `${c.p90.normal} → ${c.p90.founder}`,
		c.legendaryPlusPerSlot.normal > 0 ? `${pct(c.legendaryPlusPerSlot.normal)} → ${pct(c.legendaryPlusPerSlot.founder)}` : '—', c.founderPity.length ? c.founderPity.join(', ') : 'none',
	]));
	const dec = L.decompositionRegular;
	T['founder-xp-sources'] = mdTable(['Public level', 'Real level', 'Account XP: fishing base / fishing profile bonus', 'Account XP: quests base / quest profile bonus', 'Account XP: buffs', 'Public XP: fishing / quests / daily / buffs'], numericKeys(dec).map((lv) => {
		const x = dec[lv];
		return [lv, int(x.realLevel), `${pct(x.account.fishingBase)} / ${pct(x.account.fishingProfileBonus)}`, `${pct(x.account.questsBase, 2)} / ${pct(x.account.questsProfileBonus, 2)}`, pct(x.account.buffs), `${pct(x.public.fishing)} / ${pct(x.public.quests)} / ${pct(x.public.daily)} / ${pct(x.public.buffs)}`];
	})) + '\n\nRegular Founder, public gate, integrated ledgers at each public milestone. Quests = story + repeatable, daily = daily + weekly quests (as R2 groups them); the account columns put daily with quests. Buffs = the Double XP bonus (public for everyone, `P-BUFFS-PUBLIC`).';

	// ----- Level gate -----
	const tellAt = (x) => (x ? `${hrs(x.hours)} (public Lv ${x.publicLevel}, real Lv ${x.realLevel}, ${x.biome})` : '—');
	T['founder-gate'] = mdTable(['Player', 'Gate', 'Hours fished above the public level', 'First', 'First on the top live biome', 'Ends', `Tier purchases T1–T${lastTier.tier} (hours)`], archetypes.flatMap((a) => gates.map((g) => {
		const t = g === 'real' ? L.tellWindowRealGating[a] : L.tellWindowPublicGating[a];
		const up = L.upgradesByArchetype[a][g];
		return [cap(a), g, hrs(t.hours), tellAt(t.firstAt), tellAt(t.topBiomeFirstAt), tellAt(t.lastAt), numericKeys(up).map((k) => num(up[k], 2)).join(' / ')];
	}))) + `\n\nIntegrated runs to public Lv ${F.LIFECYCLE.maxLevel}. Under the real gate (live today) the Founder fishes biomes and rod tiers above its public level; under the public gate it never does. A normal ${ref} player buys the same tiers at ${numericKeys(L.upgrades.normal).map((k) => num(L.upgrades.normal[k], 2)).join(' / ')} h.`;

	// ----- Integration -----
	const SD = R.integration.system;
	T['founder-system'] = mdTable(['Part', 'Contract'], [
		...Object.entries(SD.options).map(([k, v]) => [`option \`${k}\``, v]),
		...Object.entries(SD.hooks).map(([k, v]) => [`hook \`${k}\``, v]),
		['ledger sources', SD.ledger.sources], ['spend', SD.ledger.spend], ['reads', SD.reads], ['read by', SD.readBy], ['integration', SD.integration],
	]);
	T['founder-parity'] = mdTable(['Record', 'Value'], [
		['Source', `${PR.source}, commit \`${PR.commit}\``],
		['Method', PR.method],
		['Runs', `${PR.runs.founder} Founder (${PR.archetypes.length} archetypes × gates ${PR.gates.join(', ')}) + ${PR.runs.normal} Normal`],
		['Milestones (real and public) step-exact', `${PR.exactMilestones} of ${PR.milestonesCompared}`],
		['Tier upgrades step-exact', `${PR.exactUpgrades} of ${PR.upgradesCompared}`],
		['Public-tell points and hours identical', `${PR.tellPointsMatch} of ${PR.tellRuns} runs`],
		['XP and money at the stop', `${PR.stopTotalsCompared} runs compared`],
		['Largest relative difference', `${PR.maxRelativeDifference} (tolerance ${PR.tolerance})`],
	]);

	// ----- Checks -----
	const CHECK_TEXT = {
		xpRatioPreserved: 'M1: XP ratio at equal gear ≥ today\'s in every tier × biome',
		cashRatioPreserved: 'M3: $ ratio at equal gear ≥ today\'s in every tier × biome',
		timeToLevelPreserved: 'M2: real-level hours ≤ today\'s Founder, every archetype, both gates (integrated)',
		affordPreserved: 'M4: minutes to afford ≤ today\'s',
		legendaryPlusRatioPreserved: 'M5: Legendary+ per hour ratio ≥ today\'s at every tier',
		visibleWithinNormalMax: `Every visible cast is 1–${F.MULTI.maxFish} fish`,
		visibleMeanAtMostFour: 'Visible mean at most 4 at every tier (approved "~4 on strong casts")',
		legendaryCardShareWithinCap: `Public cards with a Legendary+ ≤ ${pct(PARAMS.plausibility.maxLegendaryCardShare)}`,
		normalCrateChainMatchesRods: 'The Normal crate chain reproduces rods.cratesDistribution() exactly',
		rodLifePreserved: 'M6: rod life ratio ≥ today\'s at every crafted tier',
		day30XpAndMoneyRatioPreserved: 'Day 30 (integrated): real XP ≥ today\'s Founder and money ÷ Normal ≥ today\'s, every archetype',
		competitiveEligibleFalse: 'Founder stays non-competitive',
		publicXpMatchesShippedDefinition: 'The model\'s public XP matches the shipped definition (Public level)',
		noPublicTellUnderPublicGate: 'Under the public gate the Founder never fishes above its public level (integrated)',
	};
	T['founder-checks'] = mdTable(['Check', 'Result'], Object.entries(R.checks).filter(([k]) => k !== 'pass').map(([k, v]) => [CHECK_TEXT[k] || k, v === true ? 'pass' : v === false ? '**fail**' : String(v)]))
		+ `\n\nPity model: today's measured Founder Old Rod Legendary+ per fish ${pct(R.pityModelCheck.todayFounderOldRodMeasuredPerFish, 2)}; the model predicts ${pct(R.pityModelCheck.modelWithPity, 2)} with pity (${pct(R.pityModelCheck.modelNoPity, 2)} without).`;
	return T;
}

module.exports = {
	PARAMS, DECISIONS, SYSTEM_NAME, RETIRED_LOOP_PARITY,
	founderProfile, profileWith, founderOutcome, normalOutcome, visibleDistribution, visibleFromChain, pityLegendaryPlus,
	founderCastOutcome, system, systemDescription,
	lifecycle, today, solve, gacha, founderCrates, publicLevelStatus, publicXpDefinition,
	report, markdownTables,
};

if (require.main === module) process.stdout.write(`${JSON.stringify(report(), null, 1)}\n`);
