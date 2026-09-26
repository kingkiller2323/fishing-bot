// Shop purchases pay with one guarded atomic debit at click time: a stale User snapshot (loaded
// when a select menu fired) can never buy more than the player can pay for.
const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { ComponentType } = require('discord.js');
const { startDb, stopDb } = require('./helpers/db');
const { quiet, restore } = require('./helpers/quiet');
const { seedGame, makeUser } = require('./helpers/fixtures');
const { purchase } = require('../src/engine/purchase');
const { User } = require('../src/class/User');
const { User: UserModel } = require('../src/schemas/UserSchema');
const { Item, ItemData } = require('../src/schemas/ItemSchema');
const { Rod } = require('../src/schemas/RodSchema');
const buyOther = require('../src/components/buttons/buy-other');
const buyBait = require('../src/components/buttons/buy-bait');
const buyRod = require('../src/components/buttons/buy-rod');

test.before(async () => {
	quiet();
	await startDb();
	await seedGame();
});
test.after(async () => {
	await stopDb();
	restore();
});

async function setMoney(userId, amount) {
	await UserModel.updateOne({ userId }, { $set: { 'inventory.money': amount } });
}
async function money(userId) {
	return (await UserModel.findOne({ userId }).lean()).inventory.money;
}
/** Total count of the named item across the player's inventory list (`gacha`, `baits`, `rods`...). */
async function owned(userId, list, name) {
	const doc = await UserModel.findOne({ userId }).lean();
	const items = await ItemData.find({ _id: { $in: doc.inventory[list] }, name }).lean();
	return items.reduce((n, it) => n + (list === 'rods' ? 1 : (it.count || 0)), 0);
}

// ---- engine -------------------------------------------------------------------------------

test('two racing purchases from stale wrappers: only the one that can be paid for grants', async () => {
	await makeUser('race');
	await setMoney('race', 100);
	// Two stale wrappers, both believing the player has 100.
	const a = new User(await User.get('race'));
	const b = new User(await User.get('race'));
	assert.equal(await a.getMoney(), 100);
	assert.equal(await b.getMoney(), 100);

	let grants = 0;
	const grant = async () => { grants++; };
	const [ra, rb] = await Promise.all([
		purchase(await a.getUserId(), 60, grant),
		purchase(await b.getUserId(), 60, grant),
	]);
	assert.deepEqual([ra.ok, rb.ok].sort(), [false, true]);
	assert.equal(grants, 1);
	assert.equal(await money('race'), 40);
	assert.equal((ra.ok ? rb : ra).balance, 40, 'the failed purchase reports the real balance');
});

test('a stale snapshot showing enough money cannot pay: the debit checks the live balance', async () => {
	await makeUser('stale');
	await setMoney('stale', 100);
	const snapshot = new User(await User.get('stale'));
	// Spent elsewhere after the snapshot was taken.
	await setMoney('stale', 50);
	assert.equal(await snapshot.getMoney(), 100);

	let granted = false;
	const r = await purchase('stale', 60, async () => { granted = true; });
	assert.equal(r.ok, false);
	assert.equal(granted, false);
	assert.equal(await money('stale'), 50);
});

test('the grant sees the debited balance, so its whole-document save keeps the payment', async () => {
	await makeUser('fresh');
	await setMoney('fresh', 1000);
	const crate = await Item.findOne({ name: 'Fishing Crate' });
	const r = await purchase('fresh', 750, (u) => u.sendToInventory(crate, 1));
	assert.equal(r.ok, true);
	assert.equal(r.balance, 250);
	assert.equal(await money('fresh'), 250);
	assert.equal(await owned('fresh', 'gacha', 'Fishing Crate'), 1);
});

test('a failing grant is refunded', async () => {
	await makeUser('refund');
	await setMoney('refund', 100);
	await assert.rejects(purchase('refund', 60, async () => { throw new Error('boom'); }), /boom/);
	assert.equal(await money('refund'), 100);
});

test('exact balance can pay; one more cannot; money never goes negative', async () => {
	await makeUser('exact');
	await setMoney('exact', 60);
	assert.equal((await purchase('exact', 60)).ok, true);
	assert.equal((await purchase('exact', 1)).ok, false);
	assert.equal(await money('exact'), 0);
	await assert.rejects(purchase('exact', -5), /Invalid purchase cost/);
	await assert.rejects(purchase('exact', NaN), /Invalid purchase cost/);
});

// ---- handlers (fake discord.js interactions) ------------------------------------------------

class FakeCollector extends EventEmitter {
	constructor(filter) {
		super();
		this.filter = filter;
		this.ended = false;
	}
	stop(reason = 'user') {
		if (this.ended) return;
		this.ended = true;
		this.emit('end', [], reason);
	}
}

/** One shop message: every collector created on it, and a way to click components on it. */
function fakeMessage(id) {
	const collectors = [];
	const response = {
		createMessageComponentCollector: ({ filter }) => {
			const c = new FakeCollector(filter);
			collectors.push(c);
			return c;
		},
	};
	const rows = () => [1, 2, 3].map(() => ({ type: ComponentType.ActionRow, components: [] }));
	const replies = [];
	const interaction = (userId, fields = {}) => ({
		user: { id: userId },
		message: { id, embeds: [], components: rows() },
		update: async () => response,
		reply: async (payload) => { replies.push(payload); },
		followUp: async (payload) => { replies.push(payload); },
		...fields,
	});
	/** Delivers a component click to every live collector that accepts it, as discord.js does. */
	async function click(userId, fields) {
		const i = interaction(userId, fields);
		const live = collectors.filter((c) => !c.ended && c.filter(i));
		await Promise.all(live.flatMap((c) => c.listeners('collect').map((fn) => fn(i))));
		return live.length;
	}
	return { collectors, interaction, click, replies };
}

const analytics = { setStatus: async () => undefined, setStatusMessage: async () => undefined };

test('buy-other: selecting a crate twice then buying 10 on each menu never grants unpaid crates', async () => {
	const uid = 'shop-other';
	await makeUser(uid);
	const crate = await Item.findOne({ name: 'Fishing Crate' });
	// Enough for exactly one lot of 10.
	await setMoney(uid, crate.price * 10);
	const msg = fakeMessage('m-other');

	// Open the shop select twice on the same message, then select the crate twice.
	await buyOther.run(null, msg.interaction(uid), analytics);
	await buyOther.run(null, msg.interaction(uid), analytics);
	await msg.click(uid, { customId: 'select-item', values: [crate._id.toString()] });
	await msg.click(uid, { customId: 'select-item', values: [crate._id.toString()] });

	// Click "Buy 10" twice; each click is delivered to every live amount collector.
	await msg.click(uid, { customId: 'buy-ten' });
	await msg.click(uid, { customId: 'buy-ten' });

	const left = await money(uid);
	const crates = await owned(uid, 'gacha', 'Fishing Crate');
	assert.ok(left >= 0);
	assert.equal(crates * crate.price, crate.price * 10 - left, 'items granted equal items paid for');
	assert.equal(crates, 10);
	assert.equal(left, 0);
	// Only one select and one amount collector remain live on the message.
	assert.equal(msg.collectors.filter((c) => !c.ended).length, 2);
});

test('buy-other: a stale select snapshot cannot buy after the money was spent elsewhere', async () => {
	const uid = 'shop-other-stale';
	await makeUser(uid);
	const crate = await Item.findOne({ name: 'Fishing Crate' });
	await setMoney(uid, crate.price * 5);
	const msg = fakeMessage('m-other-stale');
	await buyOther.run(null, msg.interaction(uid), analytics);
	await msg.click(uid, { customId: 'select-item', values: [crate._id.toString()] });

	// Spent after the menu was opened.
	await setMoney(uid, crate.price * 2);
	await msg.click(uid, { customId: 'buy-five' });
	assert.equal(await money(uid), crate.price * 2);
	assert.equal(await owned(uid, 'gacha', 'Fishing Crate'), 0);
	const last = msg.replies.at(-1);
	assert.equal(last.embeds[0].data.fields[0].value, 'You do not have enough money to buy that amount');
});

test('buy-bait: racing buys on stale menus grant only what was paid for', async () => {
	const uid = 'shop-bait';
	await makeUser(uid);
	const bait = await Item.findOne({ type: 'bait', shopItem: true, price: { $gt: 0 } }).sort({ name: 1 });
	await UserModel.updateOne({ userId: uid }, { $set: { xp: 10_000_000 } });
	const before = await owned(uid, 'baits', bait.name);
	await setMoney(uid, bait.price * 10);
	const msg = fakeMessage('m-bait');
	await buyBait.run(null, msg.interaction(uid), analytics);
	await msg.click(uid, { customId: 'select-bait', values: [bait._id.toString()] });

	// Two "Buy 10" clicks racing on the same menu.
	await Promise.all([msg.click(uid, { customId: 'buy-ten' }), msg.click(uid, { customId: 'buy-ten' })]);
	const left = await money(uid);
	const got = (await owned(uid, 'baits', bait.name)) - before;
	assert.ok(left >= 0);
	assert.equal(got * bait.price, bait.price * 10 - left);
	assert.equal(got, 10);
});

test('buy-rod: two stale rod selects buy one rod for one payment', async () => {
	const uid = 'shop-rod';
	await makeUser(uid);
	// The seeded catalog has no shop rods: add one modelled on the starter rod.
	const base = (await Item.findOne({ name: 'Old Rod' }).lean());
	delete base._id;
	const rod = await Rod.create({ ...base, name: 'Test Shop Rod', price: 500, shopItem: true });
	await UserModel.updateOne({ userId: uid }, { $set: { xp: 10_000_000 } });
	const before = await owned(uid, 'rods', rod.name);
	await setMoney(uid, rod.price);
	const msg = fakeMessage('m-rod');
	await buyRod.run(null, msg.interaction(uid), analytics);
	await Promise.all([
		msg.click(uid, { customId: 'select-rod', values: [rod._id.toString()] }),
		msg.click(uid, { customId: 'select-rod', values: [rod._id.toString()] }),
	]);
	assert.equal(await money(uid), 0);
	assert.equal((await owned(uid, 'rods', rod.name)) - before, 1);
});
