// Phase 5B step B2: rod repair correctness (C1) and the dead durability path (C4), on today's rules.
//
// C1: a crafted rod is a CustomRodData document. The repair used RodData.findByIdAndUpdate, whose
// discriminator filter matched nothing, so the player paid the repair cost and the rod stayed broken.
// The repair now writes through ItemData, only while the rod is still broken, and a repair that does not
// apply is refunded. Today's numbers are unchanged: the rod's repairCost, back to its maxDurability.
const test = require('node:test');
const assert = require('node:assert/strict');
const mongoose = require('mongoose');
const { startDb, stopDb } = require('./helpers/db');
const { quiet, restore } = require('./helpers/quiet');
const { seedGame, makeUser } = require('./helpers/fixtures');
const { userDoc } = require('./helpers/castFixtures');
const { User } = require('../src/class/User');
const { User: UserModel } = require('../src/schemas/UserSchema');
const { ItemData } = require('../src/schemas/ItemSchema');
const { RodData } = require('../src/schemas/RodSchema');
const { CustomRodData } = require('../src/schemas/CustomRodSchema');
const repairButton = require('../src/components/buttons/repair-rod.js');

test.before(async () => {
	quiet();
	await startDb();
	await seedGame();
});
test.after(async () => {
	await stopDb();
	restore();
});

const oid = () => new mongoose.Types.ObjectId();

/** Equips a broken crafted rod (CustomRodData) and sets the player's money. */
async function brokenCraftedRod(userId, { money = 5000, repairs = 0 } = {}) {
	await makeUser(userId);
	const rod = await CustomRodData.create({
		name: 'Crafted Test Rod', description: 'test', rarity: 'Common', user: userId, rod: oid(), reel: oid(), hook: oid(), handle: oid(),
		state: 'broken', durability: 0, maxDurability: 1200, repairs, maxRepairs: 3, repairCost: 1000,
	});
	await UserModel.updateOne({ userId }, { $set: { 'inventory.money': money, 'inventory.equippedRod': rod._id }, $push: { 'inventory.rods': rod._id } });
	return rod._id;
}

/** Breaks the player's starter Old Rod (a RodData document) and sets the money. */
async function brokenOldRod(userId, money = 5000) {
	await makeUser(userId);
	const doc = await userDoc(userId);
	await ItemData.collection.updateOne({ _id: doc.inventory.equippedRod }, { $set: { state: 'broken', durability: 0, repairs: 0 } });
	await UserModel.updateOne({ userId }, { $set: { 'inventory.money': money } });
	return doc.inventory.equippedRod;
}

/** Runs the Repair button; `beforeConfirm` runs between the prompt and the click. */
async function clickRepair(userId, { choice = 'confirm', beforeConfirm = async () => undefined } = {}) {
	const out = { replies: [], updates: [] };
	const confirmation = { customId: choice, user: { id: userId }, update: async (p) => { out.updates.push(p); } };
	const interaction = {
		user: { id: userId },
		reply: async (p) => {
			out.replies.push(p);
			const awaitMessageComponent = async () => {
				await beforeConfirm();
				return confirmation;
			};
			return { awaitMessageComponent };
		},
		editReply: async (p) => { out.replies.push(p); },
	};
	await repairButton.run({}, interaction, null);
	const title = out.updates[0]?.embeds?.[0]?.data?.title;
	return { ...out, title };
}

const money = async (userId) => (await userDoc(userId)).inventory.money;

test('the old path: RodData.findByIdAndUpdate matches nothing on a crafted rod (why C1 charged for nothing)', async () => {
	const rodId = await brokenCraftedRod('c1-evidence');
	assert.equal(await RodData.findByIdAndUpdate(rodId, { state: 'repaired' }), null);
	assert.equal((await ItemData.findById(rodId).lean()).state, 'broken');
});

test('C1: repairing a broken crafted rod repairs it and charges the repair cost exactly once', async () => {
	const rodId = await brokenCraftedRod('c1-crafted');
	const r = await clickRepair('c1-crafted');
	assert.equal(r.title, 'Congratulations!');
	const rod = await ItemData.findById(rodId).lean();
	assert.equal(rod.state, 'repaired');
	assert.equal(rod.durability, 1200, 'back to its maxDurability (today\'s rule)');
	assert.equal(rod.repairs, 1);
	assert.equal(rod.__t, 'CustomRodData', 'still a crafted rod');
	assert.equal(await money('c1-crafted'), 4000);
});

test('the standard rod (RodData) repairs exactly as before', async () => {
	const rodId = await brokenOldRod('c1-oldrod');
	const before = await ItemData.findById(rodId).lean();
	const r = await clickRepair('c1-oldrod');
	assert.equal(r.title, 'Congratulations!');
	const rod = await ItemData.findById(rodId).lean();
	assert.equal(rod.state, 'repaired');
	assert.equal(rod.durability, before.maxDurability);
	assert.equal(rod.repairs, 1);
	assert.equal(await money('c1-oldrod'), 5000 - before.repairCost);
});

test('a rod that is no longer broken at confirm time is not repaired and nothing is charged', async () => {
	const rodId = await brokenCraftedRod('c1-race');
	// Repaired elsewhere (e.g. a second prompt confirmed first) between the prompt and this click.
	const r = await clickRepair('c1-race', { beforeConfirm: () => repairButton.repairRod({ _id: rodId, maxDurability: 1200 }) });
	assert.equal(r.title, 'Nothing to Repair');
	assert.match(r.updates[0].embeds[0].data.description, /not been charged/);
	const rod = await ItemData.findById(rodId).lean();
	assert.equal(rod.repairs, 1, 'repaired once, not twice');
	assert.equal(await money('c1-race'), 5000, 'the refused repair was refunded');
});

test('two confirmations cannot repair twice or charge twice', async () => {
	const rodId = await brokenCraftedRod('c1-double');
	const [a, b] = await Promise.all([clickRepair('c1-double'), clickRepair('c1-double')]);
	const titles = [a.title, b.title].sort();
	assert.deepEqual(titles, ['Congratulations!', 'Nothing to Repair']);
	assert.equal((await ItemData.findById(rodId).lean()).repairs, 1);
	assert.equal(await money('c1-double'), 4000);
});

test('insufficient money: no repair, no charge', async () => {
	const rodId = await brokenCraftedRod('c1-poor', { money: 999 });
	const r = await clickRepair('c1-poor');
	assert.equal(r.title, 'Insufficient Balance');
	assert.equal((await ItemData.findById(rodId).lean()).state, 'broken');
	assert.equal(await money('c1-poor'), 999);
});

test('cancel and non-broken rods behave as before', async () => {
	const rodId = await brokenCraftedRod('c1-cancel');
	assert.equal((await clickRepair('c1-cancel', { choice: 'cancel' })).title, 'Cancelled');
	assert.equal((await ItemData.findById(rodId).lean()).state, 'broken');
	assert.equal(await money('c1-cancel'), 5000);
	// A rod that is not broken is refused before any prompt.
	await makeUser('c1-mint');
	const r = await clickRepair('c1-mint');
	assert.equal(r.updates.length, 0);
	assert.match(r.replies[0].content, /can't be repaired/);
});

test('C4: the dead, unguarded durability and repair paths on User are gone', () => {
	assert.equal(typeof User.prototype.decreaseRodDurability, 'undefined');
	assert.equal(typeof User.prototype.repairRod, 'undefined');
});
