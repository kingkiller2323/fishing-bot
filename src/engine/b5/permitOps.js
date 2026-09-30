// Buying a biome permit (5B release): one atomic guarded write under the player's lock. A double click charges
// once (the permit filter), insufficient funds change nothing (the money filter), an owned permit is never
// charged again, and the level must have been reached.
const { User: UserModel } = require('../../schemas/UserSchema');
const { withUserLock } = require('../userLock');
const { gateLevelOf } = require('../levelGate');
const world = require('./world');

async function buyPermit(userId, biomeName, { now = new Date() } = {}) {
	const biome = world.canonBiome(biomeName);
	if (!biome || world.isFree(biome)) return { ok: false, code: 'NO_PERMIT', message: 'That biome needs no permit.' };
	const price = world.permitPrice(biome);
	return withUserLock(userId, async () => {
		const user = await UserModel.collection.findOne({ userId: String(userId) });
		if (!user) return { ok: false, code: 'NO_USER', message: 'Player not found.' };
		const level = gateLevelOf(user);
		if (level < world.biomeLevel(biome)) return { ok: false, code: 'LEVEL_LOCKED', message: `The ${biome} opens at Lv ${world.biomeLevel(biome)}. You are Lv ${level}.` };
		if (world.heldPermits(user.permits).has(biome)) return { ok: false, code: 'OWNED', message: `You already hold the ${biome} permit.` };
		const res = await UserModel.collection.updateOne(
			{ userId: String(userId), 'inventory.money': { $gte: price }, 'permits.biome': { $ne: biome } },
			{ $inc: { 'inventory.money': -price }, $push: { permits: { biome, source: 'purchased', acquiredAt: now, pricePaid: price } } },
		);
		if (res.modifiedCount !== 1) return { ok: false, code: 'INSUFFICIENT', message: `The ${biome} permit costs $${price.toLocaleString()}.`, price };
		return { ok: true, biome, price };
	});
}

module.exports = { buyPermit };
