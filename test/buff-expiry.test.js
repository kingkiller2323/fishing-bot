// Hotfix L1 (B3): buffs are checked for expiry when they are read, not only by the slash-command
// sweep. An activated buff past its endTime must do nothing on button paths (Fish again -> castLine,
// Sell button, Open again -> openLine) or on /sell; an unexpired buff keeps working as before.
const test = require('node:test');
const assert = require('node:assert/strict');
const { startDb, stopDb } = require('./helpers/db');
const { quiet, restore } = require('./helpers/quiet');
const { seedGame, makeUser, giveFish, reload } = require('./helpers/fixtures');
const { addPoolFish, useTestRod } = require('./helpers/castFixtures');
const { giveBox } = require('./helpers/gachaFixtures');
const { castLine } = require('../src/engine/cast');
const { openLine } = require('../src/engine/gacha');
const { activeBuffFilter } = require('../src/engine/buffs');
const { Fish } = require('../src/class/Fish');
const { FishData } = require('../src/schemas/FishSchema');
const { BuffData } = require('../src/schemas/BuffSchema');
const sellOneFish = require('../src/components/buttons/sell-one-fish');

const HOUR = 60 * 60 * 1000;

test.before(async () => {
	quiet();
	await startDb();
	await seedGame();
	await addPoolFish([{ name: 'Expiry Minnow', rarity: 'Common' }]);
});
test.after(async () => {
	await stopDb();
	restore();
});

/** An activated buff (as startBooster leaves it) ending at `endTime`; `undefined` = no endTime. */
async function activeBuff(userId, capabilities, endTime) {
	const fields = { name: `Test ${capabilities[0]} buff`, user: userId, active: true, capabilities, length: HOUR };
	if (endTime !== undefined) fields.endTime = endTime;
	return BuffData.create(fields);
}

async function angler(userId) {
	await makeUser(userId);
	await useTestRod(userId, { capabilities: ['weak', '1'] });
}

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

async function sellByButton(userId, catchKey, value) {
	const user = await makeUser(userId);
	const f = await giveFish(user, 'Tuna', { value });
	await FishData.updateOne({ _id: f._id }, { $set: { castId: catchKey } });
	const before = (await reload(user)).user.inventory.money;
	await sellOneFish.run({}, sellInteraction(userId), null, catchKey);
	return (await reload(user)).user.inventory.money - before;
}

test('filter: expired buffs are excluded, unexpired and endTime-less buffs are kept (same rule as the sweep)', async () => {
	const now = Date.now();
	await activeBuff('filter', ['xp', '2.0'], now - 1);
	await activeBuff('filter', ['cash', '2.0'], now);
	const live = await activeBuff('filter', ['gacha', '1.5'], now + HOUR);
	const legacy = await activeBuff('filter', ['xp', '1.5']);
	await BuffData.create({ name: 'Inactive', user: 'filter', active: false, capabilities: ['cash', '3'], endTime: now + HOUR });

	const found = await BuffData.find(activeBuffFilter('filter', now));
	assert.deepEqual(found.map((b) => String(b._id)).sort(), [String(live._id), String(legacy._id)].sort());
	// Accepts a Date (the engines' clock) as well as epoch ms.
	assert.equal((await BuffData.find(activeBuffFilter('filter', new Date(now)))).length, 2);
});

test('Fish again (castLine): an expired XP buff has no effect', async () => {
	await angler('cast-expired');
	await activeBuff('cast-expired', ['xp', '2.0'], Date.now() - HOUR);
	const r = await castLine({ userId: 'cast-expired' });
	assert.equal(r.status, 'ok');
	assert.deepEqual(r.buffs, []);
	assert.equal(r.xp.multiplier, 1);
});

test('Fish again (castLine): an unexpired XP buff still applies', async () => {
	await angler('cast-live');
	await activeBuff('cast-live', ['xp', '2.0'], Date.now() + HOUR);
	const r = await castLine({ userId: 'cast-live' });
	assert.equal(r.status, 'ok');
	assert.equal(r.buffs.length, 1);
	assert.equal(r.xp.multiplier, 2);
});

test('castLine judges expiry by its own clock (ctx.now)', async () => {
	await angler('cast-clock');
	const endTime = Date.now() + HOUR;
	await activeBuff('cast-clock', ['xp', '2.0'], endTime);
	assert.equal((await castLine({ userId: 'cast-clock', now: new Date(endTime - 1) })).xp.multiplier, 2);
	assert.equal((await castLine({ userId: 'cast-clock', now: new Date(endTime) })).xp.multiplier, 1);
});

test('Sell button: an expired cash buff has no effect', async () => {
	await activeBuff('button-expired', ['cash', '2.0'], Date.now() - HOUR);
	assert.equal(await sellByButton('button-expired', 'bbbbbbbbbbbbbbbbbbbbbbbb', 40), 40);
});

test('Sell button: an unexpired cash buff still applies', async () => {
	await activeBuff('button-live', ['cash', '2.0'], Date.now() + HOUR);
	assert.equal(await sellByButton('button-live', 'cccccccccccccccccccccccc', 40), 80);
});

test('/sell (sellByRarity): an expired cash buff has no effect', async () => {
	const user = await makeUser('sell-expired');
	await giveFish(user, 'Tuna', { value: 70, rarity: 'Common' });
	await activeBuff('sell-expired', ['cash', '2.0'], Date.now() - HOUR);
	const result = await Fish.sellByRarity('sell-expired', 'common');
	assert.equal(result.total, 70);
	assert.equal(result.sold, 1);
});

test('/sell (sellByRarity): an unexpired cash buff still applies', async () => {
	const user = await makeUser('sell-live');
	await giveFish(user, 'Tuna', { value: 70, rarity: 'Common' });
	await activeBuff('sell-live', ['cash', '2.0'], Date.now() + HOUR);
	const result = await Fish.sellByRarity('sell-live', 'common');
	assert.equal(result.total, 140);
});

test('Open again (openLine): an expired gacha buff has no effect', async () => {
	await makeUser('gacha-expired');
	await giveBox('gacha-expired', 'Daily Box', 1);
	await activeBuff('gacha-expired', ['gacha', '1.5'], Date.now() - HOUR);
	const r = await openLine({ userId: 'gacha-expired', boxName: 'Daily Box' });
	assert.equal(r.status, 'ok');
	assert.ok(!r.modifiers.sources.some((s) => s.source === 'buff'));
	assert.ok(!(r.modifiers.stats.rareFind > 0));
});

test('Open again (openLine): an unexpired gacha buff still applies', async () => {
	await makeUser('gacha-live');
	await giveBox('gacha-live', 'Daily Box', 1);
	await activeBuff('gacha-live', ['gacha', '1.5'], Date.now() + HOUR);
	const r = await openLine({ userId: 'gacha-live', boxName: 'Daily Box' });
	assert.equal(r.status, 'ok');
	assert.equal(r.modifiers.sources.filter((s) => s.source === 'buff').length, 1);
	assert.equal(r.modifiers.stats.rareFind, 0.5);
});
