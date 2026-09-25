// Gacha test helpers: give boxes, and register temporary test box definitions.
const mongoose = require('mongoose');
const { Item } = require('../../src/schemas/ItemSchema');
const { Gacha } = require('../../src/schemas/GachaSchema');
const { grantItem } = require('../../src/engine/rewards');
const { BOXES } = require('../../src/engine/gachaBoxes');

/** Gives a player `count` of a catalog box through the normal grant primitive. */
async function giveBox(userId, name, count = 1) {
	const template = await Item.findOne({ name, user: null }).lean();
	await grantItem(String(userId), { key: `test:${new mongoose.Types.ObjectId()}`, templateId: String(template._id), count, newId: new mongoose.Types.ObjectId().toString(), reason: 'test' });
}

/** Registers a catalog box + Gacha V2 definition for the duration of a test. */
async function withTestBox(name, definition, fn) {
	if (!await Item.exists({ name, user: null })) {
		await Gacha.create({ name, description: 'test box', rarity: 'Common', capabilities: [], items: definition.slots, weights: {} });
	}
	BOXES[name] = { id: definition.id || name.toLowerCase().replace(/\s+/g, '-'), strategy: 'independent', rarityFloor: null, guaranteedSlots: [], duplicates: 'allow', pity: null, ...definition };
	try {
		return await fn();
	}
	finally {
		delete BOXES[name];
	}
}

const ALL = { common: 1, uncommon: 1, rare: 1, ultra: 1, giant: 1, legendary: 1, lucky: 1 };

module.exports = { giveBox, withTestBox, ALL };
