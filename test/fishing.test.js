// Draw behaviour of the cast engine: bounded re-rolls, fallback, determinism, speed, locking.
const test = require('node:test');
const assert = require('node:assert/strict');
const { startDb, stopDb } = require('./helpers/db');
const { quiet, restore } = require('./helpers/quiet');
const { seedGame, makeUser, giveFish } = require('./helpers/fixtures');
const { addPoolFish, useTestRod } = require('./helpers/castFixtures');
const { castLine, applyCastResult, parseCapabilities } = require('../src/engine/cast');
const { Fish: FishTemplate, FishData } = require('../src/schemas/FishSchema');
const { User: UserModel } = require('../src/schemas/UserSchema');
const { rng } = require('../src/engine/rng');

test.before(async () => {
	quiet();
	await startDb();
	await seedGame();
	await addPoolFish([{ name: 'Pool Minnow', rarity: 'Common' }, { name: 'Pool Perch', rarity: 'Common' }]);
});
test.after(async () => {
	rng.reset();
	await stopDb();
	restore();
});

test('capability parsing: bare number = draws, "N count" = fish per draw, always numbers', () => {
	assert.deepEqual(parseCapabilities(['weak', '3']), { draws: 3, perDraw: 1 });
	assert.deepEqual(parseCapabilities(['weak', '2 count']), { draws: 1, perDraw: 2 });
	assert.deepEqual(parseCapabilities(['weak', '01', '2 count']), { draws: 1, perDraw: 2 });
	assert.deepEqual(parseCapabilities(['weak']), { draws: 1, perDraw: 1 });
});

test('a normal Ocean cast catches catalog fish matching the rod', async () => {
	await makeUser('fisher-normal');
	rng.seed(1);
	const result = await castLine({ userId: 'fisher-normal' });
	assert.equal(result.status, 'ok');
	for (const c of result.catches) {
		assert.equal(typeof c.count, 'number');
		if (c.kind === 'fish') assert.ok(c.qualities.includes('weak'));
	}
});

test('casts are reproducible under a seed', async () => {
	const names = async (id) => {
		await makeUser(id);
		rng.seed(4242);
		const out = [];
		for (let i = 0; i < 5; i++) out.push((await castLine({ userId: id })).catches.map((c) => c.name).join(','));
		return out;
	};
	assert.deepEqual(await names('seed-a'), await names('seed-b'));
});

test('an unrollable rarity table falls back deterministically instead of recursing', async () => {
	await makeUser('fisher-fallback');
	// All-zero weights: no rarity can ever be rolled, so every re-roll fails.
	await useTestRod('fisher-fallback', { capabilities: ['weak'], weights: { common: 0, uncommon: 0, rare: 0, ultra: 0, giant: 0, legendary: 0, lucky: 0 } });
	const result = await castLine({ userId: 'fisher-fallback' });
	assert.equal(result.status, 'ok');
	// Lowest rarity, then alphabetical, among year-round Testpool fish with 'weak'.
	assert.equal(result.catches[0].name, 'Pool Minnow');
});

test('a truly impossible cast fails cleanly and quickly', async () => {
	await makeUser('fisher-impossible');
	await useTestRod('fisher-impossible', { capabilities: ['no-such-quality'] });
	const started = Date.now();
	const result = await castLine({ userId: 'fisher-impossible' });
	assert.equal(result.status, 'failed');
	assert.equal(result.failure.code, 'NO_CATCH');
	assert.ok(Date.now() - started < 5000);
});

test('no artificial per-draw delay (10 draws well under the old 1s floor)', async () => {
	await makeUser('fisher-speed');
	await useTestRod('fisher-speed', { capabilities: ['weak', '10'] });
	const started = Date.now();
	const result = await castLine({ userId: 'fisher-speed' });
	assert.equal(result.units, 10);
	assert.ok(Date.now() - started < 1000, `took ${Date.now() - started}ms`);
});

test('auto-locked species: new catches start locked', async () => {
	await makeUser('fisher-autolock');
	await useTestRod('fisher-autolock', { capabilities: ['weak', '4'] });
	await UserModel.updateOne({ userId: 'fisher-autolock' }, { $set: { 'autoLock.species': ['pool minnow', 'pool perch'] } });
	const result = await castLine({ userId: 'fisher-autolock' });
	await applyCastResult(result);
	for (const c of result.catches) {
		assert.equal(c.locked, true);
		assert.equal((await FishData.findById(c.id)).locked, true);
	}
});

test('individually locking one fish does not auto-lock its species', async () => {
	const user = await makeUser('fisher-individual');
	await useTestRod('fisher-individual', { capabilities: ['weak', '4'] });
	await UserModel.updateOne({ userId: 'fisher-individual' }, { $set: { 'autoLock.species': [] } });
	const template = await FishTemplate.findOne({ name: 'Pool Minnow' });
	await giveFish(user, template.name, { locked: true });
	const result = await castLine({ userId: 'fisher-individual' });
	assert.ok(result.catches.every((c) => c.locked === false));
});

test('new accounts start with empty auto-lock rules', async () => {
	await makeUser('fresh-account');
	const doc = await UserModel.findOne({ userId: 'fresh-account' }).lean();
	assert.deepEqual(doc.autoLock.species, []);
});

test('legacy accounts (no autoLock field) keep species carry-over from locked fish', async () => {
	const user = await makeUser('fisher-legacy');
	await useTestRod('fisher-legacy', { capabilities: ['weak', '6'] });
	await UserModel.updateOne({ userId: 'fisher-legacy' }, { $unset: { autoLock: 1 } });
	await giveFish(user, 'Pool Minnow', { locked: true });
	const result = await castLine({ userId: 'fisher-legacy' });
	for (const c of result.catches) assert.equal(c.locked, c.name === 'Pool Minnow');
});
