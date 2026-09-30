// Step C.4 (dark behind the 5B flag): bait read by name from the 5B roster, one unit per cast, only where it
// works (biome and shop level), Shrimp/Worm strong access, the Spinner clamp, legacy stacks.
const test = require('node:test');
const assert = require('node:assert/strict');
const mongoose = require('mongoose');
const { startDb, stopDb } = require('./helpers/db');
const { quiet, restore } = require('./helpers/quiet');
const { seedGame, makeUser } = require('./helpers/fixtures');
const { userDoc } = require('./helpers/castFixtures');
const { with5b } = require('./helpers/withFlag');
const { castLine, applyCastResult } = require('../src/engine/cast');
const rodOps = require('../src/engine/b5/rodOps');
const mc = require('../src/engine/b5/multicatch');
const levels = require('../src/engine/levels');
const { User: UserModel } = require('../src/schemas/UserSchema');
const { Item, ItemData } = require('../src/schemas/ItemSchema');
const { rng } = require('../src/engine/rng');
const baitModel = require('../scripts/economy/5b/bait');

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

const ALL = ['Ocean', 'River', 'Lake', 'Pond', 'Coast', 'Swamp', 'Mountain Stream'].map((biome) => ({ biome, source: 'purchased' }));

async function player(userId, { level, biome = 'ocean', money = 0 }) {
	await makeUser(userId);
	const xp = levels.CURVES['5b'].xpForLevel(level);
	await UserModel.updateOne({ userId }, { $set: { xp, publicXp: xp, level, levelFloor: level, publicLevelFloor: level, currentBiome: biome, permits: ALL, 'inventory.money': money } });
}

/** Equips a copy of a catalog bait; `fields` overrides cloned fields (legacy stacks). */
async function equipBait(userId, name, count = 5, fields = {}) {
	const t = await Item.collection.findOne({ name, user: null });
	const _id = new mongoose.Types.ObjectId();
	await ItemData.collection.insertOne({ ...t, _id, __t: 'BaitData', user: userId, count, ...fields });
	await UserModel.updateOne({ userId }, { $set: { 'inventory.equippedBait': _id }, $push: { 'inventory.baits': _id } });
	return _id;
}

test('the roster matches the model; the shop overlay sells packs of 10', async () => {
	const data = require('../src/engine/data/balance-5b.json');
	for (const [name, p] of Object.entries(baitModel.prices())) {
		assert.equal(data.bait.roster[name].packPrice, p.packPrice, name);
		assert.equal(data.catalog.overlay[name].price, p.packPrice, name);
		assert.equal(data.catalog.overlay[name].packSize, 10);
	}
});

test('one unit per cast whatever the catch; Shrimp gives the Old Rod strong access in the Ocean', async () => {
	await player('c4-shrimp', { level: 1 });
	await equipBait('c4-shrimp', 'Shrimp', 3);
	await with5b(async () => {
		const r = await castLine({ userId: 'c4-shrimp' });
		assert.equal(r.status, 'ok');
		assert.equal(r.bait.applied, true);
		assert.equal(r.bait.consumed, 1);
		assert.deepEqual([...r.draws.qualities].sort(), ['strong', 'weak']);
		await applyCastResult(r);
	});
	const u = await userDoc('c4-shrimp');
	assert.equal((await ItemData.collection.findOne({ _id: u.inventory.equippedBait })).count, 2);
});

test('outside its biomes a bait gives nothing (no XP either) and is not used; legacy cloned fields are ignored', async () => {
	await player('c4-worm', { level: 25, biome: 'lake' });
	// A legacy Worm stack whose cloned fields say freshwater everywhere and XP ×2.
	await equipBait('c4-worm', 'Worm', 4, { biomes: ['river', 'lake', 'pond', 'swamp'], multiplier: 2, capabilities: ['weak', 'strong'] });
	await with5b(async () => {
		const r = await castLine({ userId: 'c4-worm' });
		assert.equal(r.status, 'ok');
		assert.equal(r.bait.applied, false);
		assert.equal(r.bait.wrongBiome, true);
		assert.equal(r.bait.consumed, 0);
		assert.equal(r.modifiers.stats.xpBonus, 0);
		assert.deepEqual(r.draws.qualities, ['weak']);
		await applyCastResult(r);
	});
	const u = await userDoc('c4-worm');
	assert.equal((await ItemData.collection.findOne({ _id: u.inventory.equippedBait })).count, 4);
});

test('a Strong Magnet stack below its shop level waits (Lv 40), then works everywhere', async () => {
	await player('c4-magnet', { level: 15, biome: 'river' });
	await equipBait('c4-magnet', 'Strong Magnet', 4, { requirements: { level: 0 } });
	await with5b(async () => {
		let r = await castLine({ userId: 'c4-magnet' });
		assert.equal(r.bait.applied, false);
		assert.equal(r.bait.levelLocked, true);
		assert.equal(r.bait.requiredLevel, 40);
		assert.equal(r.bait.consumed, 0);
		const xp = levels.CURVES['5b'].xpForLevel(40);
		await UserModel.updateOne({ userId: 'c4-magnet' }, { $set: { xp, publicXp: xp, levelFloor: 40, publicLevelFloor: 40 } });
		r = await castLine({ userId: 'c4-magnet' });
		assert.equal(r.bait.applied, true);
		assert.equal(r.modifiers.stats.luck, 4);
	});
});

test('Spinner: adds its chance, clamped at the 1.80 ceiling; a failed cast uses nothing', async () => {
	await player('c4-spin', { level: 60, biome: 'lake', money: 2e6 });
	await with5b(async () => {
		await rodOps.buyStandardRod('c4-spin', 'Summit Rod', { equip: true });
		await equipBait('c4-spin', 'Spinner', 3);
		const r = await castLine({ userId: 'c4-spin' });
		assert.equal(r.bait.applied, true);
		assert.equal(r.draws.capped, true);
		assert.ok(Math.abs(r.draws.multiChance - mc.chanceForMean(1.8)) < 1e-12);
		// A lower rod keeps the full +10%.
		await player('c4-spin2', { level: 20, biome: 'lake', money: 1e5 });
		await rodOps.buyStandardRod('c4-spin2', 'Angler\'s Rod', { equip: true });
		await equipBait('c4-spin2', 'Spinner', 3);
		const r2 = await castLine({ userId: 'c4-spin2' });
		assert.equal(r2.draws.capped, false);
		assert.ok(Math.abs(r2.draws.multiChance - (mc.chanceForMean(1.15) + 0.1)) < 1e-12);
		// Broken rod: the cast fails and the bait is untouched.
		const u = await userDoc('c4-spin2');
		await ItemData.collection.updateOne({ _id: u.inventory.equippedRod }, { $set: { state: 'broken' } });
		const f = await castLine({ userId: 'c4-spin2' });
		assert.equal(f.failure.code, 'ROD_BROKEN');
		assert.equal((await ItemData.collection.findOne({ _id: u.inventory.equippedBait })).count, 3);
	});
});

test('the last unit clears the equipped bait', async () => {
	await player('c4-last', { level: 1 });
	await equipBait('c4-last', 'Shrimp', 1);
	await with5b(async () => {
		const r = await castLine({ userId: 'c4-last' });
		assert.equal(r.bait.depleted, true);
		await applyCastResult(r);
	});
	assert.equal((await userDoc('c4-last')).inventory.equippedBait, null);
});
