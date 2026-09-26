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
//   publicLevelStatus()          F1 and every other public surface: what shipped (commit 14e27f1), what stays
//                                proposed and which public tells are open, with file:line read from src/
//   levelSites(), curveFloor()   the level read/write sites that need max(stored, curve) at the curve change, and
//                                what today's levels become on the new curve without a stored floor (MIG-2)
//   publicXpDefinition()         the model's public XP against the shipped definition (integrated ledgers)
//   detection(), oneReply()      PUBLIC TELLS: cards until an observer's likelihood ratio Founder : Normal reaches
//                                1000:1 (printed rarities, card colour, fish count, all; cadence threshold), for
//                                the proposed profile, without luck, today's live Founder and the stealth profile;
//                                and what one /stats, durability or /open reply shows (exact, no randomness)
//   STEALTH, stealthProfileWith() the stealth SENSITIVITY profile (P-FOUNDER-STEALTH option b)
//   solveMultipliers(make, opts) the sell and XP multipliers for a trial profile family against the same targets
//                                (M1-M4; M2 on integrated lifecycles); solve() uses it for the proposal
//   sensitivities()              no-luck and stealth multipliers, M5/M6 status, pace (never the proposal)
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
		// capped at the normal maximum (F.MULTI.maxFish), which removes today's tens-of-fish cards. It does NOT
		// make every card one a normal player can land: on the Old Rod a normal player lands exactly one fish
		// (check visibleCountFeasibleForNormal), and the kept rarity table shows on every card (detection()).
		bonusFish: { ...TODAY.bonusDraws },
	},
	targets: {
		// Headroom above the binding target, for every solved value ("err on the side of absurd").
		margin: 1.1,
		// Today's measured rod that stands for each gear-path step when ratios are compared at equal gear,
		// by the step's LEVEL (so any gear path maps: a step takes the last band at or below its level).
		// Where two rods bracket a band, the higher ratio is the target. On the 5b.4 rods path (steps at Lv 0,
		// 20, 30, 40, 50, 60) this is exactly the earlier per-tier map (todayRodOfTier()).
		todayRodByLevel: [
			{ level: 0, rods: ['Old Rod'] },
			{ level: 20, rods: ['Custom (Uncommon parts)'] },
			{ level: 30, rods: ['Custom (Rare parts)'] },
			{ level: 40, rods: ['Custom (Rare parts)', 'Custom (Legendary parts)'] },
			{ level: 50, rods: ['Custom (Legendary parts)'] },
		],
		// Time to afford: the two gear purchases that exist today (simulation.json stages). The new gear bought
		// at the same milestone is the highest gear-path step unlocked at the stage's level (purchaseTierOf()):
		// T1 and T2 on the 5b.4 rods path.
		todayPurchases: ['c20', 'c30'],
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
	cardShareCap: {
		// Luck is not displayed, but it raises the rarity every public card prints. The share of public catch
		// cards that show a Legendary or Lucky fish must stay at or below this cap. It is a cap on the solver,
		// NOT a plausibility bound: Normal's share is under 1% at every tier, and the cap never binds
		// (detection() measures how quickly the actual share identifies the Founder).
		maxLegendaryCardShare: 1 / 3,
	},
	// Lucky items (Booster Pack, Gold Rod Piece) come from a Lucky draw 20% of the time today, so the
	// Founder's Lucky table multiplies them. The framework's proposed P-LUCKY pins the item branch to the
	// NORMAL base table for every profile and every luck source; the Founder's extra Lucky mass becomes
	// Lucky fish.
	luckyItems: 'normal-base',
	publicLevel: {
		// SHIPPED (14e27f1): the publicXp field. PROPOSED: a stored publicLevel for EVERY account (no-demotion
		// floor at the curve change, like level; every level read and write site goes through max(stored, curve)).
		xpField: 'publicXp',
		levelField: 'publicLevel',
		// Recommended (framework P-FOUNDER-GATE): every gameplay level gate (biomes, permits, rod level cap,
		// shop, quests, level-scaled rewards) reads the PUBLIC level, so a public card never shows a biome or
		// rod tier above the public level (its count and rarities still differ: detection()). 'real' is the
		// alternative (and what is live today).
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

// Gear-path mapping to today's rods and purchases, by level (works on any F.gearPath()).
/** Today's measured rods a gear-path step (index or step) is compared with (PARAMS.targets.todayRodByLevel). */
function todayRodsOf(t) {
	const level = gear(t).level || 0;
	const bands = PARAMS.targets.todayRodByLevel.filter((b) => b.level <= level);
	return bands[bands.length - 1].rods;
}
/** { [tier index]: today's rods } for the current gear path (the earlier per-tier map on the 5b.4 rods path). */
const todayRodOfTier = () => Object.fromEntries(F.gearPath().map((t) => [t.tier, todayRodsOf(t)]));
/** The gear-path step bought at today's purchase stage (the highest step unlocked at its level). */
function purchaseTierOf(stage) {
	const level = SIMULATED.stages[stage].level;
	const steps = F.gearPath().filter((t) => t.level <= level);
	return steps[steps.length - 1].tier;
}

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

// SENSITIVITY ONLY (decision P-FOUNDER-STEALTH, option b; never the proposal): a Founder whose every public
// output is a normal player's at the same public level and gear. Normal rarity table, no bonus fish (the
// normal chain, so one fish on the Old Rod), normal cadence and durability (no fishing speed, no
// durability efficiency), no luck, no pity, normal box odds; every advantage is private: the XP and sell
// multipliers (solved by solveMultipliers() against the same targets) and today's quest multipliers.
// Nothing here is hand-set: the visible parts are PROFILES.normal's.
const STEALTH = deepFreeze({
	rarityTable: { ...PROFILES.normal.rarityTable },
	stats: { ...PROFILES.normal.stats },
	bonusFish: { 0: 1 },
	pity: PROFILES.normal.pity,
	gacha: PROFILES.normal.gacha,
});

/** The stealth sensitivity profile (STEALTH) with trial private multipliers. */
function stealthProfileWith({ xp = 1, sell = 1 } = {}) {
	return {
		name: 'founder',
		variant: 'stealth',
		competitiveEligible: false,
		rarityTable: { ...STEALTH.rarityTable },
		stats: { ...STEALTH.stats },
		bonusDraws: { ...STEALTH.bonusFish },
		multipliers: { xp, sell, questXp: TODAY.multipliers.questXp, questCash: TODAY.multipliers.questCash },
		limits: { maxDraws: F.MULTI.maxFish, maxPerDraw: 1 },
		pity: STEALTH.pity,
		gacha: STEALTH.gacha,
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
	if (p.variant === 'hybrid') return hybridOutcome(stage, { profile: p, overheadS });
	const tier = gear(stage?.tier ?? stage);
	const biome = stage?.biome || F.biomeAt(tier.level);
	const key = `${JSON.stringify([p.rarityTable, p.stats, p.multipliers, p.bonusDraws, p.limits, p.pity])}|${tierKey(tier)}|${biome}|${overheadS}`;
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
		// Before the private multipliers (every reward here is on the public card, so pre = base).
		xpPre: c.xpBase,
		valuePre: c.valueBase,
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
			xpPre: hourly.xpPre / n.hourly.xp,
			cashPre: hourly.valuePre / n.hourly.cash,
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

/** Qualities and rarity stats of today's measured rod (legacy crafted-rod stats through resolveModifiers). */
function todayRodInputs(rod) {
	let qualities = ['weak'];
	let stats = {};
	const names = MEASURED_ROD_PARTS[rod];
	if (names) {
		const list = names.map((n) => rods.CATALOG.find((p) => p.name === n));
		const m = resolveModifiers({ profile: { name: 'normal', ...PROFILES.normal }, rod: { name: rod, type: 'customrod', capabilities: rods.legacyCombine(list) }, rodParts: list });
		qualities = m.qualities;
		stats = { rareFind: m.stats.rareFind, luck: m.stats.luck, trophyChance: m.stats.trophyChance };
	}
	return { qualities, stats };
}

/** Today's NORMAL Legendary+ per fish, exact (legacy crafted-rod stats through resolveModifiers). */
const todayNormalCache = new Map();
function todayNormalLegendaryPlusPerFish(rod, biome) {
	const key = `${rod}|${biome}`;
	if (!todayNormalCache.has(key)) {
		const { qualities, stats } = todayRodInputs(rod);
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
	const targetOf = (t, pick) => maxOf(todayRodsOf(t).map((rod) => pick(T.byRod[rod])));

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

	// 1. Luck (not displayed, but it raises the rarity every public card prints): Legendary+ per hour ratio to
	//    Normal at equal gear (home biome) >= today's.
	const luckTarget = Object.fromEntries(tiers.map((t) => [t, targetOf(t, (r) => r.legendaryPlusPerHour.ratio)]));
	const luckRatio = (t, luck) => founderOutcome({ tier: t }, { profile: withEff({ luck }) }).ratio.legendaryPlus;
	const luckNeed = Object.fromEntries(tiers.map((t) => [t, luckRatio(t, 0) >= luckTarget[t] * margin ? 0 : bisect((x) => luckRatio(t, x) >= luckTarget[t] * margin, 0, 20)]));
	let luck = niceUp(maxOf(Object.values(luckNeed)), PARAMS.rounding.luckStep);
	// Card-share cap (not a plausibility bound): at most maxLegendaryCardShare of public cards show a Legendary+.
	const cardShare = (x) => maxOf(tiers.map((t) => founderOutcome({ tier: t }, { profile: withEff({ luck: x }) }).legendaryCardShare));
	const cap = PARAMS.cardShareCap.maxLegendaryCardShare;
	let luckCapped = false;
	if (cardShare(luck) > cap) {
		luck = Math.floor(bisect((x) => cardShare(x) > cap, 0, luck) / PARAMS.rounding.luckStep) * PARAMS.rounding.luckStep;
		luckCapped = true;
	}
	luck = round(luck, 4);

	// 2-3. Sell and XP (solveMultipliers(): M3/M4, then M1/M2 on integrated lifecycles).
	const make = ({ xp = 1, sell = 1 } = {}) => withEff({ luck, sell, xp });
	const m = solveMultipliers(make, {
		crateCost: (t) => founderCrates(t).founder.expectedCost,
		// While M2 runs, quests, streak and buffs read the profile solved so far (xp bound after the solve).
		provisional: (sell) => provisionalProfile(make({ sell })),
	});

	solveMemo = {
		durabilityEfficiency, effNeed, lifeTarget, luck, luckCapped, luckNeed, luckTarget, sell: m.sell, xp: m.xp,
		// What each value would be from one target family alone (the doc's "without M4" / "without M2").
		sellFromCashRatioOnly: m.sellFromCashRatioOnly, xpFromRatioOnly: m.xpFromRatioOnly,
		binding: { durability: Object.entries(effNeed).sort((a, b) => b[1] - a[1])[0], luck: Object.entries(luckNeed).sort((a, b) => b[1] - a[1])[0], ...m.binding },
		cashNeed: m.cashNeed, xpRatioNeed: m.xpRatioNeed, afford: m.afford, timeNeed: m.timeNeed,
		timeModel: m.timeModel,
	};
	return solveMemo;
}

/**
 * The private sell and XP multipliers for a trial profile family, against the same targets as solve():
 *   sell = the larger of M3 ($/h ratio at equal gear, every tier x biome >= today's x margin) and M4 (time to
 *          afford the tier sets bought at today's purchase milestones <= today's, with crateCost(t));
 *   xp   = the larger of M1 (XP/h ratio at equal gear) and M2 (hours of play to every real-level milestone <=
 *          today's Founder, every archetype, both gate options, on INTEGRATED lifecycles: integrate.run with the
 *          reference loop and the founder system casting with make({ sell, xp: trial }), until the real level
 *          reaches the maximum level); both rounded up (niceMultiplier).
 * @param make ({ xp, sell }) => a Founder cast profile (everything but the two multipliers fixed)
 * @param opts { crateCost: (tier) => expected cost of the tier set, provisional: (sell) => the profile other
 *   systems read while M2 runs (solve() only; a sensitivity runs after solve(), so they read the proposed one) }
 */
function solveMultipliers(make, { crateCost, provisional = null, gates = PARAMS.targets.gatingModes }) {
	const path = F.gearPath();
	const margin = PARAMS.targets.margin;
	const T = today();
	const tiers = path.map((t) => t.tier);
	const targetOf = (t, pick) => maxOf(todayRodsOf(t).map((rod) => pick(T.byRod[rod])));
	if (!provisional && !solveMemo) throw new Error(`${SYSTEM_NAME}: a sensitivity solve needs the proposed profile solved first (quests, streak and buffs read it)`);

	// Sell: (a) $/h ratio to Normal at equal gear, every tier x biome >= today's ratio (same biome);
	//       (b) time to afford the tier set bought at today's purchase milestones <= today's.
	const base = make({});
	const cashNeed = [];
	const xpRatioNeed = [];
	for (const t of tiers) {
		for (const biome of F.LIVE_BIOMES) {
			const fo = founderOutcome({ tier: t, biome }, { profile: base });
			const cashTarget = targetOf(t, (r) => r.biomes[biome].cashRatio);
			const xpTarget = targetOf(t, (r) => r.biomes[biome].xpRatio);
			cashNeed.push({ tier: t, biome, target: cashTarget, baseRatio: fo.ratio.cashPre, need: (cashTarget * margin) / fo.ratio.cashPre });
			xpRatioNeed.push({ tier: t, biome, target: xpTarget, baseRatio: fo.ratio.xpPre, need: (xpTarget * margin) / fo.ratio.xpPre });
		}
	}
	const afford = [];
	for (const stage of PARAMS.targets.todayPurchases) {
		const t = purchaseTierOf(stage);
		const tier = path[t];
		const st = SIMULATED.stages[stage];
		const prev = SIMULATED.stages[PARAMS.targets.todayStageBefore[stage]];
		const crate = BOX_CATALOG.find((b) => b.name === 'Fishing Crate');
		const todayCost = st.crates * crate.price;
		const biome = F.biomeAt(st.level);
		const todayIncome = todayRates(prev.founderMeasured || prev.measured, biome, 'founder').cashPerHour;
		const todayHours = todayCost / todayIncome;
		const newCost = crateCost(Number(t));
		const newBaseIncome = founderOutcome({ tier: path[t - 1], biome: F.biomeAt(tier.level) }, { profile: base }).hourly.valuePre;
		afford.push({ tier: Number(t), todayStage: stage, todayCost, todayIncomePerHour: todayIncome, todayMinutes: todayHours * 60, newCost, newBaseIncomePerHour: newBaseIncome, need: (newCost / (newBaseIncome * todayHours)) * margin });
	}
	const bindingCash = [...cashNeed].sort((a, b) => b.need - a.need)[0];
	const bindingAfford = [...afford].sort((a, b) => b.need - a.need)[0];
	const sell = niceMultiplier(Math.max(bindingCash.need, bindingAfford.need));

	// XP: (a) XP/h ratio to Normal at equal gear >= today's (every tier x biome); (b) M2 on integrated lifecycles.
	const bindingXpRatio = [...xpRatioNeed].sort((a, b) => b.need - a.need)[0];
	const timeNeed = [];
	if (provisional) solving = provisional(sell);
	try {
		for (const a of Object.keys(F.ARCHETYPES)) {
			const target = T.lifecycles[a]?.founderHours;
			if (!target) continue;
			for (const gating of gates) {
				const ok = (x) => {
					const hours = LC.milestoneHours(runIntegrated(a, { profile: make({ sell, xp: x }), gate: gating, horizon: 'real', cache: false }));
					return F.LIFECYCLE.milestones.every((L) => target[L] == null || (hours[L] != null && hours[L] <= target[L]));
				};
				const raw = smallestPassing(ok);
				timeNeed.push({ archetype: a, gating, need: raw * margin, raw });
			}
		}
	}
	finally {
		if (provisional) solving = null;
	}
	const bindingTime = [...timeNeed].sort((a, b) => b.need - a.need)[0];
	const xp = niceMultiplier(Math.max(bindingXpRatio.need, bindingTime.need));
	return {
		sell, xp,
		sellFromCashRatioOnly: niceMultiplier(bindingCash.need), xpFromRatioOnly: niceMultiplier(bindingXpRatio.need),
		binding: { cash: bindingCash, afford: bindingAfford, xpRatio: bindingXpRatio, xpTime: bindingTime },
		cashNeed, xpRatioNeed, afford, timeNeed,
		timeModel: `integrate.run (${INTEGRATE().REFERENCE.join(', ')} + founder), until the real level reaches the maximum level`,
	};
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
// Production scale of the shipped publicXp migration (its production run, as recorded in decisions.js).
const F1_PRODUCTION = deepFreeze({ accountsInitialised: 2 });
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
/** 1-based line of the first line of src/<rel> matching re, or null (file:line evidence read at render time). */
function srcLine(rel, re) {
	const i = srcText(rel).split('\n').findIndex((l) => re.test(l));
	return i < 0 ? null : i + 1;
}
/** "src/<rel>:<line>" for the first line matching re (or a visible "not found"). */
const srcRef = (rel, re) => {
	const n = srcLine(rel, re);
	return n ? `src/${rel}:${n}` : `src/${rel} (**pattern not found**)`;
};
// A select-menu collector created without a user filter (any member's click reaches it).
const UNFILTERED_COLLECTOR = /createMessageComponentCollector\(\{(?![^}]*filter)[^}]*\}\)/;
const PUBLIC_DEFER = /await interaction\.deferReply\(\);/;
/** The /biome select collector's lifetime as text (read from src/ at render time). */
function collectorSeconds() {
	const m = srcText('commands/slash/Fish/biome.js').match(/ComponentType\.StringSelect, time: (\d+)/);
	return m ? `${Number(m[1]) / 1000} s` : 'lifetime';
}

/**
 * Public surfaces and their status, read from src/ at report time (evidence, so the doc cannot claim a surface
 * is fixed when the code says otherwise): each surface, the level, amount or outcome it shows, whether that is
 * shipped, proposed or an open public tell, and where (file:line).
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
	const stats = srcText('commands/slash/User/stats.js');
	const collection = srcText('commands/slash/User/collection.js');
	const info = srcText('commands/slash/Info/info.js');
	const open = srcText('commands/slash/Economy/open.js');
	const gachaSrc = srcText('engine/gacha.js');
	const publicLevelSrc = srcText('engine/publicLevel.js');
	const publicDefer = /deferReply\(\)/.test(pagination);
	const paginated = (text) => /buttonPagination\(interaction/.test(text) && publicDefer;
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
		// Public tells beyond the level and money lines (adversarial review FND-2/3/4, C4, C5).
		fishCardRarityAndColour: /· \$\{f\.rarity\}/.test(fish) && /const catchColor/.test(fish) && PUBLIC_DEFER.test(fish),
		statsPerSpeciesPublic: /stats\.fishStats\.forEach/.test(stats) && paginated(stats),
		collectionPerSpeciesPublic: /\*\*Caught:\*\*/.test(collection) && paginated(collection),
		inventoryFishListPublic: /Fish\.getCount\(/.test(inventory) && paginated(inventory),
		castCountsSpecies: /stats\.fishStats\.\$\{/.test(cast),
		durabilityPublic: /equippedRod\?\.durability/.test(inventory) && /rod\.durability\}\/\$\{rod\.maxDurability\}/.test(info) && /interaction\.reply\(\{ embeds: \[embed\] \}\)/.test(info),
		openRevealPublic: PUBLIC_DEFER.test(open) && /function slotLine/.test(open) && /profile\.gacha\?\.stats/.test(gachaSrc) && /profile\.gacha\?\.pity/.test(gachaSrc),
		// Live bugs and edge cases (FND-5, MIG-3, EXP-6/FND-7).
		unfilteredSelectCollectors: ['commands/slash/Fish/biome.js', 'commands/slash/User/startQuest.js'].filter((f) => UNFILTERED_COLLECTOR.test(srcText(f))),
		publicXpIncCreatesField: /publicXp:\s*publicXpOfResult\(result\)/.test(cast) && /publicXp: \{ \$exists: false \} \}, \{ \$set/.test(publicLevelSrc),
		devProfileOverride: /if \(override && PROFILES\[override\]\) name = override;/.test(srcText('engine/balance.js')) && /const FOUNDER_MODES/.test(dev),
	};
	const shipped = (ok) => (ok ? `shipped (${F1_COMMITS.main})` : '**not found in src/**');
	const tell = (ok, decision) => (ok ? `**open public tell** (${decision})` : 'closed');
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
		{ surface: '`/fish` catch card: fish, rarity, colour, count, cadence (public reply)', shows: 'each fish\'s rarity (kept Founder table plus Luck), the colour of the best one, the fish count (Old Rod bonus fish), the time between cards (kept fishing speed)', status: tell(evidence.fishCardRarityAndColour, '`P-FOUNDER-STEALTH`; Detection'), where: [srcRef('commands/slash/Fish/fish.js', /· \$\{f\.rarity\}/), srcRef('commands/slash/Fish/fish.js', /const catchColor/), srcRef('commands/slash/Fish/fish.js', PUBLIC_DEFER)].join(', ') },
		{ surface: '`/stats` (public reply)', shows: 'lifetime count of every species (each species has one rarity) and fish caught per rod', status: tell(evidence.statsPerSpeciesPublic && evidence.castCountsSpecies, '`P-FOUNDER-SURFACES`; One reply'), where: [srcRef('commands/slash/User/stats.js', /stats\.fishStats\.forEach/), srcRef('commands/slash/User/stats.js', /Fish Caught: /), srcRef('engine/cast.js', /stats\.fishStats\.\$\{/), srcRef('buttonPagination.js', PUBLIC_DEFER)].join(', ') },
		{ surface: '`/collection` (public reply)', shows: '"Caught: N" for every species', status: tell(evidence.collectionPerSpeciesPublic && evidence.castCountsSpecies, '`P-FOUNDER-SURFACES`; One reply'), where: srcRef('commands/slash/User/collection.js', /\*\*Caught:\*\*/) },
		{ surface: '`/inventory` fish list (public reply)', shows: 'held fish per species under per-rarity headings', status: tell(evidence.inventoryFishListPublic, '`P-FOUNDER-SURFACES`; One reply'), where: srcRef('commands/slash/User/inventory.js', /Fish\.getCount\(/) },
		{ surface: 'Rod durability: `/inventory` rod line and `/info rod` (public replies)', shows: 'durability / max durability and repairs left; every normal rod loses exactly 1 per fish', status: tell(evidence.durabilityPublic, '`P-FOUNDER-SURFACES`; One reply'), where: [srcRef('commands/slash/User/inventory.js', /equippedRod\?\.durability/), srcRef('commands/slash/Info/info.js', /rod\.durability\}\/\$\{rod\.maxDurability\}/), srcRef('commands/slash/Info/info.js', /interaction\.reply\(\{ embeds: \[embed\] \}\)/), srcRef('engine/modifiers.js', /durabilityCostPerFish:/)].join(', ') },
		{ surface: '`/open` box reveal (public reply)', shows: 'every slot\'s rarity, rolled with the Founder gacha stats and gacha pity', status: tell(evidence.openRevealPublic, '`P-FOUNDER-SURFACES`; One reply'), where: [srcRef('commands/slash/Economy/open.js', PUBLIC_DEFER), srcRef('commands/slash/Economy/open.js', /function slotLine/), srcRef('engine/gacha.js', /profile\.gacha\?\.stats/), srcRef('engine/gacha.js', /profile\.gacha\?\.pity/)].join(', ') },
		{ surface: 'Any future level leaderboard', shows: 'public level, competitive (Normal-profile) accounts only', status: 'proposed (`P-FOUNDER-SURFACES`)', where: 'none yet' },
	];
	return { commits: F1_COMMITS, evidence, surfaces, storedPublicLevel: evidence.schemaPublicLevel };
}

// The level read and write sites that must go through max(stored, curve) at the curve change (framework
// P-CURVE-EXISTING, P-FOUNDER-PUBLIC-LEVEL; adversarial review MIG-2). Line numbers are read from src/ at render time.
const LEVEL_SITES = [
	{ site: 'cast.js: level before the cast', file: 'engine/cast.js', re: /const levelBefore = user\.level/, today: 'the stored `level`', change: 'max(stored level, curve(xp))' },
	{ site: 'cast.js: level after the cast', file: 'engine/cast.js', re: /const levelAfter = levelForXp\(/, today: '`levelForXp(xp + gain)` (100·L²)', change: 'max(stored level, curve(xp + gain))' },
	{ site: 'cast.js: public level before', file: 'engine/cast.js', re: /const publicBefore = levelForXp\(/, today: '`levelForXp(publicXp)`', change: 'max(stored publicLevel, curve(publicXp))' },
	{ site: 'cast.js: public level after (the card\'s "Level up!")', file: 'engine/cast.js', re: /const publicAfter = levelForXp\(/, today: '`levelForXp(publicXp + gain)`', change: 'max(stored publicLevel, curve(publicXp + gain)); a level-up only above the floor' },
	{ site: 'cast.js: level write in the commit', file: 'engine/cast.js', re: /^\s*level: result\.level\.after,/, today: '`$set level` = the cast\'s level after', change: 'writes the max (never lower); also writes `publicLevel` the same way' },
	{ site: 'User.getLevel()', file: 'class/User.js', re: /return levelForXp\(await this\.getXP\(\)\)/, today: 'derived from `xp` (100·L²)', change: 'max(stored level, curve(xp))' },
	{ site: 'User.getXPToNextLevel()', file: 'class/User.js', re: /level \*\* 2 \* 100/, today: 'hard-coded 100·L²', change: 'the new curve, from the displayed level' },
	{ site: 'publicLevel.js: public level (getPublicLevel)', file: 'engine/publicLevel.js', re: /const publicLevelOf = /, today: '`levelForXp(min(publicXp, xp))`, derived on read', change: 'max(stored publicLevel, curve(min(publicXp, xp)))' },
	{ site: 'publicLevel.js: publicProgressOf', file: 'engine/publicLevel.js', re: /function publicProgressOf/, today: 'hard-coded 100·L²', change: 'the new curve, from the displayed public level' },
	{ site: 'dev.js: /dev xp add | set', file: 'engine/dev.js', re: /level: levelForXp\(newXp\)/, today: '`level = levelForXp(newXp)`', change: '`add`: max(stored, curve); `set`: may demote, explicitly and audited' },
	{ site: 'balance.js: the curve', file: 'engine/balance.js', re: /^function levelForXp/, today: 'floor(0.1·√xp) (100·L²)', change: 'the new curve; the freeze anchors on max(stored level, today\'s levelForXp(xp)), since every gate and display today derives the level from XP' },
];
function levelSites() {
	return LEVEL_SITES.map((x) => ({ site: x.site, where: srcRef(x.file, x.re), found: srcLine(x.file, x.re) !== null, today: x.today, change: x.change }));
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
// Public tells: what an observer can see (adversarial review FND-1/2/3/4, C4, C5). An observer who knows both
// profiles compares what the Founder's public replies show with what a normal player on the SAME rod (no bait)
// would show, and multiplies the likelihood ratio Founder : Normal. castsToProof() is the number of cards (or
// box opens) until that ratio reaches DETECTION.target, with the Founder producing the observations: an exact
// dynamic programme over the log-ratio (no randomness). Founder pity is left out of both the observations and
// the observer's model (pity only adds Legendary+), so every figure is conservative: a real Founder is
// identified at least this fast.
const DETECTION = deepFreeze({ target: 1000, gridNats: 0.005, floorNats: -60, maxObservations: 5000 });

/** Grid index of a log-ratio (Infinity stays Infinity: an observation a normal player can never produce). */
const gridOf = (llr) => (llr === Infinity ? Infinity : Math.round(llr / DETECTION.gridNats));
/** Adds p at grid index k of a Map. */
const addAt = (m, k, p) => m.set(k, (m.get(k) || 0) + p);
/** Convolution of two grid distributions (Map index -> p). */
function convolve(a, b) {
	const out = new Map();
	for (const [ka, pa] of a) for (const [kb, pb] of b) addAt(out, ka === Infinity || kb === Infinity ? Infinity : ka + kb, pa * pb);
	return out;
}

/**
 * Observations until the likelihood ratio reaches DETECTION.target: { median, p90, never }. `increments` is the
 * per-observation distribution of the log-ratio as a grid Map (index -> probability under the Founder); never =
 * the Founder's observations have exactly a normal player's distribution.
 */
function castsToProof(increments) {
	const live = [...increments].filter(([, p]) => p > 0);
	if (live.every(([k]) => k === 0)) return { median: null, p90: null, never: true };
	const top = Math.ceil(Math.log(DETECTION.target) / DETECTION.gridNats - 1e-9);
	const lo = Math.floor(DETECTION.floorNats / DETECTION.gridNats);
	const size = top - lo;
	const steps = live.filter(([k]) => k !== Infinity);
	let cur = new Float64Array(size);
	cur[-lo] = 1;
	const out = { median: null, p90: null, never: false };
	for (let c = 1; c <= DETECTION.maxObservations && out.p90 === null; c++) {
		const next = new Float64Array(size);
		for (let i = 0; i < size; i++) {
			const q = cur[i];
			if (q < 1e-300) continue;
			for (const [k, p] of steps) if (i + k < size) next[Math.max(0, i + k)] += q * p;
		}
		cur = next;
		let alive = 0;
		for (let i = 0; i < size; i++) alive += cur[i];
		if (out.median === null && 1 - alive >= 0.5 - 1e-9) out.median = c;
		if (1 - alive >= 0.9 - 1e-9) out.p90 = c;
	}
	return out;
}

/**
 * What one catch card tells the observer, Founder vs Normal on the same rod. pF / pN: per-draw rarity
 * probabilities (no pity); drawsF / drawsN: P(d draw lines on the card); fishPerDrawF / N: fish per draw line
 * (1 under the proposal; today's crafted rods put 2-5 fish of one species on a line). The card prints every
 * line's rarity and fish count and takes the colour of the best rarity.
 * Returns the per-draw KL divergence (nats) and castsToProof() for: the printed rarities alone, the card colour
 * alone (7 colours), the Legendary+ colours alone (Legendary+ card or not), the fish count alone, and everything
 * on the card (count plus rarities); plus the Legendary+ card share of each.
 */
function cardEvidence({ pF, pN, drawsF, drawsN, fishPerDrawF = 1, fishPerDrawN = 1 }) {
	const perDraw = new Map();
	for (const r of RARITIES) if (pF[r] > 0) addAt(perDraw, gridOf(pN[r] > 0 ? Math.log(pF[r] / pN[r]) : Infinity), pF[r]);
	const kl = RARITIES.reduce((s, r) => s + (pF[r] > 0 ? pF[r] * Math.log(pF[r] / pN[r]) : 0), 0);
	const fishF = new Map();
	const fishN = new Map();
	drawsF.forEach((p, d) => p > 0 && addAt(fishF, d * fishPerDrawF, p));
	drawsN.forEach((p, d) => p > 0 && addAt(fishN, d * fishPerDrawN, p));
	const countLlr = (fish) => (fishN.get(fish) > 0 ? Math.log(fishF.get(fish) / fishN.get(fish)) : Infinity);
	const rarity = new Map();
	const all = new Map();
	const count = new Map();
	let power = new Map([[0, 1]]);
	for (let d = 1; d < drawsF.length; d++) {
		power = convolve(power, perDraw);
		if (!(drawsF[d] > 0)) continue;
		const c = gridOf(countLlr(d * fishPerDrawF));
		addAt(count, c, drawsF[d]);
		for (const [k, p] of power) {
			addAt(rarity, k, p * drawsF[d]);
			addAt(all, c === Infinity || k === Infinity ? Infinity : c + k, p * drawsF[d]);
		}
	}
	// Card colour = the best rarity among the card's draw lines: P(best <= r | d) = CDF(r)^d.
	const cdf = (p) => {
		let acc = 0;
		return RARITIES.map((r) => (acc += p[r] || 0));
	};
	const best = (c, draws) => RARITIES.map((r, i) => draws.reduce((s, q, d) => s + (d > 0 && q > 0 ? q * (c[i] ** d - (i ? c[i - 1] ** d : 0)) : 0), 0));
	const bF = best(cdf(pF), drawsF);
	const bN = best(cdf(pN), drawsN);
	const colour = new Map();
	bF.forEach((p, i) => p > 0 && addAt(colour, gridOf(bN[i] > 0 ? Math.log(p / bN[i]) : Infinity), p));
	const top = RARITIES.map((r, i) => (lplus({ [r]: 1 }) > 0 ? i : -1)).filter((i) => i >= 0);
	const shareF = sum(top.map((i) => bF[i]));
	const shareN = sum(top.map((i) => bN[i]));
	const legendaryColour = new Map();
	addAt(legendaryColour, gridOf(Math.log(shareF / shareN)), shareF);
	addAt(legendaryColour, gridOf(Math.log((1 - shareF) / (1 - shareN))), 1 - shareF);
	return {
		klPerDraw: kl, legendaryCardShare: { founder: shareF, normal: shareN },
		rarity: castsToProof(rarity), colour: castsToProof(colour), legendaryColour: castsToProof(legendaryColour),
		count: castsToProof(count), all: castsToProof(all),
	};
}

/** Card evidence for a (trial) Founder profile at a gear-path tier (home biome), against Normal on the same tier. */
function tierEvidence(t, profile) {
	const fo = founderOutcome({ tier: t }, { profile });
	const no = normalOutcome({ tier: t });
	return {
		tier: t, biome: fo.biome,
		...cardEvidence({ pF: fo.perDraw.rarity, pN: no.outcome.rarity, drawsF: fo.visible.dist, drawsN: F.fishDistribution(normalChance(gear(t))).dist }),
		cooldownMs: { founder: fo.cooldownMs, normal: fo.normal.cooldownMs },
	};
}

/** Today's live rods: draws per cast and fish per draw, Normal and Founder (engine rules, checked against measurements.json). */
function todayCardShape(rod) {
	const sc = MEASURED.results.find((r) => r.key.endsWith(`|${rod}|-|normal`));
	const caps = (sc?.rod?.capabilities || ['weak', '1']).map(String);
	const rodDraws = Number(caps.find((c) => /^\d+$/.test(c)) || 1);
	const rodCount = Number((caps.find((c) => /^\d+ count$/.test(c)) || '1 count').split(' ')[0]);
	const drawsN = new Array(TODAY.limits.maxDraws + 1).fill(0);
	drawsN[Math.min(PROFILES.normal.limits.maxDraws, rodDraws)] = 1;
	const drawsF = new Array(TODAY.limits.maxDraws + 1).fill(0);
	for (const [b, p] of Object.entries(TODAY.bonusDraws)) drawsF[Math.min(TODAY.limits.maxDraws, rodDraws + Number(b))] += p;
	const shape = { drawsN, drawsF, fishPerDrawN: Math.min(PROFILES.normal.limits.maxPerDraw, rodCount), fishPerDrawF: Math.min(TODAY.limits.maxPerDraw, rodCount) };
	// The engine rule must reproduce the measured fish per cast (1,000 casts per scenario).
	for (const profile of ['normal', 'founder']) {
		const rows = MEASURED.results.filter((r) => r.key.endsWith(`|${rod}|-|${profile}`));
		const measured = sum(rows.map((r) => r.units)) / sum(rows.map((r) => r.casts));
		const draws = profile === 'normal' ? shape.drawsN : shape.drawsF;
		const model = draws.reduce((s, p, d) => s + p * d, 0) * (profile === 'normal' ? shape.fishPerDrawN : shape.fishPerDrawF);
		if (Math.abs(model - measured) > 0.05 * measured) throw new Error(`${SYSTEM_NAME}: today's ${profile} card on ${rod}: model ${model} fish per cast, measured ${measured}`);
	}
	return shape;
}

// Today's rod -> the gear-path tier whose comparison it heads (its home biome is used for today's rows).
const todayRodTier = (rod) => Math.min(...Object.entries(todayRodOfTier()).filter(([, list]) => list[0] === rod).map(([t]) => Number(t)));

/** The fastest cooldown any normal reel the rods design allows can reach (its strongest reel stat x best variant). */
function normalCooldownFloorMs() {
	const reel = rods.PARAMS.slots.reel.fishingSpeed;
	const variantMax = Math.max(1, ...Object.values(rods.PARAMS.variants).map((v) => v.fishingSpeed ?? 1));
	const speed = Math.min(STAT_CAPS.fishingSpeed ? STAT_CAPS.fishingSpeed.max : 1, maxOf(Object.values(reel)) * variantMax);
	return Math.max(F.COOLDOWN.minMs, Math.round(F.COOLDOWN.fishMs * (1 - speed)));
}

let detectionMemo = null;
/**
 * Detection for the proposed profile at every gear-path tier, the same profile without luck (P-FOUNDER-LUCK's
 * alternative), the stealth sensitivity (P-FOUNDER-STEALTH option b) and today's live Founder on today's rods;
 * plus the cadence threshold (the click delay under which one interval between two cards is proof).
 */
function detection() {
	if (detectionMemo) return detectionMemo;
	const s = solve();
	const path = F.gearPath();
	const prof = founderProfile();
	const floorMs = normalCooldownFloorMs();
	const cadence = (founderMs, sameRodMs, anyMs) => ({ founderMs, sameRodMs, anyNormalMs: anyMs, delaySameRodS: (sameRodMs - founderMs) / 1000, delayAnyS: (anyMs - founderMs) / 1000 });
	const proposed = path.map((t) => {
		const e = tierEvidence(t.tier, prof);
		return { ...e, cadence: cadence(e.cooldownMs.founder, e.cooldownMs.normal, floorMs) };
	});
	const noLuck = path.map((t) => tierEvidence(t.tier, profileWith({ xp: s.xp, sell: s.sell, durabilityEfficiency: s.durabilityEfficiency })));
	const stealth = path.map((t) => tierEvidence(t.tier, stealthProfileWith({ xp: s.xp, sell: s.sell })));
	const measuredNormalFloorMs = minOf(MEASURED.results.filter((r) => r.profile === 'normal').map((r) => r.cooldownMs));
	const todayRows = TODAY_RODS.map((rod) => {
		const t = todayRodTier(rod);
		const biome = F.biomeAt(path[t].level);
		const { qualities, stats } = todayRodInputs(rod);
		const pN = F.castOutcome({ biome, qualities, stats, multiChance: 0 }).rarity;
		const pF = F.castOutcome({ biome, qualities, stats, multiChance: 0, table: TODAY.rarityTable }).rarity;
		const shape = todayCardShape(rod);
		const T = today();
		return { rod, biome, ...cardEvidence({ pF, pN, ...shape }), cadence: cadence(T.byRod[rod].cooldownMs.founder, T.byRod[rod].cooldownMs.normal, measuredNormalFloorMs), shape };
	});
	detectionMemo = { target: DETECTION.target, proposed, noLuck, stealth, today: todayRows, normalCooldownFloorMs: floorMs, measuredNormalFloorMs, stealthNever: stealth.every((x) => x.rarity.never && x.colour.never && x.count.never && x.all.never) };
	return detectionMemo;
}
/** Normal's Legendary+ card share across the gear path, as text (the card-share cap is set against it). */
const cardShareRangeText = () => range(F.gearPath().map((t) => normalOutcome({ tier: t.tier }).legendaryCardShare), (x) => pct(x, 1));

/** P(a cast's durability charge equals its fish count), i.e. P(the cast looks like a normal rod's), under `rule`. */
function chargeEqualsCount(dist, eff, rule) {
	return dist.reduce((s, q, n) => {
		if (!(n > 0 && q > 0)) return s;
		const x = n * (1 - eff);
		if (rule === 'stochastic') {
			const lo = Math.floor(x + 1e-12);
			const frac = x - lo;
			return s + q * ((lo === n ? 1 - frac : 0) + (lo + 1 === n ? frac : 0));
		}
		return s + q * (Math.max(1, Math.ceil(x - 1e-9)) === n ? 1 : 0);
	}, 0);
}
/** Casts until the durability lost differs from the fish caught on the rod (geometric: median, p90). */
const castsUntilMismatch = (q) => (q <= 0 ? { median: 1, p90: 1, never: false } : q >= 1 ? { median: null, p90: null, never: true } : { median: Math.max(1, Math.ceil(Math.log(0.5) / Math.log(q) - 1e-9)), p90: Math.max(1, Math.ceil(Math.log(0.1) / Math.log(q) - 1e-9)), never: false });
/** Opens until a box reveal proves the Founder (Legendary+ shown or not; steady-state rates, opens treated as independent). */
function opensToProof(pF, pN) {
	const m = new Map();
	addAt(m, gridOf(Math.log(pF / pN)), pF);
	addAt(m, gridOf(Math.log((1 - pF) / (1 - pN))), 1 - pF);
	return castsToProof(m);
}

let oneReplyMemo = null;
/**
 * Tells one public reply can prove (FND-3, FND-4, C5): the lifetime species counts of /stats, /collection and
 * the /inventory fish list (the rarity histogram of every fish caught), rod durability against the fish caught on
 * the rod (/inventory, /info rod, /stats per-rod count), and /open reveals. Proposed profile and today's.
 */
function oneReply() {
	if (oneReplyMemo) return oneReplyMemo;
	const s = solve();
	const prof = founderProfile();
	const D = detection();
	const ref = F.REFERENCE_ARCHETYPE;
	const path = F.gearPath();
	// Species counts: the regular Founder at public Lv 10 (public gate), on the Old Rod at the design cadence.
	const lc = lifecycle(ref, { profile: prof, gating: PARAMS.publicLevel.gate });
	const L10 = F.LIFECYCLE.milestones[0];
	const hours = lc.public[L10]?.hours ?? null;
	const old = founderOutcome({ tier: 0 }, { profile: prof });
	const oldToday = founderOutcome({ tier: 0 }, { profile: profileWith({ xp: TODAY.multipliers.xp, sell: TODAY.multipliers.sell }) });
	const n0 = normalOutcome({ tier: 0 });
	if (hours === null) throw new Error(`${SYSTEM_NAME}: the ${ref} Founder never reaches public Lv ${L10}`);
	const fish = hours * old.hourly.fish;
	const speciesRow = (fo, klPerDraw) => ({ legendaryPlusFounder: fish * fo.perDraw.legendaryPlus, legendaryPlusNormal: fish * lplus(n0.outcome.rarity), log10Ratio: (fish * klPerDraw) / Math.LN10, fishFor1000: Math.log(DETECTION.target) / klPerDraw });
	const species = {
		archetype: ref, publicLevel: L10, hours, fish, biome: old.biome,
		proposed: speciesRow(old, D.proposed[0].klPerDraw), today: speciesRow(oldToday, D.today[0].klPerDraw),
		castsProposed: D.proposed[0].rarity, castsToday: D.today[0].rarity,
	};
	// Durability: every normal rod loses exactly 1 per fish (efficiency 0), so before its first break
	// max - durability = fish caught on it (/stats prints fish caught per rod). The Old Rod is unbreakable
	// under the rods design (no proposed row).
	const upkeepRod = (t) => rods.craftRod(rods.referenceSet(t));
	const durability = {
		rule: F.RULES.durability,
		proposed: path.filter((t) => t.tier > 0).map((t) => {
			const fo = founderOutcome({ tier: t.tier }, { profile: prof });
			const q = chargeEqualsCount(fo.visible.dist, fo.stats.durabilityEfficiency || 0, F.RULES.durability);
			const maxDurability = upkeepRod(t.tier).maxDurability;
			return { tier: t.tier, perFish: { normal: 1, founder: fo.perCast.durability / fo.perCast.fish }, sameAsNormalPerCast: q, casts: castsUntilMismatch(q), fishPerRodLife: { normal: maxDurability, founder: maxDurability / (fo.perCast.durability / fo.perCast.fish) } };
		}),
		today: TODAY_RODS.map((rod) => {
			const shape = D.today.find((x) => x.rod === rod).shape;
			const fishDist = [];
			shape.drawsF.forEach((p, d) => {
				if (p > 0) fishDist[d * shape.fishPerDrawF] = (fishDist[d * shape.fishPerDrawF] || 0) + p;
			});
			const dist = Array.from({ length: fishDist.length }, (_, i) => fishDist[i] || 0);
			const q = chargeEqualsCount(dist, TODAY.stats.durabilityEfficiency, 'ceil');
			const T = today();
			return { rod, perFish: { normal: T.byRod[rod].durabilityPerFish.normal, founder: T.byRod[rod].durabilityPerFish.founder }, sameAsNormalPerCast: q, casts: castsUntilMismatch(q) };
		}),
		stealthNever: path.filter((t) => t.tier > 0).every((t) => {
			const fo = founderOutcome({ tier: t.tier }, { profile: stealthProfileWith({ xp: s.xp, sell: s.sell }) });
			return chargeEqualsCount(fo.visible.dist, fo.stats.durabilityEfficiency || 0, F.RULES.durability) >= 1 - 1e-12;
		}),
	};
	// Box reveals: today's boxes (P(open holds a Legendary+), Founder with its kept gacha stats and pity).
	const G = gacha();
	const boxes = Object.entries(G.boxes).map(([name, b]) => ({ box: name, normal: b.normalPerOpen, founder: b.founderWithPity, opens: opensToProof(b.founderWithPity, b.normalPerOpen) }));
	oneReplyMemo = { species, durability, boxes };
	return oneReplyMemo;
}

let sensitivityMemo = null;
/**
 * SENSITIVITIES for the user's decisions (never the proposal; the proposed values stay solve()'s): the private
 * multipliers solveMultipliers() needs, against the same targets, for
 *   noLuck   the proposed profile with luck 0 (P-FOUNDER-LUCK's alternative; durability efficiency kept);
 *   stealth  STEALTH (P-FOUNDER-STEALTH option b): every public output a normal player's.
 * Each on integrated lifecycles (integrate.run inside solveMultipliers; the other systems read the proposed
 * profile, as in solve()). Also what each variant leaves: M5 (Legendary+ per hour) and M6 (rod life) against
 * today's, which only visible stats can move, and the regular player's real and public pace.
 */
function sensitivities() {
	if (sensitivityMemo) return sensitivityMemo;
	const s = solve();
	const path = F.gearPath();
	const ref = F.REFERENCE_ARCHETYPE;
	const gate = PARAMS.publicLevel.gate;
	const families = {
		proposed: { make: ({ xp = 1, sell = 1 } = {}) => profileWith({ luck: s.luck, durabilityEfficiency: s.durabilityEfficiency, xp, sell }), solved: s },
		noLuck: { make: ({ xp = 1, sell = 1 } = {}) => profileWith({ luck: 0, durabilityEfficiency: s.durabilityEfficiency, xp, sell }), crateCost: (t) => founderCrates(t).founder.expectedCost },
		stealth: { make: ({ xp = 1, sell = 1 } = {}) => stealthProfileWith({ xp, sell }), crateCost: (t) => founderCrates(t).normal.expectedCost },
	};
	const normalRun = lifecycle(ref);
	const out = {};
	for (const [name, fam] of Object.entries(families)) {
		const m = fam.solved || solveMultipliers(fam.make, { crateCost: fam.crateCost });
		const profile = fam.make({ xp: m.xp, sell: m.sell });
		const m5 = path.map((t) => founderOutcome({ tier: t.tier }, { profile }).ratio.legendaryPlus / s.luckTarget[t.tier]);
		const m6 = path.filter((t) => t.tier > 0).map((t) => {
			const fo = founderOutcome({ tier: t.tier }, { profile });
			return ((fo.normal.durabilityPerCast * fo.normal.casts) / (fo.perCast.durability * fo.hourly.casts)) / s.lifeTarget[t.tier];
		});
		const run = lifecycle(ref, { profile, gating: gate });
		const L50 = 50;
		const fo1 = founderOutcome({ tier: 1 }, { profile });
		out[name] = {
			xp: m.xp, sell: m.sell,
			binding: { sell: m.binding.afford.need >= m.binding.cash.need ? `M4: T${m.binding.afford.tier}, ×${round(m.binding.afford.need, 2)}` : `M3: T${m.binding.cash.tier} ${m.binding.cash.biome}, ×${round(m.binding.cash.need, 2)}`, xp: m.binding.xpTime.need >= m.binding.xpRatio.need ? `M2: ${m.binding.xpTime.archetype}, ${m.binding.xpTime.gating} gate, ×${round(m.binding.xpTime.need, 2)}` : `M1: T${m.binding.xpRatio.tier} ${m.binding.xpRatio.biome}, ×${round(m.binding.xpRatio.need, 2)}` },
			sellFromCashRatioOnly: m.sellFromCashRatioOnly, xpFromRatioOnly: m.xpFromRatioOnly,
			luck: profile.stats.luck || 0, durabilityEfficiency: profile.stats.durabilityEfficiency || 0, fishingSpeed: profile.stats.fishingSpeed || 0,
			m5: { minOverTarget: minOf(m5), met: m5.every((x) => x >= 1 - 1e-9), worstTier: path[m5.indexOf(minOf(m5))].tier },
			m6: { minOverTarget: minOf(m6), met: m6.every((x) => x >= 1 - 1e-9) },
			cashRatioT1: fo1.ratio.cash, cashBaseRatioT1: fo1.ratio.cashBase,
			regular: { realL50: run.real[L50]?.hours ?? null, publicL50: run.public[L50]?.hours ?? null, normalL50: normalRun.real[L50]?.hours ?? null, upgrades: run.upgrades, level: L50 },
		};
	}
	out.normalUpgrades = normalRun.upgrades;
	sensitivityMemo = out;
	return sensitivityMemo;
}

/** MIG-2: today's levels on the new curve if the stored floor were missing (the level a cast or a gate would read). */
function curveFloor() {
	const biomes = Object.keys(F.BIOME_LEVEL).filter((b) => F.LIVE_BIOMES.includes(b));
	return F.LIFECYCLE.milestones.map((L) => {
		const xp = F.xpForLevel(L, { ...F.CURVE, quartic: 0 });
		if (levelForXpToday(xp) !== L) throw new Error(`${SYSTEM_NAME}: today's curve is not 100·L² (balance.js levelForXp)`);
		const newLevel = F.levelForXp(xp);
		return { level: L, xp, newLevel, lost: biomes.filter((b) => F.BIOME_LEVEL[b] > newLevel && F.BIOME_LEVEL[b] <= L) };
	});
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
		luck: `+${s.luck} Luck: the binding need rounded up to a ${PARAMS.rounding.luckStep} step. Binding: M5 (Legendary+ per hour ratio at equal gear ≥ today's × margin ${m}) at T${b.luck[0]}: +${round(b.luck[1], 3)}${s.luckCapped ? '; capped by the card-share cap' : ''}. Card-share cap: at most ${round(PARAMS.cardShareCap.maxLegendaryCardShare * 100, 1)}% of public cards show a Legendary+ (never binds; Normal's share is ${cardShareRangeText()}, so the cap is not a plausibility bound)`,
		durabilityEfficiency: `${s.durabilityEfficiency}: the binding need rounded up to a ${PARAMS.rounding.efficiencyStep} step. Binding: M6 (rod life in hours, Founder ÷ Normal ≥ today's × margin ${m}) at T${b.durability[0]}: ${round(b.durability[1], 3)}; never below today's, never above STAT_CAPS; needs P-DURABILITY`,
	}[id];
};
/**
 * Measured public-tell figures as text for the decision records and the headline (every number generated
 * from detection(), oneReply() and sensitivities(); nothing typed by hand).
 */
function tellText() {
	const D = detection();
	const O = oneReply();
	const casts = (rows, key) => `${range(rows.map((x) => x[key].median), int)} (p90 ${range(rows.map((x) => x[key].p90), int)})`;
	const fo0 = founderOutcome({ tier: 0 }, { profile: founderProfile() });
	const s = solve();
	const path = F.gearPath();
	const noLuck = profileWith({ xp: s.xp, sell: s.sell, durabilityEfficiency: s.durabilityEfficiency });
	return {
		rarity: casts(D.proposed, 'rarity'),
		colour: casts(D.proposed, 'colour'),
		legendaryColour: casts(D.proposed, 'legendaryColour'),
		legendaryColourNoLuck: casts(D.noLuck, 'legendaryColour'),
		rarityNoLuck: casts(D.noLuck, 'rarity'),
		all: casts(D.proposed, 'all'),
		oldRodCount: casts([D.proposed[0]], 'count'),
		oldRodMulti: pct(1 - fo0.visible.pOne, 0),
		cadence: range(D.proposed.map((x) => x.cadence.delayAnyS), (x) => `${num(x, 2)} s`),
		statsFish: int(O.species.proposed.fishFor1000),
		durabilityPerFish: range(O.durability.proposed.map((x) => x.perFish.founder), (x) => num(x, 2)),
		// Card shares with pity, as in the Luck table (detection() leaves pity out).
		share: range(path.map((t) => founderOutcome({ tier: t.tier }, { profile: founderProfile() }).legendaryCardShare), (x) => pct(x, 1)),
		shareNoLuck: range(path.map((t) => founderOutcome({ tier: t.tier }, { profile: noLuck }).legendaryCardShare), (x) => pct(x, 1)),
		shareNormal: range(path.map((t) => normalOutcome({ tier: t.tier }).legendaryCardShare), (x) => pct(x, 1)),
		boxOpens: range(O.boxes.map((x) => x.opens.median), int),
	};
}

/** What the proposed luck adds per tier (home biome): base $/h and base XP/h over the same profile without luck. */
function luckGains() {
	const s = solve();
	const prof = founderProfile();
	const nl = profileWith({ xp: s.xp, sell: s.sell, durabilityEfficiency: s.durabilityEfficiency });
	return F.gearPath().map((t) => {
		const fo = founderOutcome({ tier: t.tier }, { profile: prof });
		const fn = founderOutcome({ tier: t.tier }, { profile: nl });
		return { tier: t.tier, cashBaseGain: fo.hourly.valueBase / fn.hourly.valueBase - 1, xpBaseGain: fo.hourly.xpBase / fn.hourly.xpBase - 1, legendaryPlusRatio: fo.ratio.legendaryPlus };
	});
}

const DECISIONS = [
	{
		id: 'P-FOUNDER-VISIBLE', status: 'proposed',
		title: 'Founder visible catch: today\'s bonus-fish distribution added to the rod\'s normal multi-catch roll, the total capped at the normal maximum; one fish per draw. The cap limits the count; it does not make the cards look normal',
		get modelled() {
			return `bonus fish ${Object.entries(PARAMS.visible.bonusFish).map(([n, p]) => `${n}: ${p}`).join(', ')}; limits maxDraws ${F.MULTI.maxFish} (= F.MULTI.maxFish), maxPerDraw 1 (today ${TODAY.limits.maxDraws} / ${TODAY.limits.maxPerDraw})`;
		},
		alternatives: ['today\'s limits (tens of fish on one card: a public tell)', 'a smaller bonus (fewer visible fish; more private compensation)', 'no cap (casts a normal player can never land)', 'cap the visible count at what a normal player can land at the Founder\'s public level and gear: one fish on the Old Rod, i.e. below public Lv 20 under the public gate (not sized on its own; the stealth option of P-FOUNDER-STEALTH is the full version: Stealth)'],
		source: 'founder design; adversarial review C4',
		get why() {
			const t = tellText();
			return `the cap removes today's tens-of-fish cards (approved direction A-FOUNDER-VISIBLE, "~4 on strong casts"); the Old Rod card is today's. It does not make every card one a normal player can land: on the Old Rod a normal player lands exactly one fish, while ${t.oldRodMulti} of Founder Old Rod cards show 2–${F.MULTI.maxFish} (Visible catch; check visibleCountFeasibleForNormal), and the kept rarity table shows on every card (Detection)`;
		},
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
			return `margin ×${PARAMS.targets.margin}; rod map by level ${PARAMS.targets.todayRodByLevel.map((x) => `Lv ${x.level}+ = ${x.rods.join(' / ')}`).join('; ')} (on the current gear path: ${Object.entries(todayRodOfTier()).map(([t, r]) => `${t === '0' ? 'Old Rod' : `T${t}`} = ${r.join(' / ')}`).join('; ')}); purchases ${PARAMS.targets.todayPurchases.map((st) => `${st} = T${purchaseTierOf(st)}`).join(', ')}; gates ${PARAMS.targets.gatingModes.join(' and ')}; rounding ×${PARAMS.rounding.smallStep} below ×${PARAMS.rounding.largeFrom}, ×${PARAMS.rounding.largeStep} above, luck and efficiency ${PARAMS.rounding.luckStep}`;
		},
		alternatives: ['no margin (exactly today\'s values)', 'ratio targets only (drops M2 time-to-level and M4 time-to-afford: much smaller multipliers, a slower Founder than today)'],
		source: 'founder design', why: 'the approved direction (A-FOUNDER-VISIBLE: private multipliers preserve effective power) keeps the Founder\'s effective power "absurd"; M1-M6 are this design\'s proposed reading of it. The steeper curve and the repriced gear are compensated like the lost visible volume (Targets)',
		get: () => ({ margin: PARAMS.targets.margin, todayRodByLevel: PARAMS.targets.todayRodByLevel, todayPurchases: PARAMS.targets.todayPurchases, gatingModes: PARAMS.targets.gatingModes, rounding: PARAMS.rounding }),
		expected: {
			margin: 1.1,
			todayRodByLevel: [{ level: 0, rods: ['Old Rod'] }, { level: 20, rods: ['Custom (Uncommon parts)'] }, { level: 30, rods: ['Custom (Rare parts)'] }, { level: 40, rods: ['Custom (Rare parts)', 'Custom (Legendary parts)'] }, { level: 50, rods: ['Custom (Legendary parts)'] }],
			todayPurchases: ['c20', 'c30'],
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
		source: 'founder design (solve())', why: 'the steeper curve and the capped visible volume both slow the Founder; the proposed time-to-level target M2 (P-FOUNDER-TARGETS, under the approved direction of decision 5) absorbs both (Targets; Hours to each level)',
		get: () => founderProfile().multipliers.xp, expected: 45,
	},
	{
		id: 'P-FOUNDER-SELL', status: 'proposed',
		title: 'Private sell multiplier (solved; baked into each fish\'s stored value; valueBase stays public)',
		get modelled() {
			return solvedRow('sell');
		},
		alternatives: ['today\'s ×10', 'the M3 ratio-only value (drops the time-to-afford target: repriced gear takes the Founder longer to buy than today)'],
		source: 'founder design (solve())', why: 'gear was repriced upwards like the curve was steepened; the proposed targets (P-FOUNDER-TARGETS) compensate the Founder for both (Targets; Time to afford)',
		get: () => founderProfile().multipliers.sell, expected: 55,
	},
	{
		id: 'P-FOUNDER-LUCK', status: 'proposed',
		title: 'Founder Luck (solved). Not displayed, but a stat with a public effect: it raises the rarity every catch card prints and the card\'s colour. A Legendary+ card-share cap applies and never binds',
		get modelled() {
			return solvedRow('luck');
		},
		get alternatives() {
			const t = tellText();
			const n = sensitivities().noLuck;
			return [
				`luck 0: M5 (Legendary+ per hour at equal gear ≥ today's) fails, the lowest tier at ${pct(n.m5.minOverTarget, 0)} of today's ratio (Luck); the card tell barely shrinks (printed rarities ${t.rarityNoLuck} casts instead of ${t.rarity}; Legendary+ colour ${t.legendaryColourNoLuck} instead of ${t.legendaryColour}: Detection); sell re-solves to ×${n.sell} (${n.binding.sell}) and XP to ×${n.xp} (${n.binding.xp}) (Stealth)`,
				'deliver the same value through the sell and XP multipliers instead: that works for money and XP, not for M5, which is collection pace (Legendary species caught per hour); choosing luck 0 means deciding that collection pace is not "power"',
			];
		},
		source: 'founder design D2 (solve()); adversarial review FND-1',
		get why() {
			const s = solve();
			const g = luckGains();
			const t = tellText();
			const t1 = g.find((x) => x.tier === 1);
			return `M5 binds at T${s.binding.luck[0]}, and one global value overshoots every lower tier (T1: ${times(t1.legendaryPlusRatio, 0)} against today's ${times(s.luckTarget[1], 0)}: Luck). Luck adds ${range(g.map((x) => x.cashBaseGain), (x) => pct(x, 0))} to base $/h and ${range(g.map((x) => x.xpBaseGain), (x) => pct(x, 0))} to base XP/h, but what it targets, Legendary+ per hour, is public (cards, /stats, /collection): the Legendary+ card share rises from ${t.shareNoLuck} to ${t.share}, against Normal's ${t.shareNormal} (Luck; Detection)`;
		},
		get: () => ({ luck: founderProfile().stats.luck ?? 0, maxLegendaryCardShare: PARAMS.cardShareCap.maxLegendaryCardShare }),
		expected: { luck: 0.6, maxLegendaryCardShare: 1 / 3 },
	},
	{
		id: 'P-FOUNDER-DURABILITY-EFF', status: 'proposed',
		title: 'Founder durability efficiency (solved), under the stochastic durability rule',
		get modelled() {
			return solvedRow('durabilityEfficiency');
		},
		alternatives: ['today\'s efficiency under today\'s max(1, ceil) rule (Founder rods wear out faster per hour than a normal player\'s: Durability)', 'efficiency 0: durability looks like a normal rod\'s and the repair cost is paid through the sell multiplier (the stealth option of P-FOUNDER-STEALTH; M6 then fails: Stealth)'],
		source: 'founder design D5 (solve()); adversarial review FND-3',
		get why() {
			return `the Founder casts faster, so under today's rule its rods would last fewer hours than Normal's; this keeps rod life at or above today's ratio (Durability). Durability is public (/inventory, /info rod): every normal rod loses exactly 1 per fish, the Founder ${tellText().durabilityPerFish} per fish, so one reply next to the rod's fish count (/stats) proves the profile (One reply)`;
		},
		get: () => founderProfile().stats.durabilityEfficiency, expected: 0.85,
	},
	{
		id: 'P-FOUNDER-KEPT', status: 'proposed',
		title: 'Kept from today\'s profile: rarity table, fishing speed, pity, gacha stats and gacha pity; still non-competitive. These are the Founder\'s main public tells',
		modelled: 'read from src/engine/balance.js PROFILES.founder, never copied',
		alternatives: ['the normal rarity table, cadence, pity and box odds with the advantage paid privately: removes the rarity, colour, cadence and /open tells; its private multipliers are the stealth option of P-FOUNDER-STEALTH (Stealth)', 'raise them (visible, a tell)'],
		source: 'founder design; adversarial review FND-2',
		get why() {
			const t = tellText();
			return `per-fish rarity and cadence are part of today's Founder feel, and the quests, streak and buffs designs assume them. The cost is visibility: from the printed rarities alone an observer reaches 1000:1 after a median of ${t.rarity} casts, from the card colour ${t.colour}; one interval between two cards is proof when the Founder clicks within ${t.cadence} of its cooldown; box reveals show the kept gacha edge (Detection; One reply)`;
		},
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
		title: 'Public level fields: keep the shipped publicXp (base rewards only); at the curve change EVERY player\'s public level gets a stored no-demotion floor (publicLevel), like level under framework P-CURVE-EXISTING, and every level read and write goes through max(stored, curve)',
		modelled: 'publicXp: shipped (14e27f1): base catch XP (gear, bait, buffs, events) + base quest XP, never a profile bonus. Shipped public level: derived on read with today\'s 100·L² curve (publicLevel.js publicLevelOf); there is no stored public level. Proposed: publicLevel written for every account at the curve change (today\'s-curve level of publicXp; the level floor itself anchors on max(stored level, today\'s curve(xp))); from then on public level = max(stored publicLevel, curve(publicXp)). Every level read and write site goes through max(stored, curve): cast.js level before and after, public level before and after, the level write; User.getLevel and getXPToNextLevel; publicLevelOf and publicProgressOf; dev.js xp (Level sites, file:line). The core tracks exactly that rule (lifecycles start new players, so the floor never binds in the model)',
		get alternatives() {
			const c = curveFloor().find((x) => x.lost.length > 1) || curveFloor()[curveFloor().length - 1];
			return [`derive the public level on read only (as shipped): at the curve change every member's public level drops while the real level does not (public levels demoted; real and public levels diverge for normal players), and with P-FOUNDER-GATE = public every member's gate level drops with it (Curve floor: today's Lv ${c.level} lands at Lv ${c.newLevel} and loses ${c.lost.join(' and ')})`, 'under P-CURVE-EXISTING\'s rescale alternative: rescale publicXp with xp and keep deriving on read (no new field)'];
		},
		source: 'founder design F1 (approved direction A-PUBLIC-LEVEL); framework P-CURVE-EXISTING; adversarial review MIG-2',
		why: 'the steeper curve maps today\'s XP to lower levels and levels never drop. The floor is not a Founder field: without it the first cast after the change writes the lower new-curve level for every member, and P-FOUNDER-GATE is "identical for normal players" only with it (Public level; Level sites; Curve floor)',
		get: () => ({ xpField: PARAMS.publicLevel.xpField, levelField: PARAMS.publicLevel.levelField }),
		expected: { xpField: 'publicXp', levelField: 'publicLevel' },
	},
	{
		id: 'P-FOUNDER-SURFACES', status: 'proposed',
		title: 'Public surfaces: every public surface shows the public level; /fishing-stats (ephemeral) both levels; future level leaderboards the public level of competitive accounts only. The catch card, /stats, /collection, the /inventory fish list, rod durability (/inventory, /info rod) and /open reveals stay public and show the Founder\'s kept rarity table, luck, durability efficiency and gacha luck',
		modelled: 'shipped (14e27f1): /fish level-ups, /profile, /inventory level line, /fishing-stats. Open public tells that no fix addresses: the catch card (rarity, colour, count, cadence), /stats and /collection (lifetime count per species), the /inventory fish list, rod durability, /open reveals (Public level surfaces, file:line; Fix first F2-F2d). Proposed: any future level leaderboard',
		alternatives: ['make /stats, /collection, /inventory, /info rod and /open replies ephemeral for everyone (like P-FOUNDER-WALLET): closes the one-reply tells, not the catch-card tells', 'accept them explicitly (P-FOUNDER-STEALTH option a)', 'the stealth profile (P-FOUNDER-STEALTH option b) makes every one of them a normal player\'s', 'show the real level on the owner\'s own public replies (a tell)'],
		source: 'founder design F1; adversarial review FND-3, FND-4, C5',
		get why() {
			const t = tellText();
			return `a public card never shows a private bonus, and the owner sees both levels privately. The per-species counts, durability and box reveals are not bonuses but outcomes of the kept visible stats, and they are public: one /stats or /collection reply after about ${t.statsFish} fish is 1000:1, and box reveals reach it after a median of ${t.boxOpens} opens of today's boxes (One reply)`;
		},
	},
	{
		id: 'P-FOUNDER-WALLET', status: 'proposed',
		title: 'Wallet privacy: /balance and the money lines of /inventory become ephemeral for every player; inventory value uses the stored public value (valueBase)',
		modelled: 'not a model value: a presentation rule (the Founder\'s money is private-multiplied). If /inventory is split rather than made ephemeral, its level line, fish list and rod line stay public; the fish list and rod line are open tells of their own (P-FOUNDER-SURFACES)',
		alternatives: ['a public money field for the Founder (like publicXp)', 'hide money for the Founder only (itself a tell)', 'accept the tell'],
		source: 'founder design D4', why: 'the /inventory Balance and Inventory value lines and /balance show the Founder\'s real, private-multiplied money in public replies today (Fix first)',
	},
	{
		id: 'P-FOUNDER-DEV-GRANTS', status: 'proposed',
		title: 'Developer XP grants move xp and publicXp together (publicXp never above xp), both audited',
		modelled: 'default scope \'both\' (shipped 14e27f1: set applies the same value, add the same delta, publicXp clamped to [0, xp], audit stores both)',
		alternatives: ['a scope option real | public for one-field corrections (design stage; not shipped)'],
		source: 'founder design F1', why: 'an admin correction never makes a normal player\'s public level diverge from their level (the /dev founder override can: P-FOUNDER-DEV-OVERRIDE)',
		get: () => PARAMS.publicLevel.devGrantDefaultScope, expected: 'both',
	},
	{
		id: 'P-FOUNDER-DEV-OVERRIDE', status: 'proposed',
		title: 'The /dev founder override (shipped, developer-only, audited) stays a test tool, recorded as a second path to the Founder profile; optional hardening listed',
		modelled: 'not a model value. Shipped (Phase 3): resolveProfile lets devOverrides.profile win over FOUNDER_IDS (balance.js), and /dev founder on | off | test | default sets it on any account, audited (dev.js); FOUNDER_IDS itself is never changed (Fix first F5)',
		alternatives: ['force competitiveEligible false for every FOUNDER_IDS account whatever its override (today switching a real Founder "off" makes its catches competitive-eligible while it holds gear and wealth earned as the Founder)', 'allow "on" only for FOUNDER_IDS accounts, or map an override on any other account to the test profile', 'getGateLevel() returns the public level only when resolveProfile(...).name === "founder" and the real level otherwise, so an override\'s publicXp gap never lowers a normal account\'s gates; or record that it does'],
		source: 'adversarial review EXP-6, FND-7',
		why: 'while an account is overridden to the Founder profile its casts add xp at the profile multiplier and publicXp at base; after "default" the gap stays (publicXpOf = min(publicXp, xp)), so that account\'s public level stays below its real level for good. That contradicts "publicXp = xp for normal profiles" and, under P-FOUNDER-GATE, lowers its gates. Developers can already grant money, XP and items, so this is a corner case of an audited tool, not a new grant capability',
	},
	{
		id: 'P-FOUNDER-MIGRATION', status: 'proposed',
		title: 'Migrations stay additive and idempotent: publicXp as shipped (plus a small follow-up fix); at the curve change a stored publicLevel for every account (with P-CURVE-EXISTING\'s freeze); at the gate change the existing Founder\'s current biome is moved inside its gate level; existing Founder fish keep their stored value',
		modelled: 'publicXp: shipped (14e27f1: accounts without it get xp minus every profile bonus in their applied cast journals, three result shapes; members get publicXp = xp); two edge cases do not heal (Fix first F4). Proposed: publicLevel = today\'s-curve level of publicXp, written for every account where missing, before the new curve applies. At the gate change (P-FOUNDER-GATE): every FOUNDER_IDS account whose currentBiome is above the highest biome its gate (public) level allows is moved to that biome, guarded and idempotent, before the new gate applies; otherwise its next /fish fails the gate (the world design\'s BIOME_LOCKED guard) on the public "No catch" card. New catches use the new sell multiplier, stored fish values are never rewritten; PROFILES.founder is code (a BALANCE_VERSION bump), not player data',
		alternatives: ['recompute stored Founder fish values at the new multiplier (rewrites player documents)', 'leave the Founder\'s current biome as it is (its first /fish after the gate change shows the failure publicly)'],
		source: 'founder design; adversarial review FND-6, MIG-3',
		why: 'no player document is rewritten beyond guarded, idempotent steps; running any step twice is a no-op. The lifecycles start new accounts, so the existing Founder account\'s switch to the public gate (and the one-time drop of its rod stats to the level cap of its public level) is not modelled (Migrations)',
	},
	{
		id: 'P-FOUNDER-STEALTH', status: 'proposed',
		title: 'How visible the Founder is: (a) accept the catch-card, count, cadence, durability, /stats and /open tells as the price of "not power" (the current proposal), or (b) a stealth profile whose every public output is a normal player\'s at the same public level and gear, with all compensation private',
		get modelled() {
			const t = tellText();
			const st = sensitivities().stealth;
			return `(a) is what the model runs (the other P-FOUNDER-* entries): an observer reaches 1000:1 after a median of ${t.rarity} casts from the printed rarities and ${t.all} from everything on the card (Detection). (b) is a sensitivity only, solved on the same targets with integrated lifecycles: XP ×${st.xp} (${st.binding.xp}), sell ×${st.sell} (${st.binding.sell}), quest multipliers kept (Stealth)`;
		},
		get alternatives() {
			const st = sensitivities().stealth;
			return [
				`(b) stealth: normal rarity table, normal visible count (one fish on the Old Rod, so below public Lv 20), normal cadence and durability, luck 0, no pity, normal box odds; XP ×${st.xp}, sell ×${st.sell}. M5 (Legendary+ per hour) and M6 (rod life) cannot be met privately; the public level and world access advance at a normal player's pace (regular: public Lv ${st.regular.level} after ${num(st.regular.publicL50, 2)} h against ${num(st.regular.normalL50, 2)} h); no card, durability, /stats or /open tell remains (Detection; One reply); what remains is account-level: money where it is still shown (P-FOUNDER-WALLET), how soon gear is bought, and absence from competitive boards (Stealth)`,
				'(a) with the one-reply surfaces made ephemeral (P-FOUNDER-SURFACES): the catch-card tells remain',
				'(a) with luck 0 (P-FOUNDER-LUCK): the printed-rarity tell is almost unchanged (Detection)',
			];
		},
		source: 'founder design; adversarial review FND-1, FND-2, FND-3, FND-4, C4, C5',
		get why() {
			const t = tellText();
			return `decision 5 accepted "not power" without a stated cost in visibility. With the kept rarity table, Luck and cadence the Founder is identifiable within a few cards, one /stats or /collection reply is conclusive, and ${t.oldRodMulti} of its Old Rod cards are impossible for a normal player (Detection; One reply). Hiding it completely means a Founder that looks normal everywhere and is ahead only privately (Stealth)`;
		},
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

	// Visible distribution and Legendary+ card share per tier (home biome).
	const visible = path.map((t) => {
		const fo = founderOutcome({ tier: t.tier }, { profile: prof });
		const nd = F.fishDistribution(normalChance(t));
		return {
			tier: t.tier, key: t.key, level: t.level, biome: fo.biome,
			normal: { dist: nd.dist.slice(1).map((p) => round(p, 4)), mean: round(nd.mean, 3), p3plus: round(nd.p3plus, 4), p5: round(nd.p5, 4), legendaryCardShare: round(fo.normal.legendaryCardShare, 4) },
			founder: { dist: fo.visible.dist.slice(1).map((p) => round(p, 4)), mean: round(fo.visible.mean, 3), pOne: round(fo.visible.pOne, 4), p3plus: round(fo.visible.p3plus, 4), p5: round(fo.visible.p5, 4), legendaryCardShare: round(fo.legendaryCardShare, 4) },
			todayFounderFishPerCast: round(T.byRod[todayRodsOf(t)[0]].fishPerCast.founder, 2),
		};
	});

	// New power per tier: home biome detail + all-biome ranges of the ratios.
	const power = path.map((t) => {
		const fo = founderOutcome({ tier: t.tier }, { profile: prof });
		const all = F.LIVE_BIOMES.map((b) => founderOutcome({ tier: t.tier, biome: b }, { profile: prof }));
		const tgtXp = F.LIVE_BIOMES.map((b) => maxOf(todayRodsOf(t).map((rod) => T.byRod[rod].biomes[b].xpRatio)));
		const tgtCash = F.LIVE_BIOMES.map((b) => maxOf(todayRodsOf(t).map((rod) => T.byRod[rod].biomes[b].cashRatio)));
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
			// Decision P-FOUNDER-LUCK alternative: the same profile without luck (and what luck adds to base $/h and XP/h).
			noLuck: { legendaryPlusRatio: round(nl.ratio.legendaryPlus, 1), vsToday: round(nl.ratio.legendaryPlus / s.luckTarget[t.tier], 3), legendaryCardShare: round(nl.legendaryCardShare, 4), perFish: round(nl.pity.perFish, 4), cashBaseGain: round(fo.hourly.valueBase / nl.hourly.valueBase - 1, 4), xpBaseGain: round(fo.hourly.xpBase / nl.hourly.xpBase - 1, 4) },
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
			const todayL = maxOf(todayRodsOf(t).map((rod) => T.byRod[rod].legendaryPlusPerHour.founder));
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
		legendaryPlusRatioPreserved: s.luckCapped ? 'capped by the card-share cap' : power.every((p) => p.ratio.legendaryPlus.new >= p.ratio.legendaryPlus.today),
		visibleWithinNormalMax: visible.every((v) => v.founder.dist.length === F.MULTI.maxFish),
		// Adversarial review C4: every count the Founder shows must be one a normal player can land on the same rod.
		visibleCountFeasibleForNormal: visible.every((v) => v.founder.dist.every((p, i) => !(p > 0) || v.normal.dist[i] > 0)),
		visibleMeanAtMostFour: visible.every((v) => v.founder.mean <= 4),
		legendaryCardShareWithinCap: visible.every((v) => v.founder.legendaryCardShare <= PARAMS.cardShareCap.maxLegendaryCardShare + 1e-9),
		normalCrateChainMatchesRods: Object.values(G.crates).every((c) => c.normal.matchesRods),
		rodLifePreserved: upkeep.every((u) => u.lifeRatio.proposed >= u.lifeRatio.todayTarget),
		day30XpAndMoneyRatioPreserved: Object.values(day30).every((d) => !d.today || (d.xpVsToday.ratio >= 1 && d.moneyRatioToNormal.new >= d.moneyRatioToNormal.today)),
		competitiveEligibleFalse: prof.competitiveEligible === false,
		publicXpMatchesShippedDefinition: definition.matchesShipped,
		noPublicTellUnderPublicGate: archetypes.every((a) => founderLc.public[a].tell.hours === 0),
	};
	checks.pass = Object.values(checks).every((v) => v === true || v === 'capped by the card-share cap');

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
		publicLevel: { status, definition, levelSites: levelSites(), curveFloor: curveFloor() },
		// Public tells and the visibility sensitivities (P-FOUNDER-STEALTH, P-FOUNDER-LUCK, P-FOUNDER-SURFACES).
		detection: detection(),
		oneReply: oneReply(),
		sensitivities: sensitivities(),
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
	const lo = fmt(Math.min(...xs));
	const hi = fmt(Math.max(...xs));
	return lo === hi ? lo : `${lo}–${hi}`;
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
	const failing = Object.entries(R.checks).filter(([k, v]) => k !== 'pass' && v !== true && v !== 'capped by the card-share cap').map(([k]) => k);
	const openTells = P1.status.surfaces.filter((x) => /open public tell/.test(x.status));

	// ----- Summary -----
	const TT = tellText();
	const SE = R.sensitivities;
	const ev = P1.status.evidence;
	T['founder-headline'] = mdTable(['Figure', 'Value', 'Table'], [
		['Visible fish per cast (Founder)', `${range(R.visible.map((v) => v.founder.mean), (x) => num(x, 2))} from the Old Rod to T${lastTier.tier}, every cast 1–${F.MULTI.maxFish} fish (today up to ${int(TODAY.limits.maxDraws * TODAY.limits.maxPerDraw)})`, 'Visible catch'],
		['Proposed private profile (solved at 5b.4)', `XP ×${S.xp}, sell ×${S.sell}, Luck +${S.luck}, durability efficiency ${S.durabilityEfficiency}; quests ×${prof.multipliers.questXp} / ×${prof.multipliers.questCash} kept`, 'Current → proposed; Targets'],
		['XP/h at equal gear, Founder ÷ Normal', `${range(R.power.flatMap((p) => [p.ratio.xp.min, p.ratio.xp.max]), (x) => times(x, 0))} (today ${range(R.power.flatMap((p) => p.ratio.xp.today), (x) => times(x, 1))})`, 'Per tier'],
		['$/h at equal gear, Founder ÷ Normal', `${range(R.power.flatMap((p) => [p.ratio.cash.min, p.ratio.cash.max]), (x) => times(x, 0))} (today ${range(R.power.flatMap((p) => p.ratio.cash.today), (x) => times(x, 0))})`, 'Per tier'],
		['Regular Founder, hours to real Lv 50 (integrated)', `${hrs(time(ref, 50).founderReal.public)} (public gate) / ${hrs(time(ref, 50).founderReal.real)} (real gate); today ${hrs(time(ref, 50).todayFounder)}`, 'Hours to each level'],
		['Regular Founder, hours to public Lv 50 (public gate)', `${hrs(time(ref, 50).founderPublic.public)}, against ${hrs(time(ref, 50).newNormal)} for a normal regular player`, 'Hours to each level; Public pace'],
		['Public tell (fishing above the public level)', `none under the public gate; under the real gate ${range(archetypes.map((a) => L.tellWindowRealGating[a].hours), hrs)} of play`, 'Level gate'],
		['F1 public level', `shipped (${F1_COMMITS.main}) for the /fish level-up, /profile, the /inventory level line and /fishing-stats; the model's public XP ${P1.definition.matchesShipped ? 'matches' : '**differs from**'} the shipped definition`, 'Public level'],
		['Open public tells', openTells.length ? openTells.map((x) => x.surface.replace(/`/g, '').replace(/ \(public repl(y|ies)\)$/, '')).join('; ') : 'none', 'Fix first; Public level'],
		['Detection (proposed profile, same rod as a normal player)', `1000:1 likelihood after a median of ${TT.rarity} casts from the printed rarities, ${TT.colour} from the card colour, ${TT.oldRodCount} from an Old Rod fish count; one /stats or /collection reply after about ${TT.statsFish} fish`, 'Detection; One reply'],
		['Stealth alternative (sensitivity, `P-FOUNDER-STEALTH` b)', `XP ×${SE.stealth.xp}, sell ×${SE.stealth.sell}; no card, durability, /stats or /open tell; M5 and M6 not met; regular public Lv ${SE.stealth.regular.level} after ${hrs(SE.stealth.regular.publicL50)} (Normal ${hrs(SE.stealth.regular.normalL50)})`, 'Stealth'],
		['Live production bug (fix first)', ev.unfilteredSelectCollectors.length ? `${ev.unfilteredSelectCollectors.map((x) => `/${x.split('/').pop().replace('.js', '').replace('startQuest', 'start-quest')}`).join(' and ')}: any member's click acts on the invoker's account (F3)` : 'none found', 'Fix first'],
		['Design checks', failing.length ? `**${failing.length} fail:** ${failing.join(', ')}` : `all ${Object.keys(R.checks).length - 1} pass`, 'Checks'],
		['Retired private loop', `system() matched it exactly: ${PR.exactMilestones}/${PR.milestonesCompared} milestones step-exact (${PR.commit})`, 'Retired-loop parity'],
	]);

	// ----- Decisions -----
	T['founder-decisions'] = `${mdTable(['ID', 'Proposed decision', 'Modelled', 'Alternatives', 'Why', 'Record = model'], DECISIONS.map((d) => [
		`\`${d.id}\``, d.title, d.modelled, d.alternatives.join('; '), d.why,
		d.get ? yes(same(d.get(), d.expected)) : 'n/a (not a model value)',
	]))}\n\nStatus of every entry: \`${[...new Set(DECISIONS.map((d) => d.status))].join(', ')}\`. Only the user approves; \`decisions.js\` joins these to the Phase 5B registry, alongside the framework entries this design relies on (\`P-FOUNDER-GATE\`, \`P-DURABILITY\`, \`P-LUCKY\`), and \`check-shared.js\` verifies each record against the model.`;

	// ----- Fix first -----
	const li = R.luckyItems;
	const OR = R.oneReply;
	const DT = R.detection;
	const src = (rel, re) => srcRef(rel, re).replace(/^src\/(?:[^/]+\/)*([^/]+)$/, '$1');
	T['founder-fix-first'] = mdTable(['#', 'Public tell', 'Evidence (src/, read at render time)', 'Status', 'Fix'], [
		['F0', 'The Founder badge: `/profile` puts "👑 Founder" in the title when the Founder views its own profile, and the reply is public (`buttonPagination` defers without an ephemeral flag)', ev.profileFounderBadgeInPublicReply ? 'profile.js title; buttonPagination.js `deferReply()`' : 'not found', ev.profileFounderBadgeInPublicReply ? '**open**' : 'closed', 'Remove the badge from the public embed (`/fishing-stats` already shows it privately); regression test: the public `/profile` embed never contains the profile name'],
		['F0b', `Lucky items: today's Founder catches ${num(li.founderTodayPerHour.boosterPacksOldRod, 1)} Booster Packs per hour on the Old Rod and ${num(li.founderTodayPerHour.boosterPacksRareRod, 1)} on a Rare-parts rod (normal players: an Easter egg)`, 'measurements.json Founder scenarios; cast.js `drawTemplates`', li.frameworkRule === 'pinned' ? 'proposed (framework `P-LUCKY`, modelled)' : '**not modelled**', 'Pin the item branch to the normal base table for every profile (Lucky items)'],
		['F1', 'Level: public level-ups, `/profile` and `/inventory` levels came from the real (private-multiplied) level', [ev.castWritesPublicXp && 'cast.js writes publicXp', ev.fishCardPublicLevelUp && 'fish.js reads result.level.public', ev.migration && 'migrations.js migratePublicXp'].filter(Boolean).join('; ') || 'not found', ev.castWritesPublicXp && ev.fishCardPublicLevelUp && ev.profilePublicLevel && ev.inventoryPublicLevel ? `**shipped** (${F1_COMMITS.main}; ${F1_COMMITS.branch} on this branch)` : '**incomplete**', 'Done for these surfaces (Public level)'],
		['F1b', 'Money: `/inventory` "Balance" and "Inventory value" and `/balance` show the Founder\'s real money and final (private-multiplied) fish values in public replies', [ev.inventoryRealBalance && 'inventory.js Balance line', ev.inventoryFinalValue && 'User.getInventoryValue sums stored final values', ev.balanceCommandPublic && 'balance.js public reply'].filter(Boolean).join('; ') || 'not found', ev.inventoryRealBalance || ev.inventoryFinalValue || ev.balanceCommandPublic ? '**open**' : 'closed', '`P-FOUNDER-WALLET`: money lines ephemeral for everyone; inventory value from `valueBase`'],
		['F1c', 'Gates: biome access, quest start, shop and rod-part level checks read the real level, so a Founder fishes above its public level (Level gate)', ev.gatesReadRealLevel.length ? ev.gatesReadRealLevel.map((f) => f.split('/').pop()).join(', ') : 'none found', ev.gatesReadRealLevel.length ? '**open** (live today)' : 'closed', 'Framework `P-FOUNDER-GATE`: gates read the public level'],
		['F2', `Catch cards: every card prints each fish's rarity (kept Founder table plus Luck) and takes the colour of the best one; on the Old Rod a normal player lands one fish, the Founder 2–${F.MULTI.maxFish} on ${TT.oldRodMulti} of casts; cards can come faster than any normal reel allows (kept fishing speed)`, [src('commands/slash/Fish/fish.js', /· \$\{f\.rarity\}/), src('commands/slash/Fish/fish.js', /const catchColor/), src('commands/slash/Fish/fish.js', PUBLIC_DEFER)].join(', '), ev.fishCardRarityAndColour ? '**open** (live today; kept by the proposal)' : 'closed', `\`P-FOUNDER-STEALTH\`: accept (a) or the stealth profile (b). 1000:1 after a median of ${TT.rarity} casts from the rarities (Detection)`],
		['F2b', 'Species counts: `/stats` and `/collection` publish the lifetime count of every species, the `/inventory` fish list the held count; each species has one rarity, so one reply is the rarity histogram of every fish caught', [src('commands/slash/User/stats.js', /stats\.fishStats\.forEach/), src('commands/slash/User/collection.js', /\*\*Caught:\*\*/), src('commands/slash/User/inventory.js', /Fish\.getCount\(/), src('engine/cast.js', /stats\.fishStats\.\$\{/), src('buttonPagination.js', PUBLIC_DEFER)].join(', '), ev.statsPerSpeciesPublic || ev.collectionPerSpeciesPublic || ev.inventoryFishListPublic ? '**open** (live today)' : 'closed', `\`P-FOUNDER-SURFACES\`: make these replies ephemeral for everyone, or accept (\`P-FOUNDER-STEALTH\`). One reply is 1000:1 after about ${TT.statsFish} fish (One reply)`],
		['F2c', `Rod durability: every normal rod loses exactly 1 per fish, so before its first break max − durability = fish caught on it (\`/stats\` prints that per rod); the Founder loses ${TT.durabilityPerFish} per fish (today ${range(OR.durability.today.map((x) => x.perFish.founder), (x) => num(x, 2))})`, [src('commands/slash/User/inventory.js', /equippedRod\?\.durability/), src('commands/slash/Info/info.js', /rod\.durability\}\/\$\{rod\.maxDurability\}/), src('commands/slash/Info/info.js', /interaction\.reply\(\{ embeds: \[embed\] \}\)/), src('engine/modifiers.js', /durabilityCostPerFish:/)].join(', '), ev.durabilityPublic ? '**open** (live today)' : 'closed', '`P-FOUNDER-SURFACES` (ephemeral rod lines), or efficiency 0 (`P-FOUNDER-STEALTH` b; M6 then fails). One reply'],
		['F2d', `Box reveals: \`/open\` is public and rolls with the Founder gacha stats and pity (a Legendary+ in ${pct(OR.boxes.find((b) => b.box === 'Daily Box').founder, 1)} of Daily Box opens against ${pct(OR.boxes.find((b) => b.box === 'Daily Box').normal, 2)}); the new Streak Crate is opened the same way`, [src('commands/slash/Economy/open.js', PUBLIC_DEFER), src('commands/slash/Economy/open.js', /function slotLine/), src('engine/gacha.js', /profile\.gacha\?\.stats/)].join(', '), ev.openRevealPublic ? '**open** (live today)' : 'closed', 'Roll Founder reveals on the normal table and pay the edge privately (`P-FOUNDER-STEALTH` b), make `/open` ephemeral, or accept. One reply'],
		['F3', `Live bug: the \`/biome\` and \`/start-quest\` select collectors have no user filter, so any member who clicks the invoker's menu within its ${collectorSeconds()} switches the invoker's biome or starts a quest on the invoker's account (announced publicly with the clicker's name); while gates read the real level, a bystander also learns whether the Founder's real level reaches a biome's level`, [src('commands/slash/Fish/biome.js', UNFILTERED_COLLECTOR), src('commands/slash/Fish/biome.js', /setCurrentBiome\(/), src('commands/slash/User/startQuest.js', UNFILTERED_COLLECTOR), src('commands/slash/User/startQuest.js', /startQuest\(originalQuest\)/)].join(', '), ev.unfilteredSelectCollectors.length ? '**open** (live bug: fix first)' : 'closed', `Add \`filter: (i) => i.user.id === user.id\` to both collectors (or answer other clickers ephemerally), with a regression test; the proposed permit purchase must re-check the gate level of the account it charges. Optional cleanup: ${src('commands/slash/User/equip.js', /userData\.level < requirements\.level/)} reads \`userData.level\`, which the User wrapper never sets, so that level check never runs (no live effect: every rod has level requirement 0)`],
		['F4', 'Shipped `publicXp` hotfix, two edge cases that never heal: a cast on a document without `publicXp` creates the field through `$inc` from zero (a public level far below the real level) and the migration\'s `$exists` guard then skips it; casts served by the old instance during a deploy overlap are missing from `publicXp`', [src('engine/cast.js', /publicXp: publicXpOfResult\(result\)/), src('engine/publicLevel.js', /publicXp: \{ \$exists: false \} \}, \{ \$set/), src('engine/publicLevel.js', /Number\.isFinite\(user\?\.publicXp\)/)].join(', '), ev.publicXpIncCreatesField ? `open (edge case; production: ${F1_PRODUCTION.accountsInitialised} accounts initialised by the migration)` : 'closed', 'Small follow-up: in `writeCast`, write `publicXp` with an update pipeline, `publicXp = ($publicXp ?? $xp) + gain` (`$ifNull`), so a document without the field starts from its own `xp` at write time (a `publicXp: { $exists: false }` filter clause on the cast commit would drop the whole commit when it fails, so it only works as a separate update). Reconcile once: every account whose applied journals carry no profile bonus gets `publicXp = xp`; a Founder account is recomputed from its journals (guarded, audited). Before the curve change, a read-only production check that `publicXp = xp` for every non-Founder account. Correct the `publicLevel.js` comment on committed pending journals'],
		['F5', 'The `/dev founder` override: a developer-only, audited second path to the Founder profile; switching a real Founder "off" makes its catches competitive-eligible; an override leaves a lasting `publicXp` gap on a normal account', [src('engine/balance.js', /if \(override && PROFILES\[override\]\) name = override;/), src('engine/dev.js', /const FOUNDER_MODES/), src('commands/slash/User/profile.js', /const isFounder/)].join(', '), ev.devProfileOverride ? 'live (developer-only, audited; needs a developer action)' : 'closed', '`P-FOUNDER-DEV-OVERRIDE`: optional hardening'],
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
	T['founder-tier-map'] = mdTable(['New tier', 'Today\'s rod it is compared with'], Object.entries(todayRodOfTier()).map(([t, list]) => [tierName(t), list.map((r) => rodRow[r] || r).join(' and ') + (list.length > 1 ? ' (the higher ratio)' : '')]));
	const tn = (x) => `${cap(x.archetype)}, ${x.gating} gate`;
	T['founder-targets'] = mdTable(['#', 'Metric', 'Definition', 'Binding case', 'Needed (× margin)', 'Chosen'], [
		['M1', 'XP ratio at equal gear', `Founder final XP/h ÷ Normal XP/h, same tier and biome, ${F.DESIGN_OVERHEAD_S} s overhead; ≥ today's ratio on the mapped rod in all ${F.LIVE_BIOMES.length} biomes × ${R.power.length} tiers`, `${tierName(B.xpRatio.tier)} ${B.xpRatio.biome} (today ${times(B.xpRatio.today)}; Founder base ${times(B.xpRatio.baseRatio, 2)})`, times(B.xpRatio.need, 2), '—'],
		['M2', 'Absolute time to level (integrated)', `Hours of play to real Lv ${F.LIFECYCLE.milestones.join('/')} on the new curve, \`integrate.run\` with every reference system; ≤ today's Founder hours for all ${archetypes.length} archetypes and both gate options`, `${tn(B.xpTime)} (raw ${times(B.xpTime.raw, 2)})`, times(B.xpTime.need, 2), `**XP ×${S.xp}**`],
		['M3', '$ ratio at equal gear', 'Founder final $/h ÷ Normal $/h, same tier and biome; ≥ today\'s ratio in every case', `${tierName(B.cashRatio.tier)} ${B.cashRatio.biome} (today ${times(B.cashRatio.today)}; Founder base ${times(B.cashRatio.baseRatio, 2)})`, times(B.cashRatio.need, 2), '—'],
		['M4', 'Absolute time to afford', 'Minutes of Founder play to buy the tier set at the two purchases that exist today (T1 ↔ the Lv 20 rod, T2 ↔ the Lv 30 rod), rods crate prices and the Founder\'s crate luck; ≤ today\'s', `${tierName(B.afford.tier)}: today ${num(B.afford.todaySeconds, 1)} s (${usd(B.afford.todayCost)} at ${usd(B.afford.todayIncomePerHour)}/h; now ${usd(B.afford.newCost)})`, times(B.afford.need, 2), `**sell ×${S.sell}**`],
		['M5', 'Legendary+ per hour ratio at equal gear', `Legendary+/h ÷ Normal, home biome, with Founder pity; ≥ today's ratio; card-share cap: at most ${pct(PARAMS.cardShareCap.maxLegendaryCardShare, 1)} of public cards may show a Legendary+ (never binds; Normal's share is ${cardShareRangeText()}, so this is not a plausibility bound)`, `${tierName(B.luck.tier)} (today ${times(S.luckTarget[B.luck.tier])})`, `Luck +${num(B.luck.need, 3)}`, `**Luck +${S.luck}**${S.luckCapped ? ' (capped)' : ''}`],
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
		{ xp: 'XP multiplier', sell: 'Sell multiplier', luck: 'Luck (not displayed; public effect)', durabilityEfficiency: 'Durability efficiency' }[k],
		...R.earlierSolves.map((e) => `${fmtValue[k](e[k])} (${e.binding[k]})`),
		`**${fmtValue[k](S[k])}** (${bindingNow[k]})`,
	])) + `\n\nBinding case and its need (margin included) in brackets. Earlier columns are records (${R.earlierSolves.map((e) => e.source).join('; ')}).`;

	// ----- Current -> proposed -----
	const tp = td.profile;
	const rt = (t) => RARITIES.map((r) => num(t[r], 0)).join(' / ');
	T['founder-profile'] = mdTable(['Field', `Today (balance ${R.balanceVersionToday})`, 'Proposed', 'Rationale'], [
		['`competitiveEligible`', 'false', '**false**', 'Standing constraint: Founder catches stay out of every competitive board.'],
		['`rarityTable`', rt(tp.rarityTable), `**unchanged** (${rt(prof.rarityTable)})`, 'The per-fish rarity advantage is kept exactly (`P-FOUNDER-KEPT`). Every card prints it (Detection).'],
		['`stats.fishingSpeed`', num(tp.stats.fishingSpeed, 2), `**${num(prof.stats.fishingSpeed, 2)} (kept)**`, `Cooldown ${num(firstTier.cooldownMs.founder / 1000, 2)} s on the Old Rod, ${num(lastTier.cooldownMs.founder / 1000, 2)} s from the top tiers (engine floor): ${range(R.power.map((p) => p.castsPerHour.founder), int)} casts/h against Normal's ${range(R.power.map((p) => p.castsPerHour.normal), int)}. Visible: below ${num(R.detection.normalCooldownFloorMs / 1000, 2)} s no normal reel can follow (Detection, cadence).`],
		['`stats.durabilityEfficiency`', num(tp.stats.durabilityEfficiency, 2), `**${num(prof.stats.durabilityEfficiency, 2)}** (M6)`, 'Needs the stochastic durability rule (framework `P-DURABILITY`). Visible: durability per fish is public, and every normal rod loses exactly 1 (One reply).'],
		['`stats.luck`', tp.stats.luck ? num(tp.stats.luck, 2) : '—', `**+${num(prof.stats.luck, 2)}** (M5)`, `Not displayed, but its effect is public: every card prints each fish's rarity and takes the colour of the best one. Legendary/Lucky per fish (with pity) from ${range(R.power.map((p) => p.noLuck.perFish), (x) => pct(x, 1))} to ${range(R.power.map((p) => p.legendaryPlusPerFish), (x) => pct(x, 1))}; cards with a Legendary+ from ${TT.shareNoLuck} to ${TT.share}, Normal ${TT.shareNormal} (Luck; Detection).`],
		['`bonusDraws`', Object.entries(tp.bonusDraws).map(([n, p]) => `${n}: ${p}`).join(', '), '**unchanged**, now added to the rod\'s normal chain roll', `The Old Rod card is today's (mean ${num(R.visible[0].founder.mean, 2)} fish).`],
		['`limits`', `maxDraws ${tp.limits.maxDraws}, maxPerDraw ${tp.limits.maxPerDraw}`, `**maxDraws ${prof.limits.maxDraws} (= \`F.MULTI.maxFish\`), maxPerDraw ${prof.limits.maxPerDraw}**`, 'No card above the normal maximum (`P-FOUNDER-VISIBLE`). On the Old Rod a normal player lands one fish, so most Founder Old Rod cards are still impossible for a normal player (Visible catch).'],
		['`multipliers.xp`', `×${tp.multipliers.xp}`, `**×${prof.multipliers.xp}** (M2)`, 'Private; public output shows base.'],
		['`multipliers.sell`', `×${tp.multipliers.sell}`, `**×${prof.multipliers.sell}** (M4)`, 'Private, baked into each fish\'s stored `value`; `valueBase` stays the public amount.'],
		['`multipliers.questXp` / `questCash`', `×${tp.multipliers.questXp} / ×${tp.multipliers.questCash}`, `**×${prof.multipliers.questXp} / ×${prof.multipliers.questCash} (kept)**`, 'The quests design reads them (`P-FOUNDER-QUEST-MULT`).'],
		['`pity`', `Legendary+ ${pityText(td.pity.legendaryPlus)}; Lucky ${pityText(td.pity.lucky)}`, '**unchanged**', 'Worth more now: with a few draws per cast the counters actually build up.'],
		['`gacha.stats` / `gacha.pity`', `${statText(td.gachaStats)} / ${pityText(td.gachaPity.legendaryPlus)}`, '**unchanged**', 'Gacha on the new crates. Visible on every public `/open` reveal (One reply).'],
		['Lucky items', `${pct(LUCKY_ITEM_SHARE, 0)} of Lucky draws (${pct(R.luckyItems.itemPerDraw.founderBaseUnpinned, 2)} per Founder draw)`, `**pinned to the normal base table** (${pct(R.luckyItems.itemPerDraw.pinnedNormalBase, 5)} per draw)`, 'F0b; framework `P-LUCKY`.'],
		['Level shown in public', 'public level (shipped)', '**public level**', `Shipped in ${F1_COMMITS.main} (Public level).`],
		['Level that gates gameplay', 'real level', `**${PARAMS.publicLevel.gate} level**`, 'Framework `P-FOUNDER-GATE` (Level gate).'],
	]);
	T['founder-visible'] = mdTable(['Tier (home biome)', 'Normal P(1..5 fish)', 'Normal mean / P(3+) / P(5)', 'Founder P(1..5 fish)', 'Founder mean / P(3+) / P(5)', 'Legendary+ on the card N / F', 'Today\'s Founder fish/cast'], R.visible.map((v) => [
		`${tierName(v.tier)} (${v.biome})`, v.normal.dist.map((p) => num(p * 100, 1)).join(' / ') + '%', `${num(v.normal.mean, 2)} / ${pct(v.normal.p3plus)} / ${pct(v.normal.p5)}`,
		v.founder.dist.map((p) => num(p * 100, 1)).join(' / ') + '%', `**${num(v.founder.mean, 2)}** / ${pct(v.founder.p3plus, 0)} / ${pct(v.founder.p5, 0)}`, `${pct(v.normal.legendaryCardShare)} / ${pct(v.founder.legendaryCardShare)}`, num(v.todayFounderFishPerCast, 1),
	]));
	T['founder-luck'] = mdTable(['Tier', 'Legendary+/h ratio today', 'New, no luck', `New, +${S.luck} luck`, 'New with luck ÷ today', 'No luck vs today', `Public cards with a Legendary+: Normal / no luck / +${S.luck}`, 'Luck adds: base $/h / base XP/h'], R.power.map((p) => {
		const v = R.visible.find((x) => x.tier === p.tier);
		return [tierName(p.tier), times(p.ratio.legendaryPlus.today, 0), times(p.noLuck.legendaryPlusRatio, 0), times(p.ratio.legendaryPlus.new, 0), pct(p.ratio.legendaryPlus.new / p.ratio.legendaryPlus.today, 0), pct(p.noLuck.vsToday, 0), `${pct(v.normal.legendaryCardShare)} / ${pct(p.noLuck.legendaryCardShare)} / ${pct(v.founder.legendaryCardShare)}`, `+${pct(p.noLuck.cashBaseGain, 1)} / +${pct(p.noLuck.xpBaseGain, 1)}`];
	})) + `\n\nPity adds a little on top (Legendary+ per hour with and without pity at ${tierName(lastTier.tier)}: ${num(lastTier.home.legendaryPlusPerHour.founder, 1)} and ${num(lastTier.home.legendaryPlusPerHour.founderNoPity, 1)}). Luck is not displayed, but every public card prints the rarities it raises; the card shares here include pity.`;
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

	// ----- Public tells: detection, one reply, stealth sensitivity -----
	const obs = (x) => (x.never ? 'never' : `${int(x.median)} / ${int(x.p90)}`);
	const cad = (c) => `${num(c.delaySameRodS, 2)} s / ${num(c.delayAnyS, 2)} s`;
	const todayRodName = (rod) => rodRow[rod] || rod;
	T['founder-detection'] = mdTable(['Founder, rod (biome)', 'KL per fish (nats)', 'Printed rarities', 'Card colour', 'Legendary+ colour only', 'Fish count', 'Everything on the card', 'Cadence: one interval is proof if the Founder clicks within (same rod / any normal reel)'], [
		...DT.proposed.map((x) => [`Proposed, ${tierName(x.tier)} (${x.biome})`, num(x.klPerDraw, 3), obs(x.rarity), obs(x.colour), obs(x.legendaryColour), obs(x.count), `**${obs(x.all)}**`, cad(x.cadence)]),
		...DT.noLuck.map((x) => [`Proposed without luck, ${tierName(x.tier)}`, num(x.klPerDraw, 3), obs(x.rarity), obs(x.colour), obs(x.legendaryColour), obs(x.count), obs(x.all), 'as proposed']),
		...DT.today.map((x) => [`Today, ${todayRodName(x.rod)}, ${x.biome}`, num(x.klPerDraw, 3), obs(x.rarity), obs(x.colour), obs(x.legendaryColour), obs(x.count), `**${obs(x.all)}**`, cad(x.cadence)]),
		['Stealth (`P-FOUNDER-STEALTH` b), every tier', range(DT.stealth.map((x) => x.klPerDraw), (v) => num(v, 3)), ...['rarity', 'colour', 'legendaryColour', 'count', 'all'].map((k) => (DT.stealth.every((x) => x[k].never) ? 'never' : range(DT.stealth.map((x) => x[k].median), int))), 'never (normal cadence)'],
	]) + `\n\nCards (median / p90) until the likelihood ratio Founder : Normal reaches ${DT.target}:1 for an observer who knows both profiles and compares the Founder with a normal player on the same rod (no bait), with the Founder producing the cards. Exact dynamic programme over the log-ratio. Founder pity is left out (it only adds Legendary+), so every figure is conservative. "Printed rarities": the rarity on every line of the card; "card colour": the colour of the best rarity (${RARITIES.length} colours); "fish count": the number of fish; "everything": count and rarities together. Today's crafted rods put several fish of one species on each line, so their rarity evidence is per line; a normal player's count on today's rods is fixed per rod, so any other count is proof. Cadence: the Founder's cooldown against the same rod's normal cooldown and the fastest cooldown any normal reel in the rods design allows (${num(DT.normalCooldownFloorMs / 1000, 2)} s; today's fastest measured normal cooldown ${num(DT.measuredNormalFloorMs / 1000, 2)} s). At the design's ${F.DESIGN_OVERHEAD_S} s click delay no single interval is that short; Discord shows message times to the minute, so this needs live watching or message IDs.`;

	const sp = OR.species;
	const dur = OR.durability;
	const box = (name) => OR.boxes.find((b) => b.box === name);
	T['founder-one-reply'] = mdTable(['Public surface', 'What one reply shows', 'Proposed Founder', 'Normal player, same rod', 'Today\'s Founder', 'What it takes to reach 1000:1'], [
		['`/stats`, `/collection`, `/inventory` fish list', 'lifetime (or held) count per species; each species has one rarity, so the rarity histogram of every fish caught', `${cap(sp.archetype)} Founder at public Lv ${sp.publicLevel} (public gate: ${hrs(sp.hours)} on the Old Rod, ${int(sp.fish)} fish): ${num(sp.proposed.legendaryPlusFounder, 1)} Legendary+`, `${num(sp.proposed.legendaryPlusNormal, 2)} Legendary+ in the same ${int(sp.fish)} fish`, `${num(sp.today.legendaryPlusFounder, 1)} Legendary+ in the same fish`, `about ${int(sp.proposed.fishFor1000)} fish (today ${int(sp.today.fishFor1000)}): one reply after a median of ${int(sp.castsProposed.median)} casts (p90 ${int(sp.castsProposed.p90)}); after those ${int(sp.fish)} fish the expected ratio is 10^${int(sp.proposed.log10Ratio)} (today 10^${int(sp.today.log10Ratio)})`],
		['Rod durability (`/inventory`, `/info rod`) with fish caught per rod (`/stats`)', 'durability lost against fish caught on that rod', `${range(dur.proposed.map((x) => x.perFish.founder), (v) => num(v, 2))} per fish (T1–T${dur.proposed[dur.proposed.length - 1].tier}; the Old Rod is unbreakable); a rod lasts ${range(dur.proposed.map((x) => x.fishPerRodLife.founder), int)} fish`, `exactly 1 per fish; a rod lasts ${range(dur.proposed.map((x) => x.fishPerRodLife.normal), int)} fish`, `${range(dur.today.map((x) => x.perFish.founder), (v) => num(v, 2))} per fish`, `a cast charges its full fish count with probability ${range(dur.proposed.map((x) => x.sameAsNormalPerCast), (v) => pct(v, 1))} (today ${range(dur.today.map((x) => x.sameAsNormalPerCast), (v) => pct(v, 0))}), so the loss differs after ${range(dur.proposed.map((x) => x.casts.median), int)} cast (p90 ${range(dur.proposed.map((x) => x.casts.p90), int)})`],
		...['Daily Box', 'Voter\'s Crate'].map((name) => [`\`/open\` ${name}`, 'each slot\'s rarity (Legendary+ marked)', `a Legendary+ in ${pct(box(name).founder, 1)} of opens (kept gacha stats and pity)`, pct(box(name).normal, 2), 'the same (kept)', `${obs(box(name).opens)} opens (median / p90)`]),
	]) + `\n\nDurability: every normal rod loses exactly one point per fish (no normal source has durability efficiency), so before its first break a normal rod's max − durability equals the fish caught on it, which \`/stats\` prints per rod. Box opens: steady-state rates with pity, opens treated as independent; the new Streak Crate is opened with \`/open\` too (the streak design's Founder table has its rates). Stealth (\`P-FOUNDER-STEALTH\` b): ${DT.stealthNever && dur.stealthNever ? 'none of these differs from a normal player' : '**some of these still differ from a normal player**'}.`;

	const V = ['proposed', 'noLuck', 'stealth'];
	const vs = (fn) => V.map((k) => fn(SE[k], k));
	const tierHours = (u) => numericKeys(u).map((k) => num(u[k], 2)).join(' / ');
	const detRange = (rows, key) => (rows.every((x) => x[key].never) ? 'never' : `${range(rows.map((x) => x[key].median), int)} (p90 ${range(rows.map((x) => x[key].p90), int)})`);
	const detOf = { proposed: DT.proposed, noLuck: DT.noLuck, stealth: DT.stealth };
	T['founder-stealth'] = mdTable(['', 'Proposed (a)', 'Proposed without luck', 'Stealth (b): sensitivity only'], [
		['Visible profile', `Founder rarity table, Luck +${S.luck}, fishing speed ${num(prof.stats.fishingSpeed, 2)}, durability efficiency ${S.durabilityEfficiency}, pity, Founder box odds; Old Rod bonus fish`, 'the same with Luck 0', 'a normal player\'s: rarity table, fish count (one fish on the Old Rod), cadence, durability, box odds; no luck, no pity'],
		['XP multiplier (binding need)', ...vs((x) => `**×${x.xp}** (${x.binding.xp})`)],
		['Sell multiplier (binding need)', ...vs((x) => `**×${x.sell}** (${x.binding.sell})`)],
		['From one target family alone: sell (M3) / XP (M1)', ...vs((x) => `×${x.sellFromCashRatioOnly} / ×${x.xpFromRatioOnly}`)],
		['Quest multipliers', ...vs(() => `×${TODAY.multipliers.questXp} / ×${TODAY.multipliers.questCash} (kept)`)],
		['M5: Legendary+ per hour ≥ today\'s ratio (lowest tier ÷ today)', ...vs((x) => `${x.m5.met ? 'met' : '**not met**'} (${pct(x.m5.minOverTarget, x.m5.minOverTarget < 0.1 ? 1 : 0)}, ${tierName(x.m5.worstTier)})`)],
		['M6: rod life ≥ today\'s ratio (lowest tier ÷ today)', ...vs((x) => `${x.m6.met ? 'met' : '**not met**'} (${pct(x.m6.minOverTarget, 0)})`)],
		['$/h at T1, Founder ÷ Normal: final (public base)', ...vs((x) => `${times(x.cashRatioT1, 0)} (${times(x.cashBaseRatioT1, 1)})`)],
		[`${cap(ref)}, public gate: hours to real Lv ${SE.proposed.regular.level} / public Lv ${SE.proposed.regular.level} (Normal: Lv ${SE.proposed.regular.level})`, ...vs((x) => `${hrs(x.regular.realL50)} / ${hrs(x.regular.publicL50)} (${hrs(x.regular.normalL50)})`)],
		[`${cap(ref)}, public gate: tier purchases T1–T${lastTier.tier} (hours)`, ...vs((x) => tierHours(x.regular.upgrades))],
		['Cards to 1000:1, over the tiers: printed rarities / everything on the card', ...V.map((k) => `${detRange(detOf[k], 'rarity')} / ${detRange(detOf[k], 'all')}`)],
		['One-reply tells (`/stats`, durability, `/open`)', 'yes (One reply)', 'yes (One reply)', DT.stealthNever && dur.stealthNever ? 'none' : '**some remain**'],
		['What stays public', 'every tell in Detection and One reply; money until `P-FOUNDER-WALLET`; absence from competitive boards', 'the same', 'account-level only: money where it is still shown (`P-FOUNDER-WALLET`), how soon gear is bought (the row above), absence from competitive boards'],
	]) + `\n\nSensitivities, not proposals: the proposed values stay the solved ones. \`solveMultipliers()\` runs the same targets (M1–M4, today's value × ${PARAMS.targets.margin}, rounded up) on integrated lifecycles (\`integrate.run\`); the other systems (quests, streak, buffs, rod crates) read the proposed profile, as in the main solve. M5 and M6 are reported, not solved: only visible stats move them. A normal ${ref} player buys the tiers at ${tierHours(SE.normalUpgrades)} h.`;

	T['founder-curve-floor'] = mdTable(['Level today (100·L²)', 'XP', 'Level on the new curve without a stored floor', 'Live biomes it would lose'], R.publicLevel.curveFloor.map((x) => [x.level, int(x.xp), x.newLevel, x.lost.length ? x.lost.join(', ') : 'none'])) + '\n\nWhat a site that reads the new curve without the stored floor would return for an existing player (framework `P-CURVE-EXISTING`, `P-FOUNDER-PUBLIC-LEVEL`). The public level has the same problem: the shipped public level is derived on read, so without a stored `publicLevel` every member\'s public level drops like this, and with `P-FOUNDER-GATE` = public so does every member\'s gate level.';
	T['founder-level-sites'] = mdTable(['Level read or write site', 'Where (read at render time)', 'Today', 'At the curve change'], R.publicLevel.levelSites.map((x) => [x.site, x.found ? x.where : `**${x.where}**`, x.today, x.change])) + '\n\nEvery site must go through max(stored, curve) at the curve change, for the level and for the public level of every player; a single site on the bare curve demotes (Curve floor). The gates that read these levels are in Level gate (`getLevel()` → `getGateLevel()`).';

	// ----- Checks -----
	const CHECK_TEXT = {
		xpRatioPreserved: 'M1: XP ratio at equal gear ≥ today\'s in every tier × biome',
		cashRatioPreserved: 'M3: $ ratio at equal gear ≥ today\'s in every tier × biome',
		timeToLevelPreserved: 'M2: real-level hours ≤ today\'s Founder, every archetype, both gates (integrated)',
		affordPreserved: 'M4: minutes to afford ≤ today\'s',
		legendaryPlusRatioPreserved: 'M5: Legendary+ per hour ratio ≥ today\'s at every tier',
		visibleWithinNormalMax: `Every visible cast is 1–${F.MULTI.maxFish} fish (the normal maximum; not a feasibility check, see the next line)`,
		visibleCountFeasibleForNormal: 'Every visible count is one a normal player on the same rod can land (on the Old Rod a normal player lands one fish; adversarial review C4)',
		visibleMeanAtMostFour: 'Visible mean at most 4 at every tier (approved "~4 on strong casts")',
		legendaryCardShareWithinCap: `Public cards with a Legendary+ ≤ ${pct(PARAMS.cardShareCap.maxLegendaryCardShare)} (a solver cap, not a plausibility bound: Detection)`,
		normalCrateChainMatchesRods: 'The Normal crate chain reproduces rods.cratesDistribution() exactly',
		rodLifePreserved: 'M6: rod life ratio ≥ today\'s at every crafted tier',
		day30XpAndMoneyRatioPreserved: 'Day 30 (integrated): real XP ≥ today\'s Founder and money ÷ Normal ≥ today\'s, every archetype',
		competitiveEligibleFalse: 'Founder stays non-competitive',
		publicXpMatchesShippedDefinition: 'The model\'s public XP matches the shipped definition (Public level)',
		noPublicTellUnderPublicGate: 'Under the public gate the Founder never fishes a biome or tier above its public level (integrated; the level-gate tell only, not the card tells in Detection)',
	};
	T['founder-checks'] = mdTable(['Check', 'Result'], Object.entries(R.checks).filter(([k]) => k !== 'pass').map(([k, v]) => [CHECK_TEXT[k] || k, v === true ? 'pass' : v === false ? '**fail**' : String(v)]))
		+ `\n\nPity model: today's measured Founder Old Rod Legendary+ per fish ${pct(R.pityModelCheck.todayFounderOldRodMeasuredPerFish, 2)}; the model predicts ${pct(R.pityModelCheck.modelWithPity, 2)} with pity (${pct(R.pityModelCheck.modelNoPity, 2)} without).`;
	return T;
}

module.exports = {
	PARAMS, DECISIONS, SYSTEM_NAME, RETIRED_LOOP_PARITY,
	founderProfile, profileWith, founderOutcome, normalOutcome, visibleDistribution, visibleFromChain, pityLegendaryPlus,
	founderCastOutcome, system, systemDescription,
	lifecycle, today, solve, gacha, founderCrates, publicLevelStatus, publicXpDefinition, levelSites,
	STEALTH, stealthProfileWith, solveMultipliers, castsToProof, cardEvidence, detection, oneReply, sensitivities, curveFloor,
	report, markdownTables,
};

if (require.main === module) process.stdout.write(`${JSON.stringify(report(), null, 1)}\n`);
