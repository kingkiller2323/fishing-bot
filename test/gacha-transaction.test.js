// On a replica set an open is one transaction: a failure leaves nothing half-done.
const test = require('node:test');
const assert = require('node:assert/strict');
const { startDb, stopDb } = require('./helpers/db');
const { quiet, restore } = require('./helpers/quiet');
const { seedGame, makeUser } = require('./helpers/fixtures');
const { userDoc } = require('./helpers/castFixtures');
const { giveBox } = require('./helpers/gachaFixtures');
const { openLine, applyGachaResult, recoverPendingOpens } = require('../src/engine/gacha');
const { ItemData } = require('../src/schemas/ItemSchema');
const { FishData } = require('../src/schemas/FishSchema');

test.before(async () => {
	quiet();
	await startDb({ replSet: true });
	await seedGame();
});
test.after(async () => {
	await stopDb();
	restore();
});

test('a failure inside the open transaction rolls back the box consumption too', async () => {
	await makeUser('tx-g');
	await giveBox('tx-g', 'Voter\'s Crate', 1);
	const r = await openLine({ userId: 'tx-g', boxName: 'Voter\'s Crate' });
	await assert.rejects(applyGachaResult(r, { fault: async (s) => { if (s === 'grants') throw new Error('boom'); } }));

	const box = await ItemData.findById(r.box.id).lean();
	assert.equal(box.count, 1, 'box not consumed');
	assert.equal((await userDoc('tx-g')).stats.gachaBoxesOpened || 0, 0);
	assert.equal(await FishData.countDocuments({ openId: r.openId }), 0);

	await recoverPendingOpens({ userId: 'tx-g' });
	assert.equal((await ItemData.findById(r.box.id).lean()).count, 0);
	assert.equal((await userDoc('tx-g')).stats.gachaBoxesOpened, 1);
	assert.equal(await FishData.countDocuments({ openId: r.openId }), r.slots.filter((s) => s.reward.kind === 'fish').length);
});
