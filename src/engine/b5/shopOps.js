// 5B shop purchases not covered elsewhere (rods: rodOps; permits: permitOps; upgrades: upgrades.js).
// Each is a guarded atomic debit under the player's lock followed by an idempotent grant, refunded if the
// grant throws (engine/purchase.js pattern).
const { ObjectId } = require('mongoose').Types;
const { need5b } = require('../balance');
const { User: UserModel } = require('../../schemas/UserSchema');
const { Item } = require('../../schemas/ItemSchema');
const { withUserLock } = require('../userLock');
const { debitMoney } = require('../purchase');
const { grantItem } = require('../rewards');
const { gateLevelOf } = require('../levelGate');

async function payAndGrant(userId, price, template, count, key) {
	if (!await debitMoney(userId, price)) return { ok: false, code: 'INSUFFICIENT', message: `That costs $${price.toLocaleString()}.`, price };
	try {
		await grantItem(String(userId), { key, templateId: String(template._id), count, newId: new ObjectId().toString(), reason: 'shop' });
	}
	catch (error) {
		await UserModel.collection.updateOne({ userId: String(userId) }, { $inc: { 'inventory.money': price } });
		throw error;
	}
	return { ok: true, price, count };
}

/** Buys `packs` packs of a roster bait (packSize units each) at its pack price; refused below its shop level. */
async function buyBaitPacks(userId, name, packs = 1, { key = new ObjectId().toString() } = {}) {
	const def = need5b().bait.roster[name];
	const n = Math.floor(Number(packs));
	if (!def) return { ok: false, code: 'UNKNOWN', message: 'That bait is not sold.' };
	if (!(n >= 1 && n <= 100)) return { ok: false, code: 'BAD_AMOUNT', message: 'Buy between 1 and 100 packs.' };
	return withUserLock(userId, async () => {
		const user = await UserModel.collection.findOne({ userId: String(userId) });
		if (!user) return { ok: false, code: 'NO_USER', message: 'Player not found.' };
		const level = gateLevelOf(user);
		if (level < def.levelRequirement) return { ok: false, code: 'LEVEL_LOCKED', message: `${name} is sold from Lv ${def.levelRequirement}. You are Lv ${level}.` };
		const template = await Item.collection.findOne({ name, user: null, type: 'bait' });
		if (!template) return { ok: false, code: 'NOT_SEEDED', message: 'That bait is not available.' };
		return payAndGrant(userId, def.packPrice * n, template, need5b().bait.packSize * n, `buy-bait:${key}`);
	});
}

/** Buys one tier crate (the Rod Workshop) at its price, from its unlock level. */
async function buyCrate(userId, name, { key = new ObjectId().toString() } = {}) {
	const crate = need5b().rods.crates.find((c) => c.name === name);
	if (!crate) return { ok: false, code: 'UNKNOWN', message: 'That crate is not sold.' };
	return withUserLock(userId, async () => {
		const user = await UserModel.collection.findOne({ userId: String(userId) });
		if (!user) return { ok: false, code: 'NO_USER', message: 'Player not found.' };
		const level = gateLevelOf(user);
		if (level < crate.shop.unlockLevel) return { ok: false, code: 'LEVEL_LOCKED', message: `The ${name} is sold from Lv ${crate.shop.unlockLevel}. You are Lv ${level}.` };
		const template = await Item.collection.findOne({ name, user: null, type: 'gacha' });
		if (!template) return { ok: false, code: 'NOT_SEEDED', message: 'That crate is not available.' };
		return payAndGrant(userId, crate.price, template, 1, `buy-crate:${key}`);
	});
}

module.exports = { buyBaitPacks, buyCrate };
