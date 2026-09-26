const { Fish: FishSchema, FishData } = require('../schemas/FishSchema');
const { BuffData } = require('../schemas/BuffSchema');
const { activeBuffFilter } = require('../engine/buffs');
const { Utils } = require('./Utils');
const { User } = require('../class/User');
const { partitionProtected } = require('../engine/protection');
const { recordSale } = require('../engine/sales');


class Fish {
	// constructor(data) {
	// 	this.fish = new FishData(data);
	// }

	// save() {
	// 	return FishData.findOneAndUpdate({ _id: this.fish._id }, this.fish, { upsert: true });
	// }

	/**
	 * Sells every unprotected fish of a rarity (or 'all'). Locked fish are never sold.
	 * @returns {Promise<{ total: number, sold: number, protected: number }>}
	 */
	static async sellByRarity(userId, targetRarity) {
		const user = new User(await User.get(userId));

		// check for buffs
		const activeBuffs = await BuffData.find(activeBuffFilter(userId, Date.now()));
		const cashBuff = activeBuffs.find((buff) => buff.capabilities.includes('cash'));
		const cashMultiplier = cashBuff ? parseFloat(cashBuff.capabilities[1]) : 1;

		const target = targetRarity.toLowerCase();
		const matching = (await user.getFish()).filter((f) => target === 'all' || f.rarity.toLowerCase() === target);
		const { allowed, protected: protectedFish } = partitionProtected(matching);

		let totalValue = 0;
		let baseTotal = 0;
		for (const f of allowed) {
			totalValue += f.value * cashMultiplier * f.count;
			baseTotal += (f.valueBase ?? f.value) * cashMultiplier * f.count;
		}

		const removed = await user.removeListOfFish(allowed.map((f) => f._id));
		if (removed.length !== allowed.length) throw new Error('Inventory changed while selling; nothing was paid out.');
		await user.addMoney(totalValue);
		if (allowed.length > 0) await recordSale(userId, baseTotal, totalValue);

		return { total: totalValue, baseTotal: Math.round(baseTotal), sold: allowed.length, protected: protectedFish.length };
	};

	static async getCount(userId, fishName) {
		const user = new User(await User.get(userId));
		const fishIds = (await user.getInventory()).fish;
		const fishList = await FishData.find({ _id: { $in: fishIds }, name: fishName });
	
		let total = 0;
		fishList.forEach(f => {
			total += f.count;
		});
	
		return total;
	};
	
	static async getByName(fishName) {
		const capitalized = fishName.split(' ').map(word => word.charAt(0).toUpperCase() + word.slice(1)).join(' ');
		return await FishSchema.findOne({ name: capitalized });
	};

	static async isValidRarity(rarity) {
		const rarities = ['common', 'uncommon', 'rare', 'ultra', 'giant', 'legendary', 'lucky'];
		return rarities.includes(rarity.toLowerCase()) || rarity.toLowerCase() === 'all';
	};

	static async calculateSellValue(baseValue, size, weight, rarity) {
		const weightFactor = 1.005; // Extra multiplier based on weight
		const sizeFactor = 0.05; // Extra multiplier based on size
		const rarityFactors = {
			common: 1,
			uncommon: 1.35,
			rare: 1.65,
			ultra: 2.2,
			giant: 3.0,
			legendary: 3.5,
			lucky: 4.0
		};

		const rarityFactor = rarityFactors[rarity.toLowerCase()] || 1;

		return Math.round(size * baseValue * sizeFactor + weight * weightFactor * rarityFactor);
	}
}

module.exports = { Fish };
