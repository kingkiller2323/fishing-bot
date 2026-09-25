const test = require('node:test');
const assert = require('node:assert/strict');
const { rng, createRng } = require('../src/engine/rng');

test('createRng is deterministic for a seed', () => {
	const a = createRng(42);
	const b = createRng(42);
	const seqA = Array.from({ length: 20 }, () => a.random());
	const seqB = Array.from({ length: 20 }, () => b.random());
	assert.deepEqual(seqA, seqB);
	assert.ok(seqA.every((x) => x >= 0 && x < 1));
	assert.notDeepEqual(seqA, Array.from({ length: 20 }, () => createRng(43).random()));
});

test('global rng can be seeded and reset', () => {
	rng.seed(7);
	const first = [rng.random(), rng.random()];
	rng.seed(7);
	assert.deepEqual([rng.random(), rng.random()], first);
	rng.reset();
	assert.equal(typeof rng.random(), 'number');
});

test('int, pick and weighted stay in range', () => {
	const r = createRng(1);
	for (let i = 0; i < 1000; i++) {
		const n = r.int(5);
		assert.ok(Number.isInteger(n) && n >= 0 && n < 5);
	}
	assert.equal(r.pick([]), undefined);
	assert.equal(r.weighted(['a', 'b'], [0, 0]), undefined);
	for (let i = 0; i < 200; i++) assert.equal(r.weighted(['a', 'b', 'c'], [0, 5, 0]), 'b');
});

test('weighted matches its weights over many rolls', () => {
	const r = createRng(2024);
	const counts = { a: 0, b: 0, c: 0 };
	const N = 100_000;
	for (let i = 0; i < N; i++) counts[r.weighted(['a', 'b', 'c'], [70, 25, 5])]++;
	assert.ok(Math.abs(counts.a / N - 0.70) < 0.01);
	assert.ok(Math.abs(counts.b / N - 0.25) < 0.01);
	assert.ok(Math.abs(counts.c / N - 0.05) < 0.005);
});
