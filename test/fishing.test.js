// Draw behaviour of the cast engine: bounded re-rolls, fallback, determinism, speed, locking.
const test = require('node:test');
const assert = require('node:assert/strict');
const { startDb, stopDb } = require('./helpers/db');
const { quiet, restore } = require('./helpers/quiet');
const { seedGame, makeUser, giveFish } = require('./helpers/fixtures');
const { addPoolFish, useTestRod, withRarityTable } = require('./helpers/castFixtures');
const { castLine, applyCastResult } = require('../src/engine/cast');
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

test('a rarity with no eligible fish falls back deterministically instead of recursing', async () => {
	await makeUser('fisher-fallback');
	await useTestRod('fisher-fallback', { capabilities: ['weak'] });
	// Only Giant can be rolled, and the test biome has no Giant fish: every re-roll fails.
	const result = await withRarityTable('normal', { giant: 1 }, () => castLine({ userId: 'fisher-fallback' }));
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

test('no artificial per-draw delay (5 draws well under the old 500ms floor)', async () => {
	await makeUser('fisher-speed');
	await useTestRod('fisher-speed', { capabilities: ['weak', '5'] });
	const started = Date.now();
	const result = await castLine({ userId: 'fisher-speed' });
	assert.equal(result.units, 5);
	assert.ok(Date.now() - started < 500, `took ${Date.now() - started}ms`);
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
