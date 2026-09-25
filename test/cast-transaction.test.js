// On a transaction-capable MongoDB a failed cast rolls back completely.
const test = require('node:test');
const assert = require('node:assert/strict');
const { startDb, stopDb } = require('./helpers/db');
const { quiet, restore } = require('./helpers/quiet');
const { seedGame, makeUser } = require('./helpers/fixtures');
const { addPoolFish, useTestRod, useTestBait, userDoc } = require('./helpers/castFixtures');
const { castLine, applyCastResult, recoverPendingCasts } = require('../src/engine/cast');
const { FishData } = require('../src/schemas/FishSchema');
const { ItemData } = require('../src/schemas/ItemSchema');
const { Cast } = require('../src/schemas/CastSchema');

test.before(async () => {
	quiet();
	await startDb({ replSet: true });
	await seedGame();
	await addPoolFish([{ name: 'Pool Minnow', rarity: 'Common' }]);
});
test.after(async () => {
	await stopDb();
	restore();
});

test('a failure inside the transaction leaves no partial writes; recovery applies once', async () => {
	await makeUser('tx');
	await useTestRod('tx', { capabilities: ['weak', '2'], durability: 50 });
	const baitId = await useTestBait('tx', { count: 5 });
	const before = await userDoc('tx');

	const r = await castLine({ userId: 'tx' });
	await assert.rejects(applyCastResult(r, { fault: async (s) => { if (s === 'commit') throw new Error('boom'); } }));

	// Everything before the failing step was rolled back with it.
	assert.equal(await FishData.countDocuments({ castId: r.castId }), 0);
	assert.equal((await ItemData.findById(r.rod.id).lean()).durability, 50);
	assert.equal((await ItemData.findById(baitId).lean()).count, 5);
	assert.equal((await userDoc('tx')).xp, before.xp);
	assert.equal((await Cast.findById(r.castId).lean()).status, 'pending');

	await recoverPendingCasts({ userId: 'tx' });
	const after = await userDoc('tx');
	assert.equal(after.xp - before.xp, r.xp.total);
	assert.equal(await FishData.countDocuments({ castId: r.castId }), r.catches.length);
	assert.equal((await ItemData.findById(r.rod.id).lean()).durability, 48);
	assert.equal((await ItemData.findById(baitId).lean()).count, 3);
});
