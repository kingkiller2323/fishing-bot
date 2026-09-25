// Phase 5B shared lifecycle core (scripts/economy/5b/lifecycle.js): correctness guards.
// Analysis code only (no database, no production path); these pin the core's safety rules.
const test = require('node:test');
const assert = require('node:assert/strict');
const F = require('../scripts/economy/5b/framework');
const LC = require('../scripts/economy/5b/lifecycle');

// Fast, deterministic runs: the provisional gear path avoids loading the rods design, and a huge curve
// base keeps the player at Lv 1 (Ocean, Old Rod) so the cast input is identical from day to day.
const base = { archetype: 'regular', gearPath: F.PROVISIONAL_GEAR_PATH, stopAtLevel: null, curve: { base: 1e12, quartic: 0 } };

/** A full outcome provider whose result depends on state.sys.toggle.on, which the input does not carry. */
function statefulProvider({ withCacheKey = false } = {}) {
	const sys = {
		name: 'stateful',
		init(state) {
			state.sys.toggle = { on: false };
		},
		onDayEnd(state) {
			state.sys.toggle.on = true;
		},
		outcome(input, state) {
			const o = F.castOutcome(input);
			return { ...o, xpPerCast: state.sys.toggle.on ? o.xpPerCast * 10 : o.xpPerCast };
		},
	};
	if (withCacheKey) sys.outcomeCacheKey = (input, state) => `toggle=${state.sys.toggle.on}`;
	return sys;
}

for (const withCacheKey of [false, true]) {
	test(`a state-dependent outcome() is never served stale from the rate cache (cache key: ${withCacheKey ? 'state-aware' : 'none'})`, () => {
		// XP per cast actually accrued, by day (the core's per-step rates for identical cast input).
		const perCast = { 1: new Set(), 2: new Set() };
		const probe = {
			name: 'probe',
			onCasts(state, ctx, { casts, rates }) {
				perCast[state.day + 1].add(+(rates.xp / casts).toFixed(9));
			},
		};
		LC.simulate({ ...base, days: 2, systems: [statefulProvider({ withCacheKey }), probe] });
		// Identical cast input on both days; only state differs. Day 2 must earn exactly 10x per cast.
		assert.equal(perCast[1].size, 1);
		assert.equal(perCast[2].size, 1);
		const [d1] = [...perCast[1]];
		const [d2] = [...perCast[2]];
		assert.ok(d1 > 0);
		assert.ok(Math.abs(d2 / d1 - 10) < 1e-6, `day 2 XP/cast ${d2}, day 1 ${d1}: stale cached outcome`);
	});
}

test('plain castOutcome results are still cached and identical run to run', () => {
	const a = LC.simulate({ ...base, days: 3, systems: [LC.provisionalDaily()] });
	const b = LC.simulate({ ...base, days: 3, systems: [LC.provisionalDaily()] });
	assert.deepEqual(a.ledger, b.ledger);
});

test('no legally fishable biome fails loudly by default (no silent fallback to a default biome)', () => {
	const denyAll = { name: 'denyAll', canFish: () => false };
	assert.throws(() => LC.simulate({ ...base, days: 1, systems: [denyAll] }), /No legally fishable biome/);
});

test('with onNoAccess: idle, a fully denied player is blocked: no casts, no XP, no cash', () => {
	const denyAll = { name: 'denyAll', canFish: () => false };
	const r = LC.simulate({ ...base, days: 2, systems: [denyAll], onNoAccess: 'idle' });
	assert.equal(r.ledger.xp.fishing || 0, 0);
	assert.equal(r.ledger.cash.fishing || 0, 0);
	assert.equal(r.final.castsTotal, 0);
	assert.equal(r.final.biome, null);
	assert.ok(r.final.blockedHours > 1.4, `blocked ${r.final.blockedHours} h`);
});

test('access rules are honoured, not bypassed: a denied higher biome falls back only to an allowed one', () => {
	const riverOnly = { name: 'riverOnly', canFish: (b) => b === 'River' };
	const biomes = [];
	const probe = { name: 'probe', onCasts: (state) => biomes.push(state.biome) };
	// Start at Lv 40 (Ocean..Coast unlocked by level): only River is permitted.
	const levelUp = {
		name: 'levelUp',
		init(state) {
			state.level = 40;
		},
	};
	LC.simulate({ ...base, days: 1, systems: [levelUp, riverOnly, probe] });
	assert.ok(biomes.length > 0);
	assert.deepEqual([...new Set(biomes)], ['River']);
});

test('at most one full outcome override per run', () => {
	const a = { name: 'a', outcome: (input) => F.castOutcome(input) };
	const b = { name: 'b', outcome: (input) => F.castOutcome(input) };
	assert.throws(() => LC.simulate({ ...base, days: 1, systems: [a, b] }), /Only one system may override the cast outcome; got a, b/);
});

test('provenance: the core with the provisional systems reproduces the committed 5b curve fit', () => {
	const curve = require('../docs/economy/5b/curve.json');
	const r = LC.simulate({ archetype: 'regular', gearPath: F.PROVISIONAL_GEAR_PATH, systems: [LC.provisionalRods(), LC.provisionalDaily()], curve: { base: F.CURVE.base, quartic: curve.chosen } });
	for (const [L, v] of Object.entries(curve.archetypes.regular)) assert.equal(+r.milestones[L].hours.toFixed(2), v.hours, `L${L}`);
});
