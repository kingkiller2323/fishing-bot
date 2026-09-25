const test = require('node:test');
const assert = require('node:assert/strict');
const { startDb, stopDb } = require('./helpers/db');
const { quiet, restore } = require('./helpers/quiet');
const { seedGame, makeUser, giveFish } = require('./helpers/fixtures');
const { Fish, NoCatchError } = require('../src/class/Fish');
const { FishData } = require('../src/schemas/FishSchema');
const { rng } = require('../src/engine/rng');

const weather = { getWeather: async () => 'Sunny' };
const season = { season: 'Fall' };
const LEGACY = { common: 7000, uncommon: 2500, rare: 500, ultra: 100, giant: 50, legendary: 20, lucky: 1 };

test.before(async () => {
	quiet();
	await startDb();
	await seedGame();
});
test.after(async () => {
	rng.reset();
	await stopDb();
	restore();
});

test('a normal draw returns catalog fish matching the capabilities', async () => {
	const user = await makeUser('fisher-normal');
	rng.seed(1);
	const caught = await Fish.generateFish(3, 1, ['weak', '3'], Object.keys(LEGACY), Object.values(LEGACY), user, weather, season);
	assert.ok(caught.length >= 1 && caught.length <= 3);
	for (const { item } of caught) {
		assert.equal(item.biome, 'Ocean');
		assert.ok(item.qualities.includes('weak') || item.type !== 'fish');
	}
});

test('draws are reproducible under a seed', async () => {
	const names = async (id) => {
		const user = await makeUser(id);
		rng.seed(4242);
		const out = [];
		for (let i = 0; i < 5; i++) {
			const caught = await Fish.generateFish(1, 1, ['weak'], Object.keys(LEGACY), Object.values(LEGACY), user, weather, season);
			out.push(caught[0].item.name);
		}
		return out;
	};
	assert.deepEqual(await names('seed-a'), await names('seed-b'));
});

test('an impossible rarity falls back deterministically instead of recursing', async () => {
	const user = await makeUser('fisher-fallback');
	// 'mythic' matches no fish, so every re-roll fails and the fallback is used.
	const caught = await Fish.generateFish(1, 1, ['weak'], ['mythic'], [1], user, weather, season);
	// Lowest rarity, then alphabetical, year-round Ocean fish with the 'weak' quality.
	const expected = (await require('../src/schemas/FishSchema').Fish.find({ biome: 'Ocean', weather: 'all', season: 'all', rarity: 'Common', qualities: 'weak' }).sort({ name: 1 }))[0].name;
	assert.equal(caught[0].item.name, expected);
});

test('a truly impossible cast throws NoCatchError quickly', async () => {
	const user = await makeUser('fisher-impossible');
	const started = Date.now();
	await assert.rejects(
		() => Fish.generateFish(1, 1, ['no-such-quality'], Object.keys(LEGACY), Object.values(LEGACY), user, weather, season),
		(error) => error instanceof NoCatchError && error.code === 'NO_CATCH',
	);
	assert.ok(Date.now() - started < 5000, 'bounded, not recursive');
});

test('no artificial per-draw delay (10 draws well under the old 1s floor)', async () => {
	const user = await makeUser('fisher-speed');
	rng.seed(3);
	const started = Date.now();
	await Fish.generateFish(10, 1, ['weak', 'strong'], Object.keys(LEGACY), Object.values(LEGACY), user, weather, season);
	assert.ok(Date.now() - started < 1000, `took ${Date.now() - started}ms`);
});

test('new catches of a locked species are locked too', async () => {
	const user = await makeUser('fisher-locked');
	// Lock every Common Ocean species the player could catch with a 'weak' rod.
	const { Fish: FishTemplate } = require('../src/schemas/FishSchema');
	const species = await FishTemplate.find({ biome: 'Ocean', rarity: 'Common', qualities: 'weak', user: null });
	for (const s of species) await giveFish(user, s.name, { locked: true });

	rng.seed(5);
	const caught = await Fish.generateFish(1, 1, ['weak'], ['common'], [1], user, weather, season);
	const stored = await FishData.findById(caught[0].item._id);
	assert.equal(stored.locked, true);
	assert.equal(caught[0].item.locked, true);
});

test('a count capability produces a numeric count', async () => {
	const user = await makeUser('fisher-count');
	rng.seed(8);
	const caught = await Fish.sendToUser(['weak', '2 count'], ['common'], [1], 'guild', user, weather, season);
	for (const f of caught) assert.equal(typeof f.count, 'number');
	// sendToUser still fires its size/weight/value saves without awaiting them (Phase 2 fixes this);
	// let them land before the test ends.
	await new Promise((resolve) => setTimeout(resolve, 300));
});

test.todo('sendToUser awaits every catch write before returning (Foundation V2 Phase 2)');
