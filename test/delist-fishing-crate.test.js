// Hotfix L5: the $750 Fishing Crate is removed from the shop; owned crates are untouched.
const test = require('node:test');
const assert = require('node:assert/strict');
const mongoose = require('mongoose');
const { startDb, stopDb } = require('./helpers/db');
const { quiet, restore } = require('./helpers/quiet');
const { makeUser } = require('./helpers/fixtures');
const { giveBox } = require('./helpers/gachaFixtures');
const { bootstrap } = require('../src/bootstrap');
const { seedStatic } = require('../src/bootstrap/seed');
const { runMigrations, migrateDelistFishingCrate } = require('../src/bootstrap/migrations');
const gachaData = require('../src/bootstrap/data/gacha');
const { Item, ItemData } = require('../src/schemas/ItemSchema');
const { Utils } = require('../src/class/Utils');
const { openBox } = require('../src/engine/gacha');
const { boxDefinition } = require('../src/engine/gachaBoxes');

const CRATE = 'Fishing Crate';
const catalogCrate = () => Item.findOne({ name: CRATE, user: null }).lean();
const shopNames = async () => (await Item.find({ shopItem: true }).lean()).map((i) => i.name);
const shopGachaLabels = async () => (await Promise.all(await Utils.selectionOptions('gacha'))).filter(Boolean).map((o) => o.data.label);

test.before(async () => {
	quiet();
	await startDb();
});
test.after(async () => {
	await stopDb();
	restore();
});

test('seed data: Fishing Crate is no longer a shop item; price and definition unchanged', () => {
	const crate = gachaData.find((g) => g.name === CRATE);
	assert.equal(crate.shopItem, false);
	assert.equal(crate.price, 750);
	assert.ok(boxDefinition(CRATE));
});

test('deployed DB seeded with the old data: migration delists the catalog crate only', async () => {
	// Seed exactly like the currently deployed data (shopItem: true), then give a player crates.
	const crateSeed = gachaData.find((g) => g.name === CRATE);
	crateSeed.shopItem = true;
	try {
		await seedStatic();
	}
	finally {
		crateSeed.shopItem = false;
	}
	assert.equal((await catalogCrate()).shopItem, true);
	assert.ok((await shopNames()).includes(CRATE));
	assert.ok((await shopGachaLabels()).includes(CRATE));

	await makeUser('owner-l5');
	await giveBox('owner-l5', CRATE, 2);
	const ownedBefore = await ItemData.find({ user: 'owner-l5', name: CRATE }).lean();
	assert.equal(ownedBefore.length, 1);
	assert.equal(ownedBefore[0].count, 2);
	const otherShopBefore = (await shopNames()).filter((n) => n !== CRATE).sort();

	// Full bootstrap (seed + migrations): the seed never rewrites the existing row, the migration does.
	const lines = [];
	await runMigrations((msg) => lines.push(msg));
	assert.deepEqual(lines.filter((l) => l.includes('delistFishingCrate')), [
		'Migration delistFishingCrate: 1 catalog row(s) removed from the shop (shopItem -> false); owned crates untouched.',
	]);
	await bootstrap();

	const crate = await catalogCrate();
	assert.equal(crate.shopItem, false);
	assert.equal(crate.price, 750);
	assert.equal(await Item.countDocuments({ name: CRATE }), 1);
	assert.ok(!(await shopNames()).includes(CRATE));
	assert.ok(!(await shopGachaLabels()).includes(CRATE));
	assert.deepEqual((await shopNames()).sort(), otherShopBefore, 'other shop items unchanged');

	// Owned crates are untouched (same documents, same fields) and still open.
	const ownedAfter = await ItemData.find({ user: 'owner-l5', name: CRATE }).lean();
	assert.deepEqual(ownedAfter, ownedBefore);
	const r = await openBox({ userId: 'owner-l5', boxName: CRATE });
	assert.equal(r.status, 'ok');
	assert.equal(r.slots.length, 3);
	const left = await ItemData.find({ user: 'owner-l5', name: CRATE }).lean();
	assert.equal(left.reduce((s, i) => s + (i.count || 0), 0), 1);
});

test('migration is idempotent: re-running changes nothing and logs nothing', async () => {
	const before = await Item.find({}).sort({ _id: 1 }).lean();
	const ownedBefore = await ItemData.find({}).sort({ _id: 1 }).lean();
	assert.deepEqual(await migrateDelistFishingCrate(), { delisted: 0 });
	const lines = [];
	await runMigrations((msg) => lines.push(msg));
	assert.equal(lines.filter((l) => l.includes('delistFishingCrate')).length, 0);
	assert.deepEqual(await Item.find({}).sort({ _id: 1 }).lean(), before);
	assert.deepEqual(await ItemData.find({}).sort({ _id: 1 }).lean(), ownedBefore);
});

test('a fresh seed gives shopItem false and the crate is not in the shop', async () => {
	await mongoose.connection.db.dropDatabase();
	await bootstrap();
	const crate = await catalogCrate();
	assert.equal(crate.shopItem, false);
	assert.equal(crate.price, 750);
	assert.ok(!(await shopNames()).includes(CRATE));
	assert.deepEqual(await migrateDelistFishingCrate(), { delisted: 0 });
});
