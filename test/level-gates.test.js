// Level gates for rods and bait (hotfix L6): /equip, /craft, the bait shop and bait use at cast time
// all compare the item's requirements.level with the account's real level (User#getLevel). Already
// equipped gear is never unequipped.
const test = require('node:test');
const assert = require('node:assert/strict');
const mongoose = require('mongoose');
const { startDb, stopDb } = require('./helpers/db');
const { quiet, restore } = require('./helpers/quiet');
const { seedGame, makeUser } = require('./helpers/fixtures');
const { addPoolFish, useTestRod, useTestBait, userDoc } = require('./helpers/castFixtures');
const { castLine, applyCastResult } = require('../src/engine/cast');
const { requiredLevel, meetsLevelRequirement } = require('../src/engine/levelGate');
const { levelForXp } = require('../src/engine/balance');
const { ItemData, Item } = require('../src/schemas/ItemSchema');
const { CustomRodData } = require('../src/schemas/CustomRodSchema');
const { User: UserModel } = require('../src/schemas/UserSchema');
const { rng } = require('../src/engine/rng');
const equipCommand = require('../src/commands/slash/User/equip');
const buyBait = require('../src/components/buttons/buy-bait');

const EPHEMERAL = 64;

test.before(async () => {
	quiet();
	await startDb();
	await seedGame();
	await addPoolFish([{ name: 'Gate Minnow', rarity: 'Common' }]);
});
test.after(async () => {
	rng.reset();
	await stopDb();
	restore();
});

const discordUser = (id) => ({ id, username: `p${id}`, displayName: `P${id}`, globalName: `P${id}` });

/** Real level `level` exactly (xp at the start of that level). */
async function setLevel(userId, level) {
	const xp = (level * 10) ** 2;
	assert.equal(levelForXp(xp), level);
	await UserModel.updateOne({ userId }, { $set: { xp, publicXp: xp, level } });
}

/** Gives the player a copy of a catalog item and sets its level requirement. */
async function giveGated(userId, templateName, level, count = 1) {
	const user = await makeUser(userId);
	const template = await Item.findOne({ name: templateName, user: null });
	const { item } = await user.sendToInventory(template._id, count);
	await ItemData.collection.updateOne({ _id: item._id }, { $set: { 'requirements.level': level } });
	return String(item._id);
}

// /equip: button -> select menu -> selection. Records what the bot sends on each step.
function equipInteraction(userId, button, value) {
	const calls = { updates: [], followUps: [], edits: [] };
	const user = discordUser(userId);
	const selection = {
		user, customId: button === 'equip-rod' ? 'select-rod' : 'select-bait', values: [value],
		update: async (p) => { calls.updates.push(p); },
		followUp: async (p) => { calls.followUps.push(p); },
	};
	const choice = {
		user, customId: button,
		update: async (p) => { calls.updates.push(p); return { awaitMessageComponent: async () => selection }; },
	};
	const interaction = {
		user,
		reply: async () => ({ awaitMessageComponent: async () => choice }),
		editReply: async (p) => { calls.edits.push(p); },
	};
	return { interaction, calls };
}

async function equip(userId, button, value) {
	const { interaction, calls } = equipInteraction(userId, button, value);
	await equipCommand.run({}, interaction, null, interaction.user);
	assert.deepEqual(calls.edits, [], 'equip flow must not fall into its timeout/error branch');
	return calls;
}

const lastText = (calls) => JSON.stringify(calls.followUps.map((p) => p.embeds.map((e) => e.toJSON())));

test('levelGate helpers read requirements from documents and plain objects', async () => {
	assert.equal(requiredLevel(null), 0);
	assert.equal(requiredLevel({}), 0);
	assert.equal(requiredLevel({ requirements: { level: 0 } }), 0);
	assert.equal(requiredLevel({ requirements: { level: 12 } }), 12);
	assert.equal(requiredLevel(new CustomRodData({ requirements: { level: 30 } })), 30);
	assert.equal(meetsLevelRequirement(11, { requirements: { level: 12 } }), false);
	assert.equal(meetsLevelRequirement(12, { requirements: { level: 12 } }), true);
});

test('/equip does not level-gate rods yet (held until the rod progression redesign, L6B)', async () => {
	const rodId = await giveGated('eq-rod-low', 'Old Rod', 10);
	await setLevel('eq-rod-low', 9);
	const calls = await equip('eq-rod-low', 'equip-rod', rodId);
	assert.equal(calls.followUps.length, 0);
	assert.equal(String((await userDoc('eq-rod-low')).inventory.equippedRod), rodId);
});

test('/equip allows a rod at or above its level', async () => {
	for (const [id, level] of [['eq-rod-at', 10], ['eq-rod-above', 25]]) {
		const rodId = await giveGated(id, 'Old Rod', 10);
		await setLevel(id, level);
		const calls = await equip(id, 'equip-rod', rodId);
		assert.equal(calls.followUps.length, 0);
		assert.equal(String((await userDoc(id)).inventory.equippedRod), rodId);
	}
});

test('/equip refuses a bait above the player level and allows it at level', async () => {
	const low = await giveGated('eq-bait-low', 'Worm', 10, 5);
	await setLevel('eq-bait-low', 9);
	const refused = await equip('eq-bait-low', 'equip-bait', low);
	assert.equal(refused.followUps.length, 1);
	assert.equal(refused.followUps[0].flags, EPHEMERAL);
	assert.match(lastText(refused), /level 10/);
	assert.equal((await userDoc('eq-bait-low')).inventory.equippedBait, null);

	const at = await giveGated('eq-bait-at', 'Worm', 10, 5);
	await setLevel('eq-bait-at', 10);
	const allowed = await equip('eq-bait-at', 'equip-bait', at);
	assert.equal(allowed.followUps.length, 0);
	assert.equal(String((await userDoc('eq-bait-at')).inventory.equippedBait), at);
});

// Bait shop: buy-bait button -> bait select (collector) -> amount buttons (collector).
async function buyBaitFlow(userId, baitTemplateId) {
	const user = discordUser(userId);
	const calls = { replies: [], updates: [] };
	const collectors = [];
	const response = () => ({ createMessageComponentCollector: () => ({ on: (ev, fn) => { if (ev === 'collect') collectors.push(fn); }, stop: () => undefined }) });
	const message = () => ({ components: [], embeds: [] });
	const interaction = {
		user, message: message(),
		update: async (p) => { calls.updates.push(p); return response(); },
		reply: async (p) => { calls.replies.push(p); },
	};
	await buyBait.run({}, interaction, null);
	assert.equal(collectors.length, 1, 'bait menu shown');
	await collectors[0]({
		user, customId: 'select-bait', values: [baitTemplateId], message: message(),
		reply: async (p) => { calls.replies.push(p); },
		update: async (p) => { calls.updates.push(p); return response(); },
	});
	if (collectors.length === 2) {
		await collectors[1]({ user, customId: 'buy-one', reply: async (p) => { calls.replies.push(p); } });
	}
	return calls;
}

async function gatedShopBait(level) {
	const worm = await Item.findOne({ name: 'Worm', user: null }).lean();
	const _id = new mongoose.Types.ObjectId();
	const fields = Object.fromEntries(Object.entries(worm).filter(([key]) => key !== '_id'));
	await Item.collection.insertOne({ ...fields, _id, name: `Gate Worm ${level}`, shopItem: true, price: 10, requirements: { level } });
	return String(_id);
}

test('buying a bait below its level is refused (ephemeral) and charges nothing', async () => {
	const baitId = await gatedShopBait(20);
	await makeUser('shop-low');
	await setLevel('shop-low', 19);
	await UserModel.updateOne({ userId: 'shop-low' }, { $set: { 'inventory.money': 1000 } });
	const before = await userDoc('shop-low');

	const calls = await buyBaitFlow('shop-low', baitId);
	assert.equal(calls.replies.length, 1);
	assert.equal(calls.replies[0].flags, EPHEMERAL);
	assert.match(JSON.stringify(calls.replies[0].embeds.map((e) => e.toJSON())), /level 20 to buy/);
	const after = await userDoc('shop-low');
	assert.equal(after.inventory.money, 1000);
	assert.deepEqual(after.inventory.baits.map(String), before.inventory.baits.map(String));
});

test('buying a bait at its level works', async () => {
	const baitId = await gatedShopBait(21);
	await makeUser('shop-ok');
	await setLevel('shop-ok', 21);
	await UserModel.updateOne({ userId: 'shop-ok' }, { $set: { 'inventory.money': 1000 } });

	const calls = await buyBaitFlow('shop-ok', baitId);
	assert.match(JSON.stringify(calls.replies.map((r) => r.embeds.map((e) => e.toJSON()))), /successfully bought 1 Gate Worm 21/);
	const after = await userDoc('shop-ok');
	assert.equal(after.inventory.money, 990);
	const baits = await ItemData.find({ _id: { $in: after.inventory.baits } });
	assert.ok(baits.some((b) => b.name === 'Gate Worm 21'));
});

// Cast time.
async function caster(id, level) {
	await makeUser(id);
	await useTestRod(id, { capabilities: ['weak', '1'] });
	await setLevel(id, level);
}

test('an equipped bait above the player level has no effect, is not consumed and stays equipped', async () => {
	await caster('cast-bait-low', 1);
	const baitId = await useTestBait('cast-bait-low', { count: 7 });
	await ItemData.collection.updateOne({ _id: baitId }, { $set: { 'requirements.level': 30 } });

	const result = await castLine({ userId: 'cast-bait-low' });
	assert.equal(result.status, 'ok');
	assert.ok(!result.modifiers.sources.some((s) => s.source === 'bait'), 'bait contributes nothing');
	assert.equal(result.bait.levelLocked, true);
	assert.equal(result.bait.applied, false);
	assert.equal(result.bait.requiredLevel, 30);
	assert.equal(result.bait.after.count, 7);
	assert.equal(result.bait.depleted, false);
	await applyCastResult(result);

	assert.equal((await ItemData.findById(baitId)).count, 7);
	const doc = await userDoc('cast-bait-low');
	assert.equal(String(doc.inventory.equippedBait), String(baitId));
	assert.ok(doc.inventory.baits.map(String).includes(String(baitId)));
});

test('the same bait at the player level applies and is consumed', async () => {
	await caster('cast-bait-ok', 30);
	const baitId = await useTestBait('cast-bait-ok', { count: 7 });
	await ItemData.collection.updateOne({ _id: baitId }, { $set: { 'requirements.level': 30 } });

	const result = await castLine({ userId: 'cast-bait-ok' });
	assert.equal(result.status, 'ok');
	assert.ok(result.modifiers.sources.some((s) => s.source === 'bait'));
	assert.equal(result.bait.levelLocked, undefined);
	await applyCastResult(result);
	assert.equal((await ItemData.findById(baitId)).count, 7 - result.units);
});

test('an already-equipped rod above the player level stays equipped and still fishes', async () => {
	await caster('cast-rod-low', 1);
	const rodId = (await userDoc('cast-rod-low')).inventory.equippedRod;
	await ItemData.collection.updateOne({ _id: rodId }, { $set: { 'requirements.level': 50 } });

	const result = await castLine({ userId: 'cast-rod-low' });
	assert.equal(result.status, 'ok');
	assert.ok(result.units > 0);
	await applyCastResult(result);

	const doc = await userDoc('cast-rod-low');
	assert.equal(String(doc.inventory.equippedRod), String(rodId));
	assert.equal((await ItemData.findById(rodId)).fishCaught, result.units);
});
