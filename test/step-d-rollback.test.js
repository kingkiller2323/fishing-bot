// Step D rollback safety: with the 5B flag turned off again, state only the 5B release can create stays
// unreachable. A player left in a 5B-only biome (Mountain Stream) fishes the Ocean (read-time, no write);
// a 5B box granted under the flag stays unopened and owned. Today's states are unaffected.
const test = require('node:test');
const assert = require('node:assert/strict');
const { startDb, stopDb } = require('./helpers/db');
const { quiet, restore } = require('./helpers/quiet');
const { seedGame, makeUser } = require('./helpers/fixtures');
const { giveBox } = require('./helpers/gachaFixtures');
const { castLine } = require('../src/engine/cast');
const { openLine } = require('../src/engine/gacha');
const { isRelease5bBiome } = require('../src/engine/b5/catalog');
const { User: UserModel } = require('../src/schemas/UserSchema');
const { ItemData } = require('../src/schemas/ItemSchema');
const { Fish } = require('../src/schemas/FishSchema');

test.before(async () => {
	quiet();
	await startDb();
	await seedGame();
});
test.after(async () => {
	await stopDb();
	restore();
});

test('only biomes of the 5B release count as 5B-only', () => {
	assert.equal(isRelease5bBiome('mountain stream'), true);
	assert.equal(isRelease5bBiome('Mountain Stream'), true);
	for (const b of ['ocean', 'River', 'lake', 'pond', 'coast', 'swamp', undefined]) assert.equal(isRelease5bBiome(b), false, String(b));
	assert.equal(isRelease5bBiome('atlantis'), false, 'an unknown biome is not redirected (today\'s behaviour kept)');
});

test('flag off: a player left in the Mountain Stream fishes the Ocean, never a 5B fish, and nothing is written', async () => {
	await makeUser('d-ms');
	await UserModel.updateOne({ userId: 'd-ms' }, { $set: { currentBiome: 'mountain stream' } });
	for (let i = 0; i < 20; i++) {
		const r = await castLine({ userId: 'd-ms' });
		assert.equal(r.status, 'ok');
		assert.equal(r.environment.biome, 'Ocean');
		for (const c of r.catches.filter((x) => x.templateId)) assert.equal((await Fish.collection.findOne({ _id: new (require('mongoose').Types.ObjectId)(c.templateId) })).release, undefined);
	}
	assert.equal((await UserModel.collection.findOne({ userId: 'd-ms' })).currentBiome, 'mountain stream', 'read-time only');
});

test('flag off: a 5B box stays unopened and owned; a legacy box still opens', async () => {
	await makeUser('d-box');
	await giveBox('d-box', 'Streak Crate', 1);
	const r = await openLine({ userId: 'd-box', boxName: 'Streak Crate' });
	assert.equal(r.status, 'failed');
	assert.equal(r.failure.code, 'UNKNOWN_BOX');
	assert.equal((await ItemData.collection.findOne({ user: 'd-box', name: 'Streak Crate' })).count, 1);
	await giveBox('d-box', 'Daily Box', 1);
	assert.equal((await openLine({ userId: 'd-box', boxName: 'Daily Box' })).status, 'ok');
});
