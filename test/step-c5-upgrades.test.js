// Step C.5 (dark behind the 5B flag): Angler Upgrades: prices and unlocks from the data, guarded purchase,
// effects in the cast, Bait Conservation.
const test = require('node:test');
const assert = require('node:assert/strict');
const mongoose = require('mongoose');
const { startDb, stopDb } = require('./helpers/db');
const { quiet, restore } = require('./helpers/quiet');
const { seedGame, makeUser } = require('./helpers/fixtures');
const { userDoc } = require('./helpers/castFixtures');
const { with5b } = require('./helpers/withFlag');
const { castLine } = require('../src/engine/cast');
const up = require('../src/engine/b5/upgrades');
const levels = require('../src/engine/levels');
const { User: UserModel } = require('../src/schemas/UserSchema');
const { Item, ItemData } = require('../src/schemas/ItemSchema');
const { rng } = require('../src/engine/rng');
const model = require('../scripts/economy/5b/upgrades');

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

async function atLevel(userId, level, money) {
	const xp = levels.CURVES['5b'].xpForLevel(level);
	await UserModel.updateOne({ userId }, { $set: { xp, publicXp: xp, level, levelFloor: level, publicLevelFloor: level, 'inventory.money': money, permits: [] } });
}

test('prices, per-level effects and unlock levels are the model\'s', async () => {
	const rows = model.priceTable();
	const data = require('../src/engine/data/balance-5b.json').upgrades;
	assert.equal(Object.keys(data.categories).length, 7);
	for (const r of rows) {
		assert.deepEqual(data.categories[r.key].prices, r.prices);
		assert.equal(data.categories[r.key].perLevel, r.perLevel);
	}
	assert.deepEqual(data.unlockLevels, [5, 15, 25, 35, 45, 55]);
});

test('buying: level gate, one charge under a double click, levels in order, max at 6', async () => {
	await makeUser('c5-buy');
	await with5b(async () => {
		await atLevel('c5-buy', 4, 1e6);
		assert.equal((await up.buyUpgrade('c5-buy', 'casting')).code, 'LEVEL_LOCKED');
		await atLevel('c5-buy', 5, 3000);
		const [a, b] = await Promise.all([up.buyUpgrade('c5-buy', 'casting'), up.buyUpgrade('c5-buy', 'casting')]);
		assert.deepEqual([a.ok, b.ok].sort(), [false, true]);
		let u = await userDoc('c5-buy');
		assert.equal(u.upgrades.casting, 1);
		assert.equal(u.inventory.money, 400);
		assert.equal((await up.buyUpgrade('c5-buy', 'casting')).code, 'LEVEL_LOCKED', 'L2 unlocks at Lv 15');
		await atLevel('c5-buy', 60, 1e6);
		for (let i = 0; i < 5; i++) assert.equal((await up.buyUpgrade('c5-buy', 'casting')).ok, true);
		assert.equal((await up.buyUpgrade('c5-buy', 'casting')).code, 'MAX');
		u = await userDoc('c5-buy');
		assert.equal(u.upgrades.casting, 6);
		assert.equal(u.inventory.money, 1e6 - (5400 + 9000 + 14000 + 25000 + 41000));
		assert.equal((await up.buyUpgrade('c5-buy', 'nonsense')).code, 'UNKNOWN');
	});
});

test('effects reach the cast: speed, Rare Find, sell, XP, durability efficiency', async () => {
	await makeUser('c5-cast');
	await UserModel.updateOne({ userId: 'c5-cast' }, { $set: { upgrades: { casting: 6, knowledge: 2, negotiation: 3, experience: 6, tackleCare: 1 }, permits: [] } });
	await with5b(async () => {
		const r = await castLine({ userId: 'c5-cast' });
		assert.equal(r.status, 'ok');
		assert.ok(Math.abs(r.modifiers.stats.fishingSpeed - 0.06) < 1e-9);
		assert.ok(Math.abs(r.modifiers.stats.rareFind - 0.1) < 1e-9);
		assert.ok(Math.abs(r.modifiers.stats.sellBonus - 0.06) < 1e-9);
		assert.ok(Math.abs(r.modifiers.stats.xpBonus - 0.03) < 1e-9);
		assert.ok(Math.abs(r.modifiers.stats.durabilityEfficiency - 0.05) < 1e-9);
		assert.equal(r.cooldownMs, 4700);
		assert.ok(r.modifiers.sources.some((s) => s.source === 'upgrades'));
	});
});

test('Bait Conservation: the saved share of casts keeps the unit', async () => {
	await makeUser('c5-bait');
	await UserModel.updateOne({ userId: 'c5-bait' }, { $set: { upgrades: { baitConservation: 6 }, permits: [] } });
	const t = await Item.collection.findOne({ name: 'Shrimp', user: null });
	const _id = new mongoose.Types.ObjectId();
	await ItemData.collection.insertOne({ ...t, _id, __t: 'BaitData', user: 'c5-bait', count: 1000 });
	await UserModel.updateOne({ userId: 'c5-bait' }, { $set: { 'inventory.equippedBait': _id } });
	await with5b(async () => {
		let saved = 0;
		const n = 400;
		for (let seed = 1; seed <= n; seed++) {
			rng.seed(seed);
			const r = await castLine({ userId: 'c5-bait' });
			if (r.bait.saved) saved++;
			assert.equal(r.bait.applied, true, 'a saved unit still applies');
		}
		rng.reset();
		assert.ok(Math.abs(saved / n - 0.24) < 0.06, `saved ${saved / n}`);
	});
});
