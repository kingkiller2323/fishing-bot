// Phase 5B subsystem: FOUNDER COMPENSATION AND PUBLIC LEVEL. Analysis only: nothing here touches the
// live game, src/ or production data. Every economic number is computed at runtime from the shared
// framework (./framework.js), today's real-engine measurements (docs/economy/measurements.json,
// simulation.json, gacha-ev.json) and the finished rods design's crate helpers (./rods.js). The
// Founder multipliers are SOLVED from explicit targets, not hand-set, so a framework bump regenerates
// them. The only hand-set numbers are the design parameters in PARAMS.
//
//   node -e "require('./scripts/economy/5b/founder.js').report()"   (returns the report object)
//   node scripts/economy/5b/founder.js                               (prints it as JSON)
//
// Exports (pure and synchronous; no database, no randomness):
//   PARAMS                       frozen design parameters (visible bonus fish, targets, margin, rounding,
//                                public-level rules, Lucky-item rule)
//   founderProfile()             the PROPOSED Founder profile (balance.js PROFILES.founder shape plus the
//                                new fields): kept rarity table, stats, pity and gacha luck; solved private
//                                multipliers (xp, sell) and private luck; visible bonus fish capped at the
//                                normal maximum; questXp/questCash; lucky-item rule; level gate
//   profileWith({luck, xp, sell, durabilityEfficiency})
//                                the same profile with trial values (what the solver and tests use)
//   founderOutcome(stage, {profile, overheadS})
//                                Founder per-cast and per-hour outcome at a stage. `stage` is a tier index
//                                (0..5 on F.gearPath()), a gear-path step, or {tier, biome, overheadS}.
//                                Returns visible catch distribution, base (public) and final (account)
//                                XP/value per cast and per hour, cooldown, durability per cast (engine
//                                rule), Legendary+ per cast with pity, and the Normal counterpart + ratios
//   normalOutcome(stage, {overheadS})
//                                the Normal counterpart (F.castOutcome/F.hourly on the same tier/biome)
//   visibleDistribution(multiChance, bonusFish, maxFish)
//                                P(n visible fish) for a cast: normal chain roll + Founder bonus, capped
//   pityLegendaryPlus(perDraw, table, visible, rule)
//                                exact renewal model of the per-cast Legendary+ pity (FOUNDER_PITY)
//   visibleFromChain(chain, bonusFish, maxFish)
//                                the same from any normal chain P(n fish) (e.g. a cast input's fishDist)
//   lifecycle(archetype, {profile, gating, path, stopAtRealMax})
//                                hours of play to each REAL and PUBLIC level (curve.js core: same step,
//                                daily XP, purchase delay; profile null = Normal and reproduces curve.json
//                                on the provisional path), plus the XP-source decomposition and the
//                                public-tell window. 5b.3: superseded by system() on the shared core
//                                (validateSystem() proves they agree); kept until the old loops are retired
//   founderCastOutcome(input, profile)
//                                the Founder outcome for a lifecycle.js cast input (honours stats,
//                                multiChance, fishDist, sellMult, xpMult, fish, rules)
//   system({gate, profile})      framework 5b.3 lifecycle.js SYSTEM (integrate.js 'founder' variant):
//                                init sets state.profile = 'founder'; outcome = founderCastOutcome (final and
//                                base XP/value); public-tell and base-value bookkeeping in state.sys.founder
//   systemDescription()          the system contract (hooks, ledger, what reads it)
//   coreLifecycle(archetype, {founder, gate})
//                                lifecycle()'s model on the shared core (system() + validation-only
//                                purchase and daily systems)
//   validateSystem()             system() on the core vs lifecycle(): every archetype, both gates, real and
//                                public milestones, XP sources, upgrades, tell, stop totals; and Normal
//   today()                      TODAY's Founder power per stage and as ratios to TODAY's Normal
//   solve()                      the private luck, sell and xp multipliers from the targets (cached)
//   gacha()                      Founder vs Normal box luck: today's boxes and the rods tier crates
//   founderCrates(t)             exact crates-to-assemble for tier t under Founder gacha stats and pity
//   journalProfileBonus(result)  profile XP bonus recorded by one Cast journal (all three journal shapes)
//   migratePublicXp(user, journals, {levelForXp})
//                                reference implementation of the additive publicXp/publicLevel migration
//   report()                     every key number of docs/economy/5b/founder.md (cached); report().integration
//                                holds the system contract and validateSystem()
const F = require('./framework');
const LC = require('./lifecycle');
const rods = require('./rods');
const { PROFILES, RARITIES, STAT_CAPS, levelForXp: levelForXpToday } = require('../../../src/engine/balance');
const { buildTable, applyPity } = require('../../../src/engine/rarity');
const { baseTable } = require('../../../src/engine/gacha');
const { resolveModifiers } = require('../../../src/engine/modifiers');
const MEASURED = require('../../../docs/economy/measurements.json');
const SIMULATED = require('../../../docs/economy/simulation.json');
const GACHA_EV = require('../../../docs/economy/gacha-ev.json');
const CURVE_JSON = require('../../../docs/economy/5b/curve.json');
const BOX_CATALOG = require('../../../src/bootstrap/data/gacha');

const deepFreeze = (o) => {
	for (const v of Object.values(o)) if (v && typeof v === 'object') deepFreeze(v);
	return Object.freeze(o);
};

// Today's production Founder profile (src/engine/balance.js). The parts this design KEEPS are read
// from here, never copied: rarity table, stats (durability efficiency, fishing speed), bonus-draw
// distribution, quest multipliers, pity and gacha luck.
const TODAY = PROFILES.founder;

// ---------------------------------------------------------------------------------------------
// Design parameters (the only hand-set numbers in this subsystem).
const PARAMS = deepFreeze({
	id: 'founder-5b',
	visible: {
		// Founder bonus fish per cast, added to the rod's NORMAL multi-catch roll (framework chain).
		// Kept at today's per-cast distribution (average +2), so the Old Rod looks exactly as it does
		// today (1-5 fish, average 3). The total is capped at the normal maximum (F.MULTI.maxFish), so
		// every Founder catch card is one a normal player can also get; only the frequency differs.
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
		// player's. Proposed rule: stochastic rounding of n x (1 - eff), no minimum (identical for eff 0,
		// i.e. every normal rod). The Founder's efficiency is then solved so rod life in hours of play,
		// relative to Normal, is at least today's (never below today's 0.75, never above STAT_CAPS).
		rule: 'stochastic',
	},
	plausibility: {
		// Private luck restores Legendary+ per hour, but the share of PUBLIC catch cards that show a
		// Legendary or Lucky fish must stay at or below this (the card shows rarity).
		maxLegendaryCardShare: 1 / 3,
	},
	// Lucky items (Booster Pack, Gold Rod Piece) come from a Lucky draw 20% of the time today, so the
	// Founder's 1% Lucky table makes them ~50x a normal player's. Proposed: the item branch is pinned to
	// the NORMAL base table for every profile and every luck source (bait's pinned rule, extended to
	// the Founder). The Founder's extra Lucky mass becomes Lucky fish.
	luckyItems: 'normal-base',
	publicLevel: {
		xpField: 'publicXp',
		levelField: 'publicLevel',
		// Recommended: every gameplay level gate (biomes, permits, rod level cap, shop, quests, level-
		// scaled rewards) reads the PUBLIC level, so a public card never shows a catch the public level
		// could not have made. 'real' is the alternative (today's access pace, with a public tell).
		gate: 'public',
		// /dev xp add|set applies to both xp and publicXp unless a scope says otherwise.
		devGrantDefaultScope: 'both',
	},
	lifecycleHourCap: 4000,
});

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
 * paths (F.gearPath() and the provisional path curve.json was fitted on) never share a cache entry.
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
	const xpBasePerCast = c.xpBase;
	const valueBasePerCast = c.valueBase;
	const perCast = {
		fish: visible.mean,
		xpBase: xpBasePerCast,
		xp: xpBasePerCast * p.multipliers.xp,
		valueBase: valueBasePerCast,
		value: valueBasePerCast * p.multipliers.sell,
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
		normal: { fishPerCast: n.outcome.fishPerCast, xpPerHour: n.hourly.xp, cashPerHour: n.hourly.cash, casts: n.hourly.casts, cooldownMs: n.outcome.cooldownMs, legendaryPlusPerHour: n.legendaryPlusPerHour, legendaryCardShare: n.legendaryCardShare, durabilityPerCast: n.outcome.durabilityPerCast, p3plus: n.outcome.jackpot3plus },
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
		const slotL = (def) => {
			const tb = baseTable(def, PART_POOLS);
			return lplus(tb);
		};
		crateMemo.set(t, {
			tier: t, crate: rods.crateDefinition(t).name, price,
			normal: { expected: normal.expected, p90: normal.p90, expectedCost: normal.expected * price, matchesRods: Math.abs(normal.expected - ref.expected) < 1e-9 },
			founder: { expected: founder.expected, p90: founder.p90, expectedCost: founder.expected * price, pity: fdef.pity ? Object.keys(fdef.pity) : [] },
			founderCrateFactor: founder.expected / normal.expected,
			legendaryPlusPerSlot: { normal: slotL(rods.crateDefinition(t)), founder: lplus(fdef.rarityTable) },
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
// Lifecycle (curve.js core). profile null = Normal (public level = real level).
function crateFactor(tierIdx, profile) {
	if (!profile || tierIdx < 1) return 1;
	return founderCrates(tierIdx).founderCrateFactor;
}

/**
 * Hours of play to each real and public level for one archetype. Mirrors curve.js: the player fishes
 * the highest biome the GATE level unlocks, buys the next tier after saving F.PURCHASE.saveHours of the
 * NORMAL stage income (the Founder pays the same price, scaled by its crate luck, from its own cash),
 * and takes a level-scaled daily (F.DAILY.xpPerLevel x gate level; x questXp for the account).
 * gating 'public': gates read the public level; 'real': gates read the real level.
 */
function lifecycle(archetype, { profile = null, gating = PARAMS.publicLevel.gate, path = F.gearPath(), stopAtRealMax = false, untilHours = null } = {}) {
	const arch = F.ARCHETYPES[archetype];
	const o = arch.overheadS;
	const dayH = arch.minutesPerDay / 60;
	const step = F.LIFECYCLE.stepH;
	const maxL = F.LIFECYCLE.maxLevel;
	let xpReal = 0;
	let xpPub = 0;
	let h = 0;
	let idx = 0;
	let saving = 0;
	const real = {};
	const pub = {};
	const upgrades = {};
	const sources = { fishingBase: 0, fishingBonus: 0, dailyBase: 0, dailyBonus: 0 };
	const sourcesAt = {};
	const sourcesAtPublic = {};
	let money = 0;
	let tellHours = 0;
	let tellUntil = null;
	let tellFrom = null;
	let tellSwamp = null;
	while (h < PARAMS.lifecycleHourCap) {
		const Lr = F.levelForXp(xpReal);
		const Lp = F.levelForXp(xpPub);
		const Lg = profile && gating === 'real' ? Lr : Lp;
		const biome = F.biomeAt(Lg);
		const cur = path[idx];
		const next = path[idx + 1];
		const n = normalOutcome({ tier: cur, biome }, { overheadS: o });
		const r = profile ? founderOutcome({ tier: cur, biome }, { profile, overheadS: o }).hourly : { xp: n.hourly.xp, xpBase: n.hourly.xp, value: n.hourly.cash };
		if (next && Lg >= next.level) {
			saving += r.value * step;
			const cost = n.hourly.cash * F.PURCHASE.saveHours * crateFactor(next.tier, profile);
			if (saving >= cost) {
				idx++;
				saving = 0;
				money -= cost;
				upgrades[next.tier] = round(h + step, 3);
			}
		}
		if (profile && (F.BIOME_LEVEL[biome] > Lp || cur.level > Lp)) {
			tellHours += step;
			if (!tellFrom) tellFrom = { hours: round(h, 2), publicLevel: Lp, realLevel: Lr, biome };
			if (!tellSwamp && biome === F.LIVE_BIOMES[F.LIVE_BIOMES.length - 1]) tellSwamp = { hours: round(h, 2), publicLevel: Lp, realLevel: Lr, biome };
			tellUntil = { hours: round(h + step, 2), publicLevel: Lp, realLevel: Lr, biome };
		}
		xpReal += r.xp * step;
		xpPub += r.xpBase * step;
		money += r.value * step;
		sources.fishingBase += r.xpBase * step;
		sources.fishingBonus += (r.xp - r.xpBase) * step;
		const before = h;
		h += step;
		if (Math.floor(h / dayH) !== Math.floor(before / dayH)) {
			const base = F.DAILY.xpPerLevel * Lp;
			const fin = F.DAILY.xpPerLevel * Lg * (profile ? profile.multipliers.questXp : 1);
			xpReal += fin;
			xpPub += base;
			sources.dailyBase += base;
			sources.dailyBonus += fin - base;
		}
		const L2r = F.levelForXp(xpReal);
		const L2p = F.levelForXp(xpPub);
		for (const T of F.LIFECYCLE.milestones) {
			if (!real[T] && L2r >= T) {
				real[T] = { hours: round(h, 2), day: Math.ceil(h / dayH) };
				sourcesAt[T] = { ...sources };
			}
			if (!pub[T] && L2p >= T) {
				pub[T] = { hours: round(h, 2), day: Math.ceil(h / dayH) };
				sourcesAtPublic[T] = { ...sources, realLevel: L2r };
			}
		}
		if (untilHours !== null ? h >= untilHours - 1e-9 : L2r >= maxL && (stopAtRealMax || L2p >= maxL)) break;
	}
	return {
		archetype, gating: profile ? gating : 'n/a', real, public: pub, upgrades,
		sourcesAtRealMilestone: sourcesAt, sourcesAtPublicMilestone: sourcesAtPublic,
		end: { hours: round(h, 2), day: Math.ceil(h / dayH - 1e-9), realLevel: F.levelForXp(xpReal), publicLevel: F.levelForXp(xpPub), realXp: Math.round(xpReal), publicXp: Math.round(xpPub), money: Math.round(money), tier: path[idx].tier },
		tell: profile ? { hours: round(tellHours, 2), firstAt: tellFrom, topBiomeFirstAt: tellSwamp, lastAt: tellUntil } : null,
	};
}

// ---------------------------------------------------------------------------------------------
// Solver: private luck -> sell -> xp, each the smallest value meeting every target x margin, rounded up.
let solveMemo = null;
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
	//    (b) hours to every real-level milestone <= today's Founder, every archetype, both gate options.
	const bindingXpRatio = [...xpRatioNeed].sort((a, b) => b.need - a.need)[0];
	const timeNeed = [];
	for (const a of Object.keys(F.ARCHETYPES)) {
		const target = T.lifecycles[a]?.founderHours;
		if (!target) continue;
		for (const gating of PARAMS.targets.gatingModes) {
			const ok = (m) => {
				const lc = lifecycle(a, { profile: withEff({ luck, sell, xp: m }), gating, stopAtRealMax: true });
				return F.LIFECYCLE.milestones.every((L) => target[L] === null || (lc.real[L] && lc.real[L].hours <= target[L]));
			};
			const need = bisect(ok, 1, 2000, 40);
			timeNeed.push({ archetype: a, gating, need: need * margin, raw: need });
		}
	}
	const bindingTime = [...timeNeed].sort((a, b) => b.need - a.need)[0];
	const xp = niceMultiplier(Math.max(bindingXpRatio.need, bindingTime.need));

	solveMemo = {
		durabilityEfficiency, effNeed, lifeTarget, luck, luckCapped, luckNeed, luckTarget, sell, xp,
		binding: { durability: Object.entries(effNeed).sort((a, b) => b[1] - a[1])[0], luck: Object.entries(luckNeed).sort((a, b) => b[1] - a[1])[0], cash: bindingCash, afford: bindingAfford, xpRatio: bindingXpRatio, xpTime: bindingTime },
		cashNeed, xpRatioNeed, afford, timeNeed,
	};
	return solveMemo;
}

/** The proposed Founder profile (for balance.js PROFILES.founder at implementation). */
function founderProfile() {
	const s = solve();
	return profileWith({ luck: s.luck, xp: s.xp, sell: s.sell, durabilityEfficiency: s.durabilityEfficiency });
}

// ---------------------------------------------------------------------------------------------
// Public level (F1): reference implementation of the additive migration.
/**
 * Profile XP bonus recorded by one applied Cast journal. Three journal shapes exist:
 *   1. rewards.xp.{base, profileBonus, final}   (a2ab9a8 onward): exact
 *   2. modifiers.xp.profile, no rewards         (Phase 3 journals): catch bonus exact, quest bonus from
 *                                               modifiers.quest (floors make it approximate by < 1 XP/quest)
 *   3. neither                                  (before profiles existed): 0
 */
function journalProfileBonus(result) {
	const xp = result?.rewards?.xp;
	if (xp && Number.isFinite(xp.profileBonus)) return { bonus: xp.profileBonus, method: 'rewards' };
	const m = result?.modifiers;
	const prof = m?.xp?.profile;
	if (Number.isFinite(prof) && prof !== 1 && result.xp) {
		// Catch: xp.catch = floor(base x multiplier); without the profile it is floor(base x multiplier / profile).
		const catchBase = Math.floor((result.xp.base || 0) * ((m.xp.multiplier || prof) / prof));
		// Quests: q.xp = floor(questXp x profile.questXp x event); the base is floor(q.xp / profile.questXp).
		const questProfile = (m.sources || []).find((x) => x.source === 'profile')?.multipliers?.questXp || 1;
		const questFinal = (result.quests || []).reduce((a, q) => a + (q.xp || 0), 0);
		const questBase = (result.quests || []).reduce((a, q) => a + Math.floor((q.xp || 0) / questProfile), 0);
		return { bonus: Math.max(0, (result.xp.catch || 0) - catchBase) + Math.max(0, questFinal - questBase), method: 'modifiers' };
	}
	return { bonus: 0, method: 'none' };
}

/**
 * publicXp/publicLevel for one account that has no publicXp yet: xp minus every recorded profile bonus
 * (applied journals only; pending journals add both fields when they are applied). Normal and test
 * accounts get publicXp = xp and publicLevel = their stored level, exactly. `levelForXp` is the curve in
 * force when the migration runs (today's floor(0.1*sqrt(xp))), so the no-demotion rule treats both levels
 * the same way at the curve change.
 */
function migratePublicXp(user, journals = [], { levelForXp = levelForXpToday } = {}) {
	if (user && Object.prototype.hasOwnProperty.call(user, PARAMS.publicLevel.xpField)) return { skip: true };
	const applied = journals.filter((j) => j.status === 'applied');
	const counts = { rewards: 0, modifiers: 0, none: 0 };
	let bonus = 0;
	for (const j of applied) {
		const b = journalProfileBonus(j.result);
		counts[b.method]++;
		bonus += b.bonus;
	}
	const xp = user?.xp || 0;
	const publicXp = Math.max(0, Math.min(xp, xp - bonus));
	const publicLevel = bonus > 0 ? levelForXp(publicXp) : (user?.level || levelForXp(xp));
	return { skip: false, set: { [PARAMS.publicLevel.xpField]: publicXp, [PARAMS.publicLevel.levelField]: publicLevel }, profileBonus: bonus, journals: counts };
}

// ---------------------------------------------------------------------------------------------
// Framework 5b.3: the Founder profile as a SYSTEM on the shared lifecycle core (lifecycle.js).
// integrate.js runs it as the 'founder' variant; validateSystem() proves it reproduces lifecycle()
// above, which stays until the old loops are retired.
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
		options: { gate: '\'public\' (default, recommended: PARAMS.publicLevel.gate, decisions.js P-FOUNDER-GATE) | \'real\'; must equal simulate({ gate })', profile: 'trial profile for the cast outcome (default founderProfile())' },
		hooks: {
			init: 'state.profile = \'founder\'; state.sys.founder = { gate, profile, key, fishing, tell }; throws if the run\'s gate differs',
			outcome: 'founderCastOutcome(input): visible fish = normal chain (input.multiChance + stats.multiChance, or input.fishDist) + Founder bonus fish, capped at F.MULTI.maxFish; per draw = F.castOutcome with the Founder rarity table and gear + profile stats (clamped), input sellMult/xpMult; base = visible mean x per draw; final = base x profile xp / sell; durability per F.RULES.durability (or input.rules)',
			outcomeCacheKey: 'the profile',
			beforeStep: 'public tell (gate \'real\' only): steps on a biome or tier above the public level',
			onCasts: 'base fish value, Legendary+ caught, fishing totals (state.sys.founder.fishing)',
		},
		ledger: {
			sources: 'none of its own: the core books its outcome under \'fishing\' (xp.fishing = final, publicXp.fishing = base, cash.fishing = final); base cash is state.sys.founder.fishing.valueBase',
			spend: 'none',
		},
		reads: 'state.publicLevel / state.level (tell); ctx.path (tier levels)',
		readBy: 'rods (state.profile: Founder crate luck via founderCrates), quests (founderProfile().multipliers questXp/questCash/sell), streak and buffs (Founder box odds and sell)',
	};
}

// Validation-only systems: lifecycle()'s placeholder assumptions on the core. Not part of the economy
// (the integrator uses rods/quests/streak/buffs); they exist so validateSystem() compares like with like.
/**
 * lifecycle()'s daily: F.DAILY.xpPerLevel x the level of the day's last step; base at the PUBLIC level,
 * final at the gate level x questXp for the Founder (both the public level for Normal).
 */
function lifecycleDaily() {
	const name = 'founderLifecycleDaily';
	return {
		name,
		init(state) {
			state.sys[name] = { publicLevel: 1 };
		},
		beforeStep(state) {
			state.sys[name].publicLevel = state.publicLevel;
		},
		onDayEnd(state, ctx) {
			const questXp = state.profile === SYSTEM_NAME ? state.sys[SYSTEM_NAME].profile.multipliers.questXp : 1;
			ctx.addXp('daily', F.DAILY.xpPerLevel * state.stepStartLevel * questXp, F.DAILY.xpPerLevel * state.sys[name].publicLevel);
		},
	};
}

/**
 * lifecycle()'s purchases: the next tier once the gate level reaches it and the player's own income since
 * then covers F.PURCHASE.saveHours of NORMAL income at the current stage (x the Founder's crate factor).
 * Spend 'progression' / 'T<tier>'.
 */
function lifecycleRods() {
	const name = 'founderLifecycleRods';
	return {
		name,
		init(state) {
			state.sys[name] = { saving: 0, upgrades: {} };
		},
		beforeStep(state, ctx, rates) {
			const next = ctx.path[state.equippedTier + 1];
			if (rates.blocked || !next || state.stepStartLevel < next.level) return;
			const s = state.sys[name];
			s.saving += rates.cash;
			const n = normalOutcome({ tier: ctx.path[state.equippedTier], biome: rates.biome }, { overheadS: ctx.arch.overheadS });
			const cost = n.hourly.cash * F.PURCHASE.saveHours * crateFactor(next.tier, state.profile === SYSTEM_NAME ? state.sys[SYSTEM_NAME].profile : null);
			if (s.saving < cost) return;
			state.equippedTier++;
			s.saving = 0;
			ctx.spend('progression', `T${next.tier}`, cost);
			// The new tier fishes from the next step (this step's rates are fixed).
			s.upgrades[next.tier] = +(state.h + ctx.stepH).toFixed(4);
		},
	};
}

/**
 * Validation-only (runs after the daily): lifecycle() adds a day's daily XP inside the day's final step,
 * before it records a level reached on that step; the core records the milestone after the step and adds
 * the daily at onDayEnd. For such milestones this keeps the ledger including that daily, so XP sources
 * are compared on lifecycle()'s basis. A session cut short by the stop level crossed no day: skipped.
 */
function dayEndProbe() {
	const name = 'founderDayEndProbe';
	return {
		name,
		init(state) {
			state.sys[name] = { milestones: {}, publicMilestones: {} };
		},
		onDayEnd(state, ctx) {
			if (Math.floor(state.h / (ctx.arch.minutesPerDay / 60)) === state.playDay) return;
			const probe = state.sys[name];
			const h = +state.h.toFixed(4);
			for (const which of ['milestones', 'publicMilestones']) {
				for (const [T, m] of Object.entries(state[which])) {
					if (!(T in probe[which]) && m.hours === h) probe[which][T] = { xp: { ...state.ledger.xp }, publicXp: { ...state.ledger.publicXp } };
				}
			}
		},
	};
}

/** lifecycle()'s model on the core: the Founder system (or none: Normal) + the validation-only systems. */
function coreLifecycle(archetype, { founder = true, gate = PARAMS.publicLevel.gate, ...simOpts } = {}) {
	return LC.simulate({
		archetype,
		gate: founder ? gate : 'real',
		systems: [founder ? system({ gate }) : null, lifecycleRods(), lifecycleDaily(), dayEndProbe()],
		stopAtLevel: F.LIFECYCLE.maxLevel,
		// lifecycle() runs until both levels reach the cap; real >= public, so the public level decides.
		stopOn: 'public',
		...simOpts,
	});
}

/** XP sources in lifecycle()'s shape from a core ledger snapshot. */
function coreSources(snap) {
	const x = snap.xp;
	const b = snap.publicXp;
	return { fishingBase: b.fishing || 0, fishingBonus: (x.fishing || 0) - (b.fishing || 0), dailyBase: b.daily || 0, dailyBonus: (x.daily || 0) - (b.daily || 0) };
}

/**
 * One comparison of the core with lifecycle() (one archetype; the Founder under `gate`, or Normal):
 * real and public milestone hours (step-exact: lifecycle() rounds hours to 0.01, under a step, so its step
 * index is recovered), XP sources at every milestone, the real level at each public milestone, the hour
 * each tier starts fishing, the public tell, and XP and money at the stop.
 */
function compareWithLifecycle(archetype, { founder = true, gate = PARAMS.publicLevel.gate } = {}) {
	const stepH = F.LIFECYCLE.stepH;
	const stepOf = (hours) => Math.round(hours / stepH);
	const out = { maxRel: 0, worst: null, exact: 0, compared: 0 };
	const note = (key, a, b) => {
		// Float noise (a different order of the same sums) counts as equal.
		const d = Math.abs(a - b) <= 1e-9 * Math.max(Math.abs(a), Math.abs(b), 1) ? 0 : Math.abs(a - b) / Math.max(Math.abs(b), 1e-12);
		if (d > out.maxRel) {
			out.maxRel = d;
			out.worst = key;
		}
		return round(d, 6);
	};
	const old = lifecycle(archetype, founder ? { profile: founderProfile(), gating: gate } : {});
	const core = coreLifecycle(archetype, { founder, gate });
	const probe = core.sys.founderDayEndProbe;
	const row = { milestones: {}, publicMilestones: {}, upgrades: {} };
	for (const [which, oldKey, oldSources] of [['milestones', 'real', 'sourcesAtRealMilestone'], ['publicMilestones', 'public', 'sourcesAtPublicMilestone']]) {
		for (const T of F.LIFECYCLE.milestones) {
			const o = old[oldKey][T];
			const c = core[which][T];
			if (!o || !c) {
				row[which][T] = { old: o ? o.hours : null, core: c ? c.hours : null };
				if (o || c) note(`${which} L${T} reached by one only`, 1, 0);
				continue;
			}
			const [kOld, kCore] = [stepOf(o.hours), stepOf(c.hours)];
			out.compared++;
			if (kOld === kCore) out.exact++;
			const src = coreSources(probe[which][T] || c.ledger);
			const os = old[oldSources][T];
			const r = { old: o.hours, core: c.hours, steps: kCore - kOld, rel: note(`${which} L${T} hours`, kCore, kOld), day: { old: o.day, core: c.day } };
			r.sources = Object.fromEntries(Object.keys(src).map((k) => [k, { old: Math.round(os[k]), core: Math.round(src[k]), rel: note(`${which} L${T} ${k}`, src[k], os[k]) }]));
			if (which === 'publicMilestones') {
				const realLevel = F.levelForXp(sum(Object.values((probe[which][T] || c.ledger).xp)));
				r.realLevel = { old: os.realLevel, core: realLevel };
				note(`public L${T} real level`, realLevel, os.realLevel);
			}
			row[which][T] = r;
		}
	}
	const ups = core.sys.founderLifecycleRods.upgrades;
	for (const t of Object.keys({ ...old.upgrades, ...ups })) {
		const [o, c] = [old.upgrades[t], ups[t]];
		if (o == null || c == null) {
			row.upgrades[t] = { old: o ?? null, core: c ?? null };
			note(`T${t} bought by one only`, 1, 0);
			continue;
		}
		row.upgrades[t] = { old: o, core: c, steps: stepOf(c) - stepOf(o), rel: note(`T${t} hours`, stepOf(c), stepOf(o)) };
	}
	if (founder) {
		const [o, c] = [old.tell, core.sys[SYSTEM_NAME].tell];
		const at = (x) => (x ? { step: stepOf(x.hours), publicLevel: x.publicLevel, realLevel: x.realLevel, biome: x.biome } : null);
		const same = ['firstAt', 'topBiomeFirstAt', 'lastAt'].every((k) => JSON.stringify(at(o[k])) === JSON.stringify(at(c[k])));
		if (!same) note('tell points', 1, 0);
		row.tell = { hours: { old: o.hours, core: round(c.hours, 2), rel: note('tell hours', stepOf(c.hours), stepOf(o.hours)) }, pointsMatch: same, firstAt: c.firstAt, topBiomeFirstAt: c.topBiomeFirstAt, lastAt: c.lastAt };
	}
	// At the stop (both levels at the cap): the public-cap milestone snapshot, with lifecycle()'s daily basis.
	const stop = core.publicMilestones[F.LIFECYCLE.maxLevel];
	if (stop) {
		const snap = probe.publicMilestones[F.LIFECYCLE.maxLevel] || stop.ledger;
		const [xp, pub] = [sum(Object.values(snap.xp)), sum(Object.values(snap.publicXp))];
		// lifecycle() reports whole XP and dollars at its end: compare the core's figures rounded the same way.
		row.stop = {
			hours: { old: old.end.hours, core: stop.hours },
			realXp: { old: old.end.realXp, core: Math.round(xp), rel: note('stop real XP', Math.round(xp), old.end.realXp) },
			publicXp: { old: old.end.publicXp, core: Math.round(pub), rel: note('stop public XP', Math.round(pub), old.end.publicXp) },
			money: { old: old.end.money, core: Math.round(stop.money), rel: note('stop money', Math.round(stop.money), old.end.money) },
			tier: { old: old.end.tier, core: core.final.tier },
		};
		if (old.end.tier !== core.final.tier) note('stop tier', core.final.tier, old.end.tier);
	}
	if (founder) {
		const f = core.sys[SYSTEM_NAME].fishing;
		row.fishing = { valueBase: Math.round(f.valueBase), value: Math.round(f.value), privateSellShare: round(1 - f.valueBase / f.value, 4), legendaryPlus: round(f.legendaryPlus, 1), fishPerCast: round(f.fish / f.casts, 3) };
	}
	return { ...out, row };
}

let validationMemo = null;
/**
 * Framework 5b.3 validation: system() on the shared core vs this module's lifecycle(), for every archetype
 * under both gates (the Founder, real and public milestones), plus the Normal run of the same baseline
 * (no founder system) for every archetype. The baseline systems reproduce lifecycle()'s placeholder
 * assumptions: its level-scaled daily (lifecycleDaily) and its purchase rule (lifecycleRods).
 */
function validateSystem({ tolerance = 0.005 } = {}) {
	if (validationMemo && validationMemo.tolerance === tolerance) return validationMemo;
	const cases = {};
	const agg = { maxRel: 0, worst: null, exact: 0, compared: 0 };
	const add = (key, c) => {
		cases[key] = c.row;
		agg.exact += c.exact;
		agg.compared += c.compared;
		if (c.maxRel > agg.maxRel) {
			agg.maxRel = c.maxRel;
			agg.worst = `${key}: ${c.worst}`;
		}
	};
	for (const gate of PARAMS.targets.gatingModes) {
		for (const a of Object.keys(F.ARCHETYPES)) add(`founder/${gate}/${a}`, compareWithLifecycle(a, { gate }));
	}
	for (const a of Object.keys(F.ARCHETYPES)) add(`normal/${a}`, compareWithLifecycle(a, { founder: false }));
	validationMemo = {
		method: 'LC.simulate with founder.system({ gate }) + validation-only lifecycleRods() (lifecycle()\'s purchase rule: F.PURCHASE.saveHours of NORMAL stage income x the Founder crate factor) + lifecycleDaily() (F.DAILY.xpPerLevel x level; base at the public level, final at the gate level x questXp) vs founder.lifecycle(), every archetype, gates public and real (real and public milestones); Normal: the same baseline without the founder system vs lifecycle() with no profile. Hours compared step-exact; XP sources at every milestone, tier upgrade hours, the public tell, and XP and money at the stop.',
		matches: agg.maxRel < tolerance,
		tolerance,
		maxRelativeDifference: round(agg.maxRel, 6),
		worst: agg.worst,
		exactMilestones: `${agg.exact}/${agg.compared}`,
		cases,
		differences: [
			'None in the model: the core steps, gates, buys and credits exactly as lifecycle() did, so every milestone (real and public), tier upgrade and tell point lands on the same step and every XP source, XP total and money figure agrees (float noise only).',
			'Days: the core counts a level reached on a day\'s final step in that day, where lifecycle() reported ceil(h/dayH) (the next day), so hours are compared, not days (row.day shows both).',
			'XP sources: a level reached on a day\'s final step is snapshotted by the core before that day\'s daily (onDayEnd) and by lifecycle() after it; the comparison applies lifecycle()\'s basis (validation-only dayEndProbe()). The integrated ledgers keep the core\'s convention.',
			'Stop: lifecycle() ran until both levels reached the cap; the core stops on the public level (real >= public). When the stop falls mid-day the core still ends that day (its onDayEnd daily comes after the last milestone), so the run\'s final totals include one more daily than lifecycle()\'s end; the comparison reads the public-cap milestone snapshot.',
			'Level-scaled daily under gate \'real\': lifecycle() credited the base at the PUBLIC level and the final at the real (gate) level x questXp. The integrated quests system credits both at the gate level (base = its reward, final = base x questXp), so under the non-recommended \'real\' gate its publicXp from quests is a little higher than lifecycle()\'s placeholder; under the recommended \'public\' gate the two agree.',
		],
	};
	return validationMemo;
}

// ---------------------------------------------------------------------------------------------
// Report
let reportMemo = null;
function report() {
	if (reportMemo) return reportMemo;
	const path = F.gearPath();
	const T = today();
	const s = solve();
	const prof = founderProfile();
	const G = gacha();
	const validation = validateSystem();

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
			// Decision D2 alternative: the same profile without the private luck.
			noLuck: (() => {
				const nl = founderOutcome({ tier: t.tier }, { profile: profileWith({ xp: s.xp, sell: s.sell, durabilityEfficiency: s.durabilityEfficiency }) });
				return { legendaryPlusRatio: round(nl.ratio.legendaryPlus, 1), vsToday: round(nl.ratio.legendaryPlus / s.luckTarget[t.tier], 3), legendaryCardShare: round(nl.legendaryCardShare, 4), perFish: round(nl.pity.perFish, 4) };
			})(),
			legendaryPlusPerFish: round(fo.pity.perFish, 4),
		};
	});

	// Counterfactual: TODAY's Founder profile (x5 XP, x10 sell, no luck, 0.75 efficiency) under the new rules.
	const unchanged = (() => {
		const p0 = profileWith({ xp: TODAY.multipliers.xp, sell: TODAY.multipliers.sell });
		const lcReal = lifecycle(F.REFERENCE_ARCHETYPE, { profile: p0, gating: 'real', stopAtRealMax: true });
		const lcPub = lifecycle(F.REFERENCE_ARCHETYPE, { profile: p0, gating: 'public', stopAtRealMax: true });
		const rows = path.map((t) => {
			const fo = founderOutcome({ tier: t.tier }, { profile: p0 });
			const todayL = maxOf(PARAMS.targets.todayRodOfTier[t.tier].map((rod) => T.byRod[rod].legendaryPlusPerHour.founder));
			return { tier: t.tier, xpRatio: round(fo.ratio.xp, 1), cashRatio: round(fo.ratio.cash, 1), legendaryPlusPerHour: round(fo.hourly.legendaryPlus, 1), todayFounderLegendaryPlusPerHour: round(todayL, 1), legendaryPlusDrop: round(todayL / fo.hourly.legendaryPlus, 1) };
		});
		return { regularRealL50Hours: { realGate: lcReal.real[50]?.hours ?? null, publicGate: lcPub.real[50]?.hours ?? null, todayFounder: T.lifecycles[F.REFERENCE_ARCHETYPE]?.founderHours?.[50] ?? null }, byTier: rows };
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
		};
	});

	// Lifecycles: Normal (validates against curve.json) and Founder under both gate options.
	const normalLc = Object.fromEntries(Object.keys(F.ARCHETYPES).map((a) => [a, lifecycle(a)]));
	const curveRegular = CURVE_JSON.best?.regular || {};
	// curve.json is fitted on the gear path it names (the 5b.1 provisional path through 5b.3): the Normal
	// lifecycle reproduces it on that path (the timeTable's newNormal column is on F.gearPath()).
	const curvePath = CURVE_JSON.gearPathSource === 'provisional' ? F.PROVISIONAL_GEAR_PATH : F.gearPath();
	const curveLc = curvePath === F.PROVISIONAL_GEAR_PATH ? lifecycle(F.REFERENCE_ARCHETYPE, { path: curvePath }) : normalLc[F.REFERENCE_ARCHETYPE];
	const normalMatchesCurveJson = Object.keys(curveRegular).length > 0 && Object.entries(curveRegular).every(([L, hrs]) => curveLc.real[L]?.hours === hrs);
	const founderLc = {};
	for (const gating of PARAMS.targets.gatingModes) {
		founderLc[gating] = Object.fromEntries(Object.keys(F.ARCHETYPES).map((a) => [a, lifecycle(a, { profile: prof, gating })]));
	}
	const timeTable = Object.fromEntries(Object.keys(F.ARCHETYPES).map((a) => {
		const tgt = T.lifecycles[a]?.founderHours || {};
		const row = {};
		for (const L of F.LIFECYCLE.milestones) {
			row[L] = {
				todayFounder: tgt[L] ?? null,
				todayNormal: T.lifecycles[a]?.normalHours?.[L] ?? null,
				newNormal: normalLc[a].real[L]?.hours ?? null,
				founderReal: Object.fromEntries(PARAMS.targets.gatingModes.map((g) => [g, founderLc[g][a].real[L]?.hours ?? null])),
				founderPublic: Object.fromEntries(PARAMS.targets.gatingModes.map((g) => [g, founderLc[g][a].public[L]?.hours ?? null])),
			};
		}
		return [a, row];
	}));
	const timeCheck = Object.keys(F.ARCHETYPES).every((a) => F.LIFECYCLE.milestones.every((L) => {
		const tgt = T.lifecycles[a]?.founderHours?.[L];
		return tgt == null || PARAMS.targets.gatingModes.every((g) => (founderLc[g][a].real[L]?.hours ?? Infinity) <= tgt);
	}));
	const publicPace = Object.fromEntries(Object.keys(F.ARCHETYPES).map((a) => [a, Object.fromEntries(F.LIFECYCLE.milestones.map((L) => {
		const n = normalLc[a].real[L]?.hours;
		const p = founderLc[PARAMS.publicLevel.gate][a].public[L]?.hours;
		return [L, { founderPublicHours: p ?? null, normalHours: n ?? null, speedup: n && p ? round(n / p, 2) : null }];
	}))]));
	const ref = F.REFERENCE_ARCHETYPE;
	// XP sources for the reference archetype, at each PUBLIC milestone (the recommended gate level).
	const decomposition = Object.fromEntries(Object.entries(founderLc[PARAMS.publicLevel.gate][ref].sourcesAtPublicMilestone).map(([L, x]) => {
		const tot = x.fishingBase + x.fishingBonus + x.dailyBase + x.dailyBonus;
		const pubTot = x.fishingBase + x.dailyBase;
		return [L, {
			realLevel: x.realLevel,
			account: { fishingBase: round(x.fishingBase / tot, 4), fishingProfileBonus: round(x.fishingBonus / tot, 4), dailyBase: round(x.dailyBase / tot, 4), dailyProfileBonus: round(x.dailyBonus / tot, 4), totalXp: Math.round(tot) },
			public: { fishing: round(x.fishingBase / pubTot, 4), daily: round(x.dailyBase / pubTot, 4), totalXp: Math.round(pubTot) },
		}];
	}));
	// Day 30 snapshot (today's simulation reports day 30).
	const day30 = Object.fromEntries(Object.keys(F.ARCHETYPES).map((a) => {
		const hrs = (30 * F.ARCHETYPES[a].minutesPerDay) / 60;
		const n = lifecycle(a, { untilHours: hrs }).end;
		const fp = lifecycle(a, { profile: prof, gating: 'public', untilHours: hrs }).end;
		const fr = lifecycle(a, { profile: prof, gating: 'real', untilHours: hrs }).end;
		const td = T.lifecycles[a]?.day30 || null;
		return [a, {
			hours: round(hrs, 2), today: td, newNormal: { level: n.realLevel, xp: n.realXp, money: n.money },
			founderPublicGate: { realLevel: fp.realLevel, publicLevel: fp.publicLevel, realXp: fp.realXp, publicXp: fp.publicXp, money: fp.money, tier: fp.tier },
			founderRealGate: { realLevel: fr.realLevel, publicLevel: fr.publicLevel, realXp: fr.realXp, publicXp: fr.publicXp, money: fr.money, tier: fr.tier },
			xpVsToday: td ? { todayFounderXp: td.founder.xp, newFounderXp: fp.realXp, ratio: round(fp.realXp / td.founder.xp, 2) } : null,
			moneyRatioToNormal: td ? { today: round(td.founder.money / td.normal.money, 1), new: round(fp.money / n.money, 1) } : null,
		}];
	}));

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

	const checks = {
		xpRatioPreserved: power.every((p) => p.ratio.xp.minOverTarget >= 1),
		cashRatioPreserved: power.every((p) => p.ratio.cash.minOverTarget >= 1),
		timeToLevelPreserved: timeCheck,
		affordPreserved: affordTable.every((r) => r.minutes.todayFounder === null || r.minutes.founder <= r.minutes.todayFounder),
		legendaryPlusRatioPreserved: s.luckCapped ? 'capped by plausibility' : power.every((p) => p.ratio.legendaryPlus.new >= p.ratio.legendaryPlus.today),
		visibleWithinNormalMax: visible.every((v) => v.founder.dist.length === F.MULTI.maxFish),
		visibleMeanAtMostFour: visible.every((v) => v.founder.mean <= 4),
		legendaryCardShareWithinCap: visible.every((v) => v.founder.legendaryCardShare <= PARAMS.plausibility.maxLegendaryCardShare + 1e-9),
		normalLifecycleMatchesCurveJson: normalMatchesCurveJson,
		normalCrateChainMatchesRods: Object.values(G.crates).every((c) => c.normal.matchesRods),
		rodLifePreserved: upkeep.every((u) => u.lifeRatio.proposed >= u.lifeRatio.todayTarget),
		day30XpAndMoneyRatioPreserved: Object.values(day30).every((d) => !d.today || (d.xpVsToday.ratio >= 1 && d.moneyRatioToNormal.new >= d.moneyRatioToNormal.today)),
		competitiveEligibleFalse: prof.competitiveEligible === false,
		systemReproducesLifecycle: validation.matches,
	};
	checks.pass = Object.values(checks).every((v) => v === true || v === 'capped by plausibility');

	reportMemo = {
		...F.stamp(),
		gearPathSource: F.GEAR_PATH_SOURCE,
		subsystem: PARAMS.id,
		method: `framework ${F.FRAMEWORK_VERSION} castOutcome/hourly on F.gearPath() (${F.GEAR_PATH_SOURCE}); Founder = Founder rarity table + combined stats, visible count = normal chain + bonus fish capped at ${F.MULTI.maxFish}; today's numbers from measurements.json / simulation.json / gacha-ev.json at ${F.DESIGN_OVERHEAD_S} s overhead`,
		proposedProfile: prof,
		solved: {
			durabilityEfficiency: s.durabilityEfficiency, luck: s.luck, luckCapped: s.luckCapped, sell: s.sell, xp: s.xp, margin: PARAMS.targets.margin,
			binding: {
				durability: { tier: Number(s.binding.durability[0]), need: round(s.binding.durability[1], 3) },
				luck: { tier: Number(s.binding.luck[0]), need: round(s.binding.luck[1], 3) },
				cashRatio: { tier: s.binding.cash.tier, biome: s.binding.cash.biome, today: round(s.binding.cash.target, 1), baseRatio: round(s.binding.cash.baseRatio, 2), need: round(s.binding.cash.need, 2) },
				afford: { tier: s.binding.afford.tier, todayMinutes: round(s.binding.afford.todayMinutes, 2), need: round(s.binding.afford.need, 2) },
				xpRatio: { tier: s.binding.xpRatio.tier, biome: s.binding.xpRatio.biome, today: round(s.binding.xpRatio.target, 1), baseRatio: round(s.binding.xpRatio.baseRatio, 2), need: round(s.binding.xpRatio.need, 2) },
				xpTime: { archetype: s.binding.xpTime.archetype, gating: s.binding.xpTime.gating, need: round(s.binding.xpTime.need, 2) },
			},
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
			normalMatchesCurveJson,
			normalCurveJsonPath: CURVE_JSON.gearPathSource || F.GEAR_PATH_SOURCE,
			time: timeTable,
			publicPace,
			tellWindowRealGating: Object.fromEntries(Object.keys(F.ARCHETYPES).map((a) => [a, founderLc.real[a].tell])),
			tellWindowPublicGating: Object.fromEntries(Object.keys(F.ARCHETYPES).map((a) => [a, founderLc.public[a].tell])),
			upgrades: Object.fromEntries(PARAMS.targets.gatingModes.map((g) => [g, founderLc[g][ref].upgrades])),
			decompositionRegular: decomposition,
			day30,
		},
		integration: { system: systemDescription(), validation },
		pityModelCheck: { todayFounderOldRodMeasuredPerFish: round(oldToday, 4), modelWithPity: round(oldModel, 4), modelNoPity: round(oldModelNoPity, 4) },
		luckyItems: (() => {
			const pinned = LUCKY_ITEM_SHARE * buildTable(F.NORMAL_RARITY_TABLE).lucky;
			const unpinned = LUCKY_ITEM_SHARE * buildTable(TODAY.rarityTable).lucky;
			const top = path.length - 1;
			const fDraws = founderOutcome({ tier: top }, { profile: prof }).hourly.fish;
			const nTop = normalOutcome({ tier: top });
			const nDraws = nTop.hourly.fish;
			return {
				rule: PARAMS.luckyItems,
				founderTodayPerHour: { oldRod: round(T.byRod['Old Rod'].luckyItemsPerHour.founder, 2), rareRod: round(T.byRod['Custom (Rare parts)'].luckyItemsPerHour.founder, 2), boosterPacksOldRod: round(T.byRod['Old Rod'].luckyItemsPerHour.boosterPacks, 2), boosterPacksRareRod: round(T.byRod['Custom (Rare parts)'].luckyItemsPerHour.boosterPacks, 2) },
				itemPerDraw: { pinnedNormalBase: round(pinned, 8), founderBaseUnpinned: round(unpinned, 6) },
				drawsPerHourTopTier: { founder: Math.round(fDraws), normal: Math.round(nDraws) },
				hoursPerLuckyItemTopTier: { founderPinned: round(1 / (fDraws * pinned), 1), founderUnpinned: round(1 / (fDraws * unpinned), 2), normal: round(1 / (nDraws * pinned), 1) },
			};
		})(),
		checks,
	};
	return reportMemo;
}
function mean(a) {
	return a.length ? sum(a) / a.length : 0;
}

module.exports = {
	PARAMS, SYSTEM_NAME,
	founderProfile, profileWith, founderOutcome, normalOutcome, visibleDistribution, visibleFromChain, pityLegendaryPlus,
	lifecycle, today, solve, gacha, founderCrates, journalProfileBonus, migratePublicXp,
	founderCastOutcome, system, systemDescription, coreLifecycle, validateSystem, report,
};

if (require.main === module) process.stdout.write(`${JSON.stringify(report(), null, 1)}\n`);
