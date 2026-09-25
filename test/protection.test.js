const test = require('node:test');
const assert = require('node:assert/strict');
const { startDb, stopDb } = require('./helpers/db');
const { quiet, restore } = require('./helpers/quiet');
const { seedGame, makeUser, giveFish, reload } = require('./helpers/fixtures');
const { isProtected, partitionProtected, ProtectedFishError } = require('../src/engine/protection');
const { Fish } = require('../src/class/Fish');
const { FishData } = require('../src/schemas/FishSchema');
const sellOneFish = require('../src/components/buttons/sell-one-fish');

test.before(async () => {
	quiet();
	await startDb();
	await seedGame();
});
test.after(async () => {
	await stopDb();
	restore();
});

test('policy: locked fish are protected unless forced', () => {
	assert.equal(isProtected({ locked: true }), true);
	assert.equal(isProtected({ locked: false }), false);
	assert.equal(isProtected(null), false);
	const list = [{ name: 'a', locked: true }, { name: 'b' }, null];
	assert.deepEqual(partitionProtected(list).allowed.map((f) => f.name), ['b']);
	assert.deepEqual(partitionProtected(list).protected.map((f) => f.name), ['a']);
	assert.equal(partitionProtected(list, { force: true }).allowed.length, 2);
});

test('sell by rarity skips locked fish and pays only for sold ones', async () => {
	const user = await makeUser('seller-rarity');
	const keep = await giveFish(user, 'Sardine', { locked: true, value: 50 });
	const sell = await giveFish(user, 'Tuna', { value: 70, rarity: 'Common' });
	const moneyBefore = (await reload(user)).user.inventory.money;

	const result = await Fish.sellByRarity('seller-rarity', 'common');

	assert.deepEqual(result, { total: 70, sold: 1, protected: 1 });
	const after = await reload(user);
	const inv = after.user.inventory.fish.map(String);
	assert.ok(inv.includes(String(keep._id)), 'locked fish kept');
	assert.ok(!inv.includes(String(sell._id)), 'unlocked fish sold');
	assert.equal(after.user.inventory.money, moneyBefore + 70);
});

test('sell all never sells locked fish', async () => {
	const user = await makeUser('seller-all');
	const keep = await giveFish(user, 'Kraken', { locked: true, value: 5000 });
	await giveFish(user, 'Sardine', { value: 10 });
	await giveFish(user, 'Anchovy', { value: 20 });

	const result = await Fish.sellByRarity('seller-all', 'all');

	assert.equal(result.total, 30);
	assert.equal(result.protected, 1);
	assert.deepEqual((await reload(user)).user.inventory.fish.map(String), [String(keep._id)]);
});

test('removeFish refuses a locked fish unless forced', async () => {
	const user = await makeUser('remover');
	const locked = await giveFish(user, 'Sardine', { locked: true });
	await assert.rejects(() => user.removeFish(locked._id), ProtectedFishError);
	assert.ok((await reload(user)).user.inventory.fish.map(String).includes(String(locked._id)));

	await user.removeFish(locked._id, 1, { force: true });
	assert.ok(!(await reload(user)).user.inventory.fish.map(String).includes(String(locked._id)));
});

test('removeListOfFish removes only unprotected fish', async () => {
	const user = await makeUser('list-remover');
	const a = await giveFish(user, 'Sardine', { locked: true });
	const b = await giveFish(user, 'Anchovy');
	const removed = await user.removeListOfFish([a._id, b._id]);
	assert.deepEqual(removed, [String(b._id)]);
	assert.deepEqual((await reload(user)).user.inventory.fish.map(String), [String(a._id)]);
});

// Minimal stand-in for a Discord button interaction on a /fish result message.
function sellInteraction(userId) {
	const calls = {};
	return {
		calls,
		user: { id: userId },
		message: {
			embeds: [{ data: { title: 'catch', description: 'x' }, toJSON() { return this.data; } }],
			components: [{ components: [{ type: 2, custom_id: 'fish-again', style: 1, label: 'Fish again' }, { type: 2, custom_id: 'sell', style: 4, label: 'Sell' }] }],
		},
		reply: async (payload) => { calls.reply = payload; },
		update: async (payload) => { calls.update = payload; },
	};
}

test('Sell button refuses a fully locked catch', async () => {
	const user = await makeUser('button-locked');
	const f = await giveFish(user, 'Sardine', { locked: true });
	await FishData.updateOne({ _id: f._id }, { $set: { catchId: 901 } });

	const interaction = sellInteraction('button-locked');
	await sellOneFish.run({}, interaction, null, '901');

	assert.match(interaction.calls.reply.content, /locked/);
	assert.equal(interaction.calls.update, undefined);
	assert.ok((await reload(user)).user.inventory.fish.map(String).includes(String(f._id)));
});

test('Sell button sells unlocked fish, keeps locked ones and shows the sale', async () => {
	const user = await makeUser('button-mixed');
	const locked = await giveFish(user, 'Sardine', { locked: true, value: 10 });
	const free = await giveFish(user, 'Anchovy', { value: 25 });
	await FishData.updateMany({ _id: { $in: [locked._id, free._id] } }, { $set: { catchId: 902 } });

	const interaction = sellInteraction('button-mixed');
	await sellOneFish.run({}, interaction, null, '902');

	const embed = interaction.calls.update.embeds[0].toJSON();
	assert.ok(embed.fields.some((field) => /\$25/.test(field.value) && /1 locked fish kept/.test(field.value)));
	const inv = (await reload(user)).user.inventory.fish.map(String);
	assert.ok(inv.includes(String(locked._id)));
	assert.ok(!inv.includes(String(free._id)));
});
