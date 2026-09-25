// Phase 5B: chooses the single authoritative XP-curve coefficient (framework CURVE.quartic).
//
// Sweeps the coefficient over the SHARED lifecycle core (lifecycle.js) and scores the reference
// (regular) player's hours of actual play against the approved windows (F.TARGET_WINDOWS). The other
// archetypes, purchase-delay sensitivity and hours per level are reported alongside.
//
//   node scripts/economy/5b/curve.js [provisional|integrated] > docs/economy/5b/curve[-integrated].json
//
// Models:
//   provisional  the placeholder model the 5b.1 fit used (provisional gear path, level-scaled daily XP,
//                rod tiers bought after saving F.PURCHASE.saveHours of stage income). Reproduces the
//                5b.1/5b.2 choice (0.0475); kept for provenance.
//   integrated   R1: the integrated lifecycle (integrate.js reference systems on the shared gear path).
const F = require('./framework');
const LC = require('./lifecycle');

const MODEL = process.argv[2] || 'provisional';
const TARGETS = F.TARGET_WINDOWS;

function setup(model) {
	if (model === 'provisional') {
		return { path: F.PROVISIONAL_GEAR_PATH, systems: (o = {}) => [LC.provisionalRods(o), LC.provisionalDaily()], note: `provisional normal rod path; level-scaled daily XP (${F.DAILY.xpPerLevel} x level); rod tiers bought after saving ${F.PURCHASE.saveHours} h of stage income` };
	}
	if (model === 'integrated') {
		const integrate = require('./integrate');
		return { path: F.gearPath(), systems: () => integrate.referenceSystems(), note: integrate.REFERENCE_NOTE };
	}
	throw new Error(`Unknown model ${model}`);
}
const S = setup(MODEL);

/** Hours of play to each level for one archetype and coefficient (all levels recorded for smoothness). */
function lifecycle(quartic, archetype, { purchaseHours } = {}) {
	const r = LC.simulate({
		archetype,
		systems: S.systems(purchaseHours === undefined ? {} : { saveHours: purchaseHours }),
		curve: { base: F.CURVE.base, quartic },
		gearPath: S.path,
		stopAtLevel: F.LIFECYCLE.maxLevel,
		milestones: Array.from({ length: F.LIFECYCLE.maxLevel }, (_, i) => i + 1),
	});
	const reached = Object.fromEntries(F.LIFECYCLE.milestones.filter((T) => r.milestones[T]).map((T) => [T, { hours: +r.milestones[T].hours.toFixed(2), day: r.milestones[T].day }]));
	const perLevel = {};
	for (let L = 2; L <= F.LIFECYCLE.maxLevel; L++) {
		if (r.milestones[L] && r.milestones[L - 1]) perLevel[L] = +(r.milestones[L].hours - r.milestones[L - 1].hours).toFixed(3);
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

const inWindows = (reached) => Object.fromEntries(Object.entries(TARGETS).map(([L, [lo, hi]]) => [L, { hours: reached[L]?.hours ?? null, window: [lo, hi], ok: reached[L] ? reached[L].hours >= lo && reached[L].hours <= hi : false }]));

const regular = F.ARCHETYPES[F.REFERENCE_ARCHETYPE];
const sweep = [];
for (let q = 0.02; q <= 0.08 + 1e-9; q += 0.0025) {
	const quartic = +q.toFixed(4);
	const reg = lifecycle(quartic, F.REFERENCE_ARCHETYPE);
	sweep.push({ quartic, score: +score(reg.reached).toFixed(4), regular: Object.fromEntries(Object.entries(reg.reached).map(([k, v]) => [k, v.hours])) });
}
const best = [...sweep].sort((a, b) => a.score - b.score)[0];
const chosen = best.quartic;
const current = F.CURVE.quartic;
const atCurrent = lifecycle(current, F.REFERENCE_ARCHETYPE);
const sensitivity = MODEL === 'provisional'
	? Object.fromEntries([0, 1.5, 3].map((ph) => [`purchaseHours=${ph}`, Object.fromEntries(Object.entries(lifecycle(chosen, F.REFERENCE_ARCHETYPE, { purchaseHours: ph }).reached).map(([k, v]) => [k, v.hours]))]))
	: null;
const archetypes = Object.fromEntries(Object.keys(F.ARCHETYPES).map((n) => [n, lifecycle(chosen, n).reached]));
const reg = lifecycle(chosen, F.REFERENCE_ARCHETYPE);
const smoothness = Object.fromEntries([15, 18, 19, 20, 21, 22, 25, 29, 30, 31, 39, 40, 41, 49, 50].map((L) => [L, reg.perLevel[L]]));
const thresholds = Object.fromEntries([10, 20, 30, 40, 50, 60, 70].map((L) => [L, { today: 100 * L * L, chosen: Math.round(F.xpForLevel(L, { base: F.CURVE.base, quartic: chosen })) }]));

process.stdout.write(JSON.stringify({
	...F.stamp(),
	model: MODEL,
	gearPathSource: MODEL === 'provisional' ? 'provisional' : F.GEAR_PATH_SOURCE,
	method: `shared lifecycle core; ${S.note}`,
	targets: TARGETS, chosen, best,
	framework: { quartic: current, regular: Object.fromEntries(Object.entries(atCurrent.reached).map(([k, v]) => [k, v.hours])), windows: inWindows(atCurrent.reached), allInWindow: Object.values(inWindows(atCurrent.reached)).every((w) => w.ok) },
	thresholds, archetypes, sensitivity, hoursPerLevelRegular: smoothness, sweep,
	regularArchetype: regular,
}, null, 1));
