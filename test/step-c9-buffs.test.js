// Step C.9 (dark behind the 5B flag): buffs: one unit per activation, real-time duration, queue and its
// bound, read-time expiry, Double Cash stamped at catch (no sale path doubles), additive stacking with
// events, Lucky Draw bonus slots spent exactly once.
const test = require('node:test');
const assert = require('node:assert/strict');
const mongoose = require('mongoose');
const { startDb, stopDb } = require('./helpers/db');
const { quiet, restore } = require('./helpers/quiet');
const { seedGame, makeUser } = require('./helpers/fixtures');
const { userDoc } = require('./helpers/castFixtures');
const { with5b } = require('./helpers/withFlag');
const { castLine, applyCastResult } = require('../src/engine/cast');
const { openLine, applyGachaResult, recoverPendingOpens } = require('../src/engine/gacha');
const buffs5b = require('../src/engine/b5/buffs');
const { Fish } = require('../src/class/Fish');
const { User: UserModel } = require('../src/schemas/UserSchema');
const { Item, ItemData } = require('../src/schemas/ItemSchema');
const { BuffData } = require('../src/schemas/BuffSchema');
const { GachaOpen } = require('../src/schemas/GachaOpenSchema');
const { FishData } = require('../src/schemas/FishSchema');
const { rng } = require('../src/engine/rng');

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

async function giveBuff(userId, name, count) {
	const t = await Item.collection.findOne({ name, user: null });
	const _id = new mongoose.Types.ObjectId();
	await BuffData.collection.insertOne({ ...t, _id, __t: 'BuffData', user: userId, count, active: false });
	await UserModel.updateOne({ userId }, { $push: { 'inventory.buffs': _id }, $set: { permits: [] } });
	return _id;
}

test('activation: one unit, one real hour; queued up to 3; QUEUE_FULL keeps the unit; NO_STOCK at zero', async () => {
	await makeUser('c9-act');
	const id = await giveBuff('c9-act', 'Double XP', 5);
	await with5b(async () => {
		const t0 = Date.parse('2026-10-01T10:00:00Z');
		const a = await buffs5b.activate('c9-act', id, t0);
		assert.equal(a.state.endsAt, t0 + 3600e3);
		const b = await buffs5b.activate('c9-act', id, t0 + 1800e3);
		assert.equal(b.state.endsAt, t0 + 7200e3, 'extended, multiplier stays x2');
		assert.equal(b.state.multiplier, 2);
		await buffs5b.activate('c9-act', id, t0 + 1800e3);
		const full = await buffs5b.activate('c9-act', id, t0 + 1800e3);
		assert.equal(full.code, 'QUEUE_FULL');
		assert.equal((await BuffData.collection.findOne({ _id: id })).count, 2, 'the refused unit is kept');
		// Read-time expiry.
		const u = await userDoc('c9-act');
		assert.equal(buffs5b.effectsAt(u, t0 + 3 * 3600e3 + 1).xp, null);
	});
	const two = await giveBuff('c9-act', 'Double Cash', 1);
	await with5b(async () => {
		const [x, y] = await Promise.all([buffs5b.activate('c9-act', two), buffs5b.activate('c9-act', two)]);
		assert.deepEqual([x.ok, y.ok].sort(), [false, true]);
		assert.equal((await BuffData.collection.findOne({ _id: two })).count, 0);
	});
});

test('Double Cash is stamped at catch into value and valueBase; a sale pays the stored value only', async () => {
	await makeUser('c9-cash');
	const id = await giveBuff('c9-cash', 'Double Cash', 1);
	await with5b(async () => {
		rng.seed(3);
		const plainCast = await castLine({ userId: 'c9-cash' });
		await buffs5b.activate('c9-cash', id);
		rng.seed(3);
		const buffed = await castLine({ userId: 'c9-cash' });
		rng.reset();
		const f0 = plainCast.catches.find((c) => c.kind === 'fish');
		const f1 = buffed.catches.find((c) => c.kind === 'fish');
		assert.equal(f1.rawValue, f0.rawValue);
		assert.equal(f1.value, Math.round(f0.rawValue * 2));
		assert.equal(f1.reward.base, f1.value, 'public base includes the buff');
		await applyCastResult(buffed);
		// Sell while the buff is still active: paid exactly the stored value.
		const stored = (await FishData.find({ castId: buffed.castId }).lean()).reduce((s, d) => s + d.value * d.count, 0);
		const before = (await userDoc('c9-cash')).inventory.money;
		const sale = await Fish.sellByRarity('c9-cash', 'all');
		assert.equal(sale.total, stored + 0, 'no sale-time doubling');
		assert.equal((await userDoc('c9-cash')).inventory.money, before + sale.total);
	});
});

test('stacking: a buff and an event of the same category add (x3, not x4)', async () => {
	await makeUser('c9-event');
	const id = await giveBuff('c9-event', 'Double Cash', 1);
	const balance = require('../src/engine/balance');
	await with5b(async () => {
		await buffs5b.activate('c9-event', id);
		balance.EVENTS.push({ name: 'test', startsAt: '2000-01-01', endsAt: '2100-01-01', stats: {}, multipliers: { sell: 2 } });
		try {
			const r = await castLine({ userId: 'c9-event' });
			assert.equal(r.modifiers.sell.multiplier, 3);
		}
		finally {
			balance.EVENTS.pop();
		}
	});
});

test('Lucky Draw: one bonus slot on each of the next 2 opens; Booster Packs use none; a recovered open spends once', async () => {
	await makeUser('c9-lucky');
	const id = await giveBuff('c9-lucky', 'Lucky Draw', 1);
	const box = await Item.collection.findOne({ name: 'Daily Box', user: null });
	const boxId = new mongoose.Types.ObjectId();
	await ItemData.collection.insertOne({ ...box, _id: boxId, __t: 'GachaData', user: 'c9-lucky', count: 5 });
	await UserModel.updateOne({ userId: 'c9-lucky' }, { $push: { 'inventory.gacha': boxId } });
	await with5b(async () => {
		assert.equal((await buffs5b.activate('c9-lucky', id)).state.chargesLeft, 2);
		const r1 = await openLine({ userId: 'c9-lucky', boxName: 'Daily Box' });
		assert.equal(r1.slots.length, 4);
		// Journal it, recover twice: one charge spent.
		await GachaOpen.create({ _id: r1.openId, userId: r1.userId, result: r1, status: 'pending' });
		await recoverPendingOpens({ userId: 'c9-lucky' });
		await recoverPendingOpens({ userId: 'c9-lucky' });
		assert.equal((await userDoc('c9-lucky')).activeBuffs.gacha.chargesLeft, 1);
		const r2 = await openLine({ userId: 'c9-lucky', boxName: 'Daily Box' });
		assert.equal(r2.slots.length, 4);
		await applyGachaResult(r2);
		const r3 = await openLine({ userId: 'c9-lucky', boxName: 'Daily Box' });
		assert.equal(r3.slots.length, 3, 'charges used up');
		assert.equal(buffs5b.luckyDrawFor({ activeBuffs: { gacha: { chargesLeft: 2, bonusSlots: 1 } } }, 'Booster Pack'), null);
	});
});
