const test = require('node:test');
const assert = require('node:assert/strict');
const { startDb, stopDb } = require('./helpers/db');
const { quiet, restore } = require('./helpers/quiet');
const { seedGame, makeUser, giveFish, reload } = require('./helpers/fixtures');
const { userDoc } = require('./helpers/castFixtures');
const { migrateAutoLockSpecies } = require('../src/bootstrap/migrations');
const { setFishLocked, setOwnedSpeciesLocked, setSpeciesAutoLock } = require('../src/engine/locking');
const { User: UserModel } = require('../src/schemas/UserSchema');
const { FishData } = require('../src/schemas/FishSchema');
const { Item, ItemData } = require('../src/schemas/ItemSchema');

test.before(async () => {
	quiet();
	await startDb();
	await seedGame();
});
test.after(async () => {
	await stopDb();
	restore();
});

test('migration: legacy accounts get auto-lock species from their locked fish, once', async () => {
	const user = await makeUser('mig');
	await giveFish(user, 'Sardine', { locked: true });
	await giveFish(user, 'Tuna');
	await UserModel.updateOne({ userId: 'mig' }, { $unset: { autoLock: 1 } });

	await migrateAutoLockSpecies();
	assert.deepEqual((await userDoc('mig')).autoLock.species, ['sardine']);

	// Idempotent: an account that already has the field is left alone.
	await UserModel.updateOne({ userId: 'mig' }, { $set: { 'autoLock.species': ['kraken'] } });
	await migrateAutoLockSpecies();
	assert.deepEqual((await userDoc('mig')).autoLock.species, ['kraken']);
});

test('individual lock and species auto-lock are separate', async () => {
	const user = await makeUser('locks');
	const a = await giveFish(user, 'Sardine');
	const b = await giveFish(user, 'Sardine');

	assert.equal(await setFishLocked('locks', a._id, true), true);
	assert.equal((await FishData.findById(a._id)).locked, true);
	assert.equal((await FishData.findById(b._id)).locked, false);
	assert.equal((await userDoc('locks')).autoLock?.species?.includes('sardine') ?? false, false);

	assert.equal(await setOwnedSpeciesLocked('locks', 'sardine', true), 1);
	await setSpeciesAutoLock('locks', 'Sardine', true);
	assert.deepEqual((await userDoc('locks')).autoLock.species, ['sardine']);

	await setSpeciesAutoLock('locks', 'SARDINE', false);
	assert.deepEqual((await userDoc('locks')).autoLock.species, []);
});

test('using the last crafting part removes it from the inventory (no zero-count leftovers)', async () => {
	const user = await makeUser('crafter');
	const part = await Item.findOne({ name: 'Wooden Rod Piece', user: null });
	await user.sendToInventory(part._id);
	let fresh = await reload(user);
	const partId = fresh.user.inventory.items.find(Boolean);
	assert.equal((await ItemData.findById(partId)).count, 1);

	await fresh.removeItems([partId]);
	fresh = await reload(user);
	assert.ok(!fresh.user.inventory.items.map(String).includes(String(partId)));
	assert.equal((await ItemData.findById(partId)).count, 0);
});

test('using one of a stack decrements it and keeps it', async () => {
	const user = await makeUser('crafter2');
	const part = await Item.findOne({ name: 'Cork Handle', user: null });
	await user.sendToInventory(part._id);
	let fresh = await reload(user);
	const partId = fresh.user.inventory.items.find(Boolean);
	await ItemData.updateOne({ _id: partId }, { $set: { count: 3 } });

	await fresh.removeItems([partId]);
	fresh = await reload(user);
	assert.ok(fresh.user.inventory.items.map(String).includes(String(partId)));
	assert.equal((await ItemData.findById(partId)).count, 2);
});

test('command counter increments atomically without rewriting the player', async () => {
	const { User } = require('../src/class/User');
	await makeUser('counter');
	const stale = new User(await User.get('counter'));
	await UserModel.updateOne({ userId: 'counter' }, { $inc: { xp: 500 } });
	await stale.incrementCommandCount();
	const doc = await userDoc('counter');
	assert.equal(doc.xp, 500, 'a stale copy must not overwrite XP');
	assert.equal(doc.commands, 1);
});
