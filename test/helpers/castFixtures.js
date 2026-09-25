// Controlled fishing setups for cast-engine tests: a private biome with known fish, and helpers
// to shape a player's rod, bait and quests.
const mongoose = require('mongoose');
const { Fish } = require('../../src/schemas/FishSchema');
const { ItemData, Item } = require('../../src/schemas/ItemSchema');
const { User: UserModel } = require('../../src/schemas/UserSchema');
const { QuestData } = require('../../src/schemas/QuestSchema');

const POOL = 'Testpool';

/** Creates catalog fish in the private test biome (idempotent by name). */
async function addPoolFish(fish) {
	for (const f of fish) {
		const exists = await Fish.exists({ name: f.name, biome: POOL, user: null });
		if (!exists) {
			await Fish.create({ biome: POOL, weather: 'all', season: 'all', type: 'fish', qualities: ['weak'], minSize: 10, maxSize: 20, minWeight: 1, maxWeight: 2, baseValue: 10, ...f });
		}
	}
}

/** Moves the player to the test biome and shapes their equipped rod. */
async function useTestRod(userId, { capabilities = ['weak', '1'], weights, durability = 1000, repairs = 0, maxRepairs = 3, state = 'mint' } = {}) {
	const user = await UserModel.findOne({ userId });
	await UserModel.updateOne({ userId }, { $set: { currentBiome: POOL.toLowerCase() } });
	const set = { capabilities, durability, repairs, maxRepairs, state };
	if (weights) set.weights = weights;
	await ItemData.collection.updateOne({ _id: user.inventory.equippedRod }, { $set: set });
	return user.inventory.equippedRod;
}

/** Equips a bait copy for the player (count, multiplier and biomes controllable). */
async function useTestBait(userId, { count = 10, multiplier = 1, biomes = [POOL.toLowerCase()], capabilities = ['weak'], weights } = {}) {
	const template = await Item.findOne({ name: 'Worm', user: null }).lean();
	const _id = new mongoose.Types.ObjectId();
	const fields = Object.fromEntries(Object.entries(template).filter(([key]) => key !== '_id'));
	await ItemData.collection.insertOne({ ...fields, _id, __t: 'BaitData', user: userId, count, multiplier, biomes, capabilities, weights: weights || template.weights });
	await UserModel.updateOne({ userId }, { $set: { 'inventory.equippedBait': _id }, $push: { 'inventory.baits': _id } });
	return _id;
}

/** Gives the player an in-progress quest. */
async function giveQuest(userId, fields = {}) {
	const quest = await QuestData.create({
		title: 'Test quest', description: 'x', cash: 0, xp: 0, progressMax: 1, status: 'in_progress', user: userId,
		requirements: { level: 0, previous: [] },
		progressType: { fish: ['any'], rarity: ['any'], rod: 'any', qualities: ['any'] },
		reward: [], type: 'quest', ...fields,
	});
	await UserModel.updateOne({ userId }, { $push: { 'inventory.quests': quest._id } });
	return quest;
}

const userDoc = (userId) => UserModel.findOne({ userId }).lean();

module.exports = { POOL, addPoolFish, useTestRod, useTestBait, giveQuest, userDoc };
