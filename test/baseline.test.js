// Freezes intentional behaviour that Foundation V2 must keep until the balance phase:
// level curve, biome ladder, sell-value formula and the normal-player rarity baseline.
const test = require('node:test');
const assert = require('node:assert/strict');
const { User } = require('../src/class/User');
const { Fish } = require('../src/class/Fish');
const { Rod } = require('../src/schemas/RodSchema');
const { Utils } = require('../src/class/Utils');
const { rng } = require('../src/engine/rng');

const levelFor = (xp) => new User({ userId: '1', xp }).getLevel();

test('level curve: floor(0.1 * sqrt(xp)), minimum 1', async () => {
	const cases = [[0, 1], [99, 1], [400, 2], [9_999, 9], [10_000, 10], [40_000, 20], [90_000, 30], [160_000, 40], [250_000, 50], [249_999, 49]];
	for (const [xp, level] of cases) assert.equal(await levelFor(xp), level, `xp ${xp}`);
});

test('biome ladder: Ocean 0, River 10, Lake 20, Pond 30, Coast 40, Swamp 50', () => {
	const biomes = require('../src/bootstrap/data/biomes');
	const ladder = Object.fromEntries(biomes.map((b) => [b.name, Number(b.requirements[0].split(' ')[1])]));
	assert.deepEqual(ladder, { Ocean: 0, River: 10, Lake: 20, Pond: 30, Coast: 40, Swamp: 50 });
});

test('sell value: round(size*base*0.05 + weight*1.005*rarityFactor)', async () => {
	const cases = [
		// baseValue, size, weight, rarity, expected
		[10, 20, 1, 'Common', 11],
		[80, 35.5, 2.25, 'Uncommon', 145],
		[500, 60, 10, 'Legendary', 1535],
		[1000, 1.5, 0.03, 'Lucky', 75],
		// 300 * 1.005 is 301.4999... in floating point, so this rounds down.
		[50, 400, 300, 'Giant', 1904],
		[10, 20, 1, 'unknown-rarity', 11],
	];
	for (const [base, size, weight, rarity, expected] of cases) {
		assert.equal(await Fish.calculateSellValue(base, size, weight, rarity), expected, `${rarity} ${base}`);
	}
});

// Probabilities normal players get today with the starter rod (RodSchema defaults) and no bait.
const LEGACY_ROD_WEIGHTS = { common: 7000, uncommon: 2500, rare: 500, ultra: 100, giant: 50, legendary: 20, lucky: 1 };

test('baseline rarity table: rod defaults are the legacy weights', () => {
	const weights = new Rod({ name: 'Old Rod', description: 'x', rarity: 'Common' }).toObject().weights;
	assert.deepEqual(weights, LEGACY_ROD_WEIGHTS);
});

test('baseline rarity distribution: weighted roll matches legacy odds', async () => {
	rng.seed(12345);
	const choices = Object.keys(LEGACY_ROD_WEIGHTS);
	const weights = Object.values(LEGACY_ROD_WEIGHTS);
	const total = weights.reduce((a, b) => a + b, 0);
	const counts = Object.fromEntries(choices.map((c) => [c, 0]));
	const N = 200_000;
	for (let i = 0; i < N; i++) counts[await Utils.getWeightedChoice(choices, weights)]++;
	rng.reset();
	for (const c of choices) {
		const expected = LEGACY_ROD_WEIGHTS[c] / total;
		// 5 standard deviations of a binomial proportion.
		const tolerance = 5 * Math.sqrt(expected * (1 - expected) / N);
		assert.ok(Math.abs(counts[c] / N - expected) <= tolerance, `${c}: ${counts[c] / N} vs ${expected}`);
	}
});

test('weighted roll is reproducible under a seed', async () => {
	const roll = async () => {
		rng.seed(99);
		const out = [];
		for (let i = 0; i < 50; i++) out.push(await Utils.getWeightedChoice(Object.keys(LEGACY_ROD_WEIGHTS), Object.values(LEGACY_ROD_WEIGHTS)));
		rng.reset();
		return out;
	};
	assert.deepEqual(await roll(), await roll());
});
