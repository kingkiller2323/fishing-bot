// Game fixtures on top of the in-memory DB: seeded catalog, players and inventory fish.
const { bootstrap } = require('../../src/bootstrap');
const { User } = require('../../src/class/User');
const { Fish } = require('../../src/schemas/FishSchema');
const { FishData } = require('../../src/schemas/FishSchema');

async function seedGame() {
	await bootstrap();
}

/** Creates a player (with the starter rod) and returns the User wrapper. */
async function makeUser(userId) {
	return new User(await User.get(userId));
}

/** Gives a player a copy of a catalog fish; returns the FishData document. */
async function giveFish(user, name, { locked = false, count = 1, value = 100, rarity } = {}) {
	const template = await Fish.findOne({ name, user: null });
	if (!template) throw new Error(`No catalog fish named ${name}`);
	const { item } = await user.sendToInventory(template._id, count);
	const fields = { locked, value, count };
	if (rarity) fields.rarity = rarity;
	await FishData.updateOne({ _id: item._id }, { $set: fields });
	return FishData.findById(item._id);
}

/** Reloads the User wrapper from the database. */
async function reload(user) {
	return new User(await User.get(await user.getUserId()));
}

module.exports = { seedGame, makeUser, giveFish, reload };
