// Phase 5B: chooses the single authoritative XP-curve coefficient (framework CURVE.quartic).
//
// Provisional lifecycle over the exact analytic model: a player fishes the highest unlocked biome with
// the provisional normal rod path, takes a level-scaled daily quest, and buys each rod tier after
// saving `purchaseHours` of income at the current stage (a progression purchase). Hours are hours of
// actual play. The coefficient is chosen by the fit to the approved target windows for the REGULAR
// player; the other archetypes and purchase-delay sensitivity are reported alongside.
//
//   node scripts/economy/5b/curve.js > docs/economy/5b/curve.json
const F = require('./framework');

const TARGETS = { 20: [5, 6], 30: [12, 15], 40: [24, 30], 50: [40, 45] };
const PROVISIONAL_PATH = [
	{ tier: 'old', level: 0, mean: 1.0, qualities: ['weak'], stats: {} },
	{ tier: 't1', level: 20, mean: 1.15, qualities: ['weak', 'strong'], stats: { rareFind: 0.2, luck: 0.1 } },
	{ tier: 't2', level: 30, mean: 1.3, qualities: ['weak', 'strong'], stats: { rareFind: 0.4, luck: 0.2, trophyChance: 0.1, fishingSpeed: 0.05 } },
	{ tier: 't3', level: 40, mean: 1.5, qualities: ['weak', 'strong'], stats: { rareFind: 0.6, luck: 0.4, trophyChance: 0.3, fishingSpeed: 0.1 } },
	{ tier: 't4', level: 50, mean: 1.65, qualities: ['weak', 'strong'], stats: { rareFind: 0.9, luck: 0.6, trophyChance: 0.5, fishingSpeed: 0.15 } },
];
const ARCHETYPES = {
	casual: { minutesPerDay: 12.5, overheadS: 7 },
	regular: { minutesPerDay: 45, overheadS: 4 },
	active: { minutesPerDay: 120, overheadS: 3 },
	grinder: { minutesPerDay: 300, overheadS: 2 },
};
const DAILY_XP_PER_LEVEL = 60;
const STEP_H = 1 / 60;

const biomeAt = (L) => [...F.BIOME_ORDER.slice(0, 6)].reverse().find((b) => L >= F.BIOME_LEVEL[b]);
const rateCache = new Map();
function rates(biome, tier, overheadS) {
	const key = `${biome}|${tier.tier}|${overheadS}`;
	if (!rateCache.has(key)) {
		const o = F.castOutcome({ biome, qualities: tier.qualities, stats: tier.stats, multiChance: F.chanceForMean(tier.mean) });
		rateCache.set(key, F.hourly(o, overheadS));
	}
	return rateCache.get(key);
}

/** Hours of play to reach each level for one archetype and curve. */
function lifecycle(quartic, arch, { purchaseHours = 1.5, maxLevel = 60 } = {}) {
	const curve = { base: F.CURVE.base, quartic };
	let xp = 0;
	let h = 0;
	let tierIdx = 0;
	let saving = 0;
	const dayH = arch.minutesPerDay / 60;
	const reached = {};
	const perLevel = {};
	let lastLevel = 1;
	let lastH = 0;
	while (h < 2000) {
		const L = F.levelForXp(xp, curve);
		const next = PROVISIONAL_PATH[tierIdx + 1];
		const cur = PROVISIONAL_PATH[tierIdx];
		const r = rates(biomeAt(L), cur, arch.overheadS);
		if (next && L >= next.level) {
			// Save `purchaseHours` of current-stage income, then upgrade.
			saving += r.cash * STEP_H;
			if (saving >= r.cash * purchaseHours) {
				tierIdx++;
				saving = 0;
			}
		}
		xp += r.xp * STEP_H;
		const before = h;
		h += STEP_H;
		if (Math.floor(h / dayH) !== Math.floor(before / dayH)) xp += DAILY_XP_PER_LEVEL * L;
		const L2 = F.levelForXp(xp, curve);
		if (L2 > lastLevel) {
			for (let k = lastLevel + 1; k <= L2; k++) perLevel[k] = +(h - lastH).toFixed(3);
			lastLevel = L2;
			lastH = h;
		}
		for (const T of [10, 20, 30, 40, 50, 60]) if (!reached[T] && L2 >= T) reached[T] = { hours: +h.toFixed(2), day: Math.ceil(h / dayH) };
		if (L2 >= maxLevel) break;
	}
	return { reached, perLevel };
}

/** Distance outside the target windows (hours, relative to window width) + a small pull to midpoints. */
function score(reached) {
	let s = 0;
	for (const [L, [lo, hi]] of Object.entries(TARGETS)) {
		const hrs = reached[L]?.hours ?? Infinity;
		const w = hi - lo;
		const outside = hrs < lo ? (lo - hrs) / w : hrs > hi ? (hrs - hi) / w : 0;
		const mid = (hrs - (lo + hi) / 2) / w;
		s += 10 * outside * outside + 0.1 * mid * mid;
	}
	return s;
}

const sweep = [];
for (let q = 0.02; q <= 0.08 + 1e-9; q += 0.0025) {
	const quartic = +q.toFixed(4);
	const reg = lifecycle(quartic, ARCHETYPES.regular);
	sweep.push({ quartic, score: +score(reg.reached).toFixed(4), regular: Object.fromEntries(Object.entries(reg.reached).map(([k, v]) => [k, v.hours])) });
}
const best = [...sweep].sort((a, b) => a.score - b.score)[0];
const chosen = best.quartic;
const sensitivity = Object.fromEntries([0, 1.5, 3].map((ph) => [`purchaseHours=${ph}`, Object.fromEntries(Object.entries(lifecycle(chosen, ARCHETYPES.regular, { purchaseHours: ph }).reached).map(([k, v]) => [k, v.hours]))]));
const archetypes = Object.fromEntries(Object.entries(ARCHETYPES).map(([n, a]) => [n, lifecycle(chosen, a).reached]));
const reg = lifecycle(chosen, ARCHETYPES.regular);
const smoothness = Object.fromEntries([15, 18, 19, 20, 21, 22, 25, 29, 30, 31, 39, 40, 41, 49, 50].map((L) => [L, reg.perLevel[L]]));
const thresholds = Object.fromEntries([10, 20, 30, 40, 50, 60, 70].map((L) => [L, { today: 100 * L * L, chosen: Math.round(F.xpForLevel(L, { base: 100, quartic: chosen })) }]));

process.stdout.write(JSON.stringify({
	method: 'exact analytic model; provisional normal rod path; level-scaled daily XP (60 x level); rod tiers bought after saving 1.5 h of stage income',
	targets: TARGETS, chosen, best, thresholds, archetypes, sensitivity, hoursPerLevelRegular: smoothness, sweep,
}, null, 1));
