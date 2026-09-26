// Journal compatibility and isolated recovery (Phase 5B step A).
//
// The fixtures in test/fixtures are cast and box-opening journals captured from the 3.2.0 code (the
// code before step A) with `castLine` / `openLine`, stored as canonical EJSON. They must keep replaying
// under the current code: a journal left pending by one deploy is applied by the next one. A corrupt
// journal is logged and left pending; it never blocks other journals, the player's next cast or the boot.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const mongoose = require('mongoose');
const { startDb, stopDb } = require('./helpers/db');
const { quiet, restore } = require('./helpers/quiet');
const { seedGame, makeUser } = require('./helpers/fixtures');
const { addPoolFish, useTestRod, userDoc } = require('./helpers/castFixtures');
const { giveBox } = require('./helpers/gachaFixtures');
const { castLine, applyCastResult, recoverPendingCasts, recoverPendingCastsDetailed } = require('../src/engine/cast');
const { recoverPendingOpens, recoverPendingOpensDetailed } = require('../src/engine/gacha');
const { recoverJournals } = require('../src/bootstrap');
const { levelForXp } = require('../src/engine/balance');
const { Cast } = require('../src/schemas/CastSchema');
const { GachaOpen } = require('../src/schemas/GachaOpenSchema');
const { ItemData, Item } = require('../src/schemas/ItemSchema');
const { FishData } = require('../src/schemas/FishSchema');
const { User: UserModel } = require('../src/schemas/UserSchema');

const { EJSON } = mongoose.mongo.BSON;
// Relaxed parse: numbers and dates come back as native values, as the journal holds them.
const fixture = (name) => EJSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', name), 'utf8'), { relaxed: true });
const FIXTURE_USER = 'journal-fixture';

test.before(async () => {
	quiet();
	await startDb();
	await seedGame();
	await addPoolFish([{ name: 'Pool Minnow', rarity: 'Common', baseValue: 40 }]);
});
test.after(async () => {
	await stopDb();
	restore();
});

/** Copies a user's item document under a fixed id (the id the fixture journal refers to). */
async function moveItemTo(userId, fromId, toId, listField) {
	const doc = await ItemData.collection.findOne({ _id: fromId });
	await ItemData.collection.insertOne({ ...doc, _id: toId });
	await ItemData.collection.deleteOne({ _id: fromId });
	await UserModel.collection.updateOne({ userId }, { $pull: { [listField]: fromId } });
	await UserModel.collection.updateOne({ userId }, { $push: { [listField]: toId } });
}

/** A fixture player: the account, its rod under the journal's rod id, and optionally other state. */
async function fixturePlayer(result, { xp = 0, publicXp = xp } = {}) {
	await makeUser(result.userId);
	const rodId = await useTestRod(result.userId, { capabilities: ['weak', '1'] });
	await moveItemTo(result.userId, rodId, new mongoose.Types.ObjectId(result.rod.id), 'inventory.rods');
	await UserModel.collection.updateOne({ userId: result.userId }, { $set: { 'inventory.equippedRod': new mongoose.Types.ObjectId(result.rod.id), xp, publicXp, level: levelForXp(xp) } });
}

test('a 3.2.0 cast journal (today\'s result shape) replays under the current code, exactly once', async () => {
	const result = fixture('cast-journal-3.2.0.json');
	assert.equal(result.balanceVersion, '3.2.0');
	await fixturePlayer(result, { xp: 350 });
	const before = await userDoc(FIXTURE_USER);
	await Cast.collection.insertOne({ _id: result.castId, userId: result.userId, guildId: null, result, status: 'pending', attempts: 0, createdAt: new Date() });

	assert.equal(await recoverPendingCasts({ userId: FIXTURE_USER }), 1);
	assert.equal(await recoverPendingCasts({ userId: FIXTURE_USER }), 0, 'nothing left pending');
	const after = await userDoc(FIXTURE_USER);
	assert.equal(after.xp - before.xp, result.xp.total);
	assert.equal(after.publicXp - before.publicXp, result.rewards.xp.base);
	assert.equal(after.inventory.money - before.inventory.money, result.cash.total);
	assert.equal(after.inventory.fish.length - before.inventory.fish.length, result.writes.fishDocs.length);
	assert.equal(await FishData.countDocuments({ castId: result.castId }), result.writes.fishDocs.length);
	assert.equal((await ItemData.findById(result.rod.id).lean()).durability, result.rod.after.durability);
	// The floors are written by the commit ($max), from the journal's own level fields.
	assert.equal(after.levelFloor, result.level.after);
	assert.equal(after.publicLevelFloor, result.level.public.after);
	assert.equal((await Cast.findById(result.castId).lean()).status, 'applied');
});

test('a cast journal from before the public level (no level.public, no rewards) still replays', async () => {
	const result = fixture('cast-journal-3.2.0.json');
	result.userId = 'journal-legacy';
	result.castId = new mongoose.Types.ObjectId().toString();
	result.rod.id = new mongoose.Types.ObjectId().toString();
	result.writes.fishDocs = result.writes.fishDocs.map((d) => ({ ...d, _id: new mongoose.Types.ObjectId().toString(), user: result.userId, castId: result.castId }));
	delete result.level.public;
	delete result.rewards;
	result.bait = null;
	result.quests = [];
	await fixturePlayer(result, { xp: 1000, publicXp: 400 });
	await UserModel.collection.updateOne({ userId: result.userId }, { $set: { publicLevelFloor: 2 } });
	const before = await userDoc('journal-legacy');
	await Cast.collection.insertOne({ _id: result.castId, userId: result.userId, result, status: 'pending', attempts: 0, createdAt: new Date() });

	assert.equal(await recoverPendingCasts({ userId: 'journal-legacy' }), 1);
	const after = await userDoc('journal-legacy');
	assert.equal(after.xp - before.xp, result.xp.total);
	assert.equal(after.publicXp - before.publicXp, result.xp.total, 'normal profile: base = total');
	assert.equal(after.levelFloor, result.level.after);
	assert.equal(after.publicLevelFloor, 2, 'no public level in the journal: the public floor is left as it was');
});

test('a 3.2.0 box-opening journal (today\'s result shape) replays under the current code', async () => {
	const result = fixture('gacha-journal-3.2.0.json');
	result.userId = 'journal-gacha';
	result.writes.fishDocs = result.writes.fishDocs.map((d) => ({ ...d, user: result.userId }));
	await makeUser(result.userId);
	await giveBox(result.userId, 'Voter\'s Crate', 2);
	const template = await Item.findOne({ name: 'Voter\'s Crate', user: null }).lean();
	const box = await ItemData.collection.findOne({ user: result.userId, name: template.name });
	await moveItemTo(result.userId, box._id, new mongoose.Types.ObjectId(result.box.id), 'inventory.gacha');
	await GachaOpen.collection.insertOne({ _id: result.openId, userId: result.userId, result, status: 'pending', attempts: 0, createdAt: new Date() });

	assert.equal(await recoverPendingOpens({ userId: result.userId }), 1);
	assert.equal(await recoverPendingOpens({ userId: result.userId }), 0);
	const after = await userDoc(result.userId);
	assert.equal(after.stats.gachaBoxesOpened, 1);
	assert.equal(after.inventory.fish.length, result.writes.fishDocs.length);
	assert.equal((await ItemData.findById(result.box.id).lean()).count, 1);
	assert.equal((await GachaOpen.findById(result.openId).lean()).status, 'applied');
});

/** Inserts corrupt pending journals (in both collections) that sort BEFORE any valid one. */
async function corruptJournals(userId) {
	const old = new Date(Date.now() - 60_000);
	await Cast.collection.insertMany([
		{ _id: `bad-cast-noresult-${userId}`, userId, status: 'pending', createdAt: old },
		{ _id: `bad-cast-shape-${userId}`, userId, status: 'pending', createdAt: old, result: { castId: `bad-cast-shape-${userId}`, userId, status: 'ok', writes: null, rod: { id: 'not-an-object-id' } } },
		{ _id: `bad-cast-id-${userId}`, userId, status: 'pending', createdAt: old, result: { castId: 'someone-else', userId, status: 'ok' } },
	]);
	await GachaOpen.collection.insertMany([
		{ _id: `bad-open-${userId}`, userId, status: 'pending', createdAt: old, result: { openId: `bad-open-${userId}`, userId, status: 'ok', box: { id: 'nope' }, writes: {} } },
	]);
	return [`bad-cast-noresult-${userId}`, `bad-cast-shape-${userId}`, `bad-cast-id-${userId}`];
}

test('a corrupt journal is logged with its id, stays pending, and never blocks the other journals', async () => {
	const id = 'journal-isolation';
	await makeUser(id);
	await useTestRod(id, { capabilities: ['weak', '1'] });
	const bad = await corruptJournals(id);
	// A valid interrupted cast, journaled AFTER the corrupt ones.
	const r = await castLine({ userId: id });
	await assert.rejects(applyCastResult(r, { fault: async (s) => { if (s === 'commit') throw new Error('boom'); } }));
	const before = await userDoc(id);

	const logged = [];
	const { recovered, failed } = await recoverPendingCastsDetailed({ userId: id, onFailure: (jid, error) => logged.push([jid, error.message]) });
	assert.equal(recovered, 1, 'the valid journal was applied');
	assert.deepEqual(failed.map((f) => f.id).sort(), [...bad].sort());
	assert.deepEqual(logged.map(([jid]) => jid).sort(), [...bad].sort(), 'each failure logged with its id');
	const after = await userDoc(id);
	assert.equal(after.xp - before.xp, r.xp.total);
	assert.equal((await Cast.findById(r.castId).lean()).status, 'applied');
	for (const b of bad) {
		const j = await Cast.collection.findOne({ _id: b });
		assert.equal(j.status, 'pending', `${b} left pending`);
		assert.ok(j.lastError, `${b} records its error`);
	}
	const opens = await recoverPendingOpensDetailed({ userId: id, onFailure: () => undefined });
	assert.deepEqual(opens.failed.map((f) => f.id), [`bad-open-${id}`]);
	assert.equal((await GachaOpen.collection.findOne({ _id: `bad-open-${id}` })).status, 'pending');
});

test('the per-player recovery before /fish never throws on a corrupt journal: the next cast still works', async () => {
	const id = 'journal-next-cast';
	await makeUser(id);
	await useTestRod(id, { capabilities: ['weak', '1'] });
	await corruptJournals(id);
	assert.equal(await recoverPendingCasts({ userId: id }), 0);
	assert.equal(await recoverPendingOpens({ userId: id }), 0);
	const r = await castLine({ userId: id });
	await applyCastResult(r);
	assert.equal((await userDoc(id)).xp, r.xp.total);
});

test('boot recovery: corrupt journals do not stop the boot or the valid journals', async () => {
	const id = 'journal-boot';
	await makeUser(id);
	await useTestRod(id, { capabilities: ['weak', '1'] });
	await corruptJournals(id);
	const r = await castLine({ userId: id });
	await assert.rejects(applyCastResult(r, { fault: async (s) => { if (s === 'grants') throw new Error('boom'); } }));
	await assert.doesNotReject(recoverJournals());
	assert.equal((await Cast.findById(r.castId).lean()).status, 'applied');
	// The whole bootstrap (migrations + recovery) completes with them still pending.
	await assert.doesNotReject(require('../src/bootstrap').bootstrap());
	assert.equal(await Cast.countDocuments({ userId: id, status: 'pending' }), 3);
	assert.equal(await GachaOpen.countDocuments({ userId: id, status: 'pending' }), 1);
});

test('replaying a 3.2.0 journal never lowers a stored level above the curve (the level is written with $max)', async () => {
	const result = fixture('cast-journal-3.2.0.json');
	result.userId = 'journal-highlevel';
	result.castId = new mongoose.Types.ObjectId().toString();
	result.rod.id = new mongoose.Types.ObjectId().toString();
	result.writes.fishDocs = result.writes.fishDocs.map((d) => ({ ...d, _id: new mongoose.Types.ObjectId().toString(), user: result.userId, castId: result.castId }));
	await fixturePlayer(result, { xp: 350 });
	// Stored level 9 at 350 XP (curve level 1): e.g. XP removed by the old /dev command.
	await UserModel.collection.updateOne({ userId: result.userId }, { $set: { level: 9, levelFloor: 9, publicLevelFloor: 9 } });
	assert.ok(result.level.after < 9, 'the journal carries a lower level');
	await Cast.collection.insertOne({ _id: result.castId, userId: result.userId, result, status: 'pending', attempts: 0, createdAt: new Date() });

	assert.equal(await recoverPendingCasts({ userId: result.userId }), 1);
	const after = await userDoc(result.userId);
	assert.equal(after.level, 9, 'stored level kept');
	assert.equal(after.levelFloor, 9);
	assert.equal(after.publicLevelFloor, 9);
	assert.equal(after.xp, 350 + result.xp.total);
});
