const { Fish: FishSchema, FishData } = require('../schemas/FishSchema');
const { Item, ItemData } = require('../schemas/ItemSchema');
const { BuffData } = require('../schemas/BuffSchema');
const { Utils } = require('./Utils');
const { User } = require('../class/User');
const { WeatherPattern } = require('./WeatherPattern');
const { Season } = require('./Season');
const { rng } = require('../engine/rng');
const { partitionProtected } = require('../engine/protection');

// Rarity re-rolls allowed per fish before falling back (see generateFish).
const MAX_DRAW_ATTEMPTS = 25;
const RARITY_ORDER = ['Common', 'Uncommon', 'Rare', 'Ultra', 'Giant', 'Legendary', 'Lucky'];

/** Thrown when a cast cannot produce any fish (misconfigured catalog), instead of looping forever. */
class NoCatchError extends Error {
	constructor(message) {
		super(message);
		this.name = 'NoCatchError';
		this.code = 'NO_CATCH';
	}
}

class Fish {
	// constructor(data) {
	// 	this.fish = new FishData(data);
	// }

	// save() {
	// 	return FishData.findOneAndUpdate({ _id: this.fish._id }, this.fish, { upsert: true });
	// }

	static async reel(rod, bait, biome, guild, user) {
		const rodObject = await ItemData.findById(rod);
		const rarities = Object.keys(rodObject.weights);
		let capabilities = rodObject.capabilities;
		let weights = Object.values(rodObject.weights);
		biome = biome.toLowerCase();
	
		if (bait && (bait.biomes.includes(biome))) {
			capabilities = await Utils.sumCountsInArrays(rodObject.capabilities, bait.capabilities);
			weights = await Utils.sumArrays(Object.values(rodObject.weights), Object.values(bait.weights));
		}

		const weather = await WeatherPattern.getCurrentWeather();
		const season = await Season.getCurrentSeason();
	
		return await this.sendToUser(capabilities, rarities, weights, guild, user, weather, season);
	};

	static async sendToUser(capabilities, choices, weights, guild, user, weather, season) {
		let fishArray = [];
		let numberCapability = capabilities.find(capability => !isNaN(capability));
		let count = 1;
		
		if (!numberCapability) {
			const countCapability = capabilities.find(capability => 
				typeof capability === 'string' && capability.toLowerCase().includes('count'));
			
			if (countCapability) {
				const countMatch = countCapability.match(/^(\d+)/);
				if (countMatch && countMatch[1]) {
					count = Number(countMatch[1]);
				}
			}
		}

		if (numberCapability) {
			fishArray = await this.generateFish(Number(numberCapability), count, capabilities, choices, weights, user, weather, season);
		}
		else {
			fishArray = await this.generateFish(1, count, capabilities, choices, weights, user, weather, season);
		}

		// Get the latest catchId once for the entire catch, treating both strings and numbers as integers, incrementing by 1
		const latestCatch = await FishData.aggregate([
			{ $match: { catchId: { $exists: true } } }, // Only include documents with a catchId field
			{ $addFields: { catchIdAsInt: { $toInt: "$catchId" } } }, // Convert catchId to integer
			{ $sort: { catchIdAsInt: -1 } }, // Sort in descending order by the integer-converted catchId
			{ $limit: 1 } // Get the highest catchId
		]);

		const catchId = latestCatch.length > 0 ? latestCatch[0].catchIdAsInt + 1 : 1;
				
		const uniqueFishArray = [];
		fishArray.forEach(async oneFish => {
			const countCapability = capabilities.find(capability => 
				typeof capability === 'string' && capability.toLowerCase().includes('count'));
				
			if (countCapability !== undefined) {
				const count = Number(countCapability.split(' ')[0]);
				oneFish.count = count;
			}
	
			const existingFish = uniqueFishArray.find(f => f.item.name === oneFish.item.name);
			if (existingFish) {
				existingFish.item.count++;
			}
			else {
				uniqueFishArray.push(oneFish);
			}

			// Weight, size and value calculations
			const trials = 10;
			const probability = 0.5;

			const size = parseFloat((await Utils.binomialRandomInRange(trials, probability, oneFish.item.minSize, oneFish.item.maxSize)).toFixed(3));
			const weight = parseFloat((await Utils.binomialRandomInRange(trials, probability, oneFish.item.minWeight, oneFish.item.maxWeight)).toFixed(3));
			const value = parseInt((await this.calculateSellValue(oneFish.item.baseValue, size, weight, oneFish.item.rarity)));

			// console.log(`Generated fish: ${oneFish.item.name} with size ${size}, weight ${weight} and value $${value}`);
			
			oneFish.item.guild = guild;
			oneFish.item.size = size;
			oneFish.item.weight = weight;
			oneFish.item.value = value;
			oneFish.item.catchId = catchId;
			oneFish.item.save();
		});
	
		return await uniqueFishArray.map(element => element.item);
	};
	
	/**
	 * Draws `number` fish for one cast. Each draw rolls a rarity from the rod/bait weights and picks a
	 * fish of that rarity available in the player's biome, weather and season whose qualities match
	 * the capabilities. A rarity with no eligible fish is re-rolled, at most MAX_DRAW_ATTEMPTS times
	 * (the same odds as the old unbounded retry); then a deterministic fallback fish is used, and if
	 * even that is impossible a NoCatchError is thrown instead of recursing forever.
	 */
	static async generateFish(number, count, capabilities, choices, weights, user, weather, season) {
		const choice = [];
		const currentBiome = await user.getCurrentBiome();
		const biome = currentBiome.charAt(0).toUpperCase() + currentBiome.slice(1);
		const currentWeather = await weather.getWeather();
		const weatherType = currentWeather.charAt(0).toUpperCase() + currentWeather.slice(1);
		const currentSeason = season.season;
		const matchesCapabilities = (candidate) => capabilities.some((capability) => (candidate?.qualities || []).includes(capability));

		for (let i = 0; i < number; i++) {
			let picked = null;
			for (let attempt = 0; attempt < MAX_DRAW_ATTEMPTS && !picked; attempt++) {
				let draw = await Utils.getWeightedChoice(choices, weights);
				if (!draw) break;
				draw = draw.charAt(0).toUpperCase() + draw.slice(1);

				let candidates = await FishSchema.find({
					rarity: draw,
					biome: biome,
					weather: { $in: [weatherType, 'all'] },
					season: { $in: [currentSeason, 'all'] },
					user: null,
				});

				if (draw === 'Lucky') {
					const itemFind = await Utils.getWeightedChoice(['fish', 'item'], [80, 20]);
					if (itemFind === 'item') {
						const options = await Item.find({ rarity: draw, user: null });
						// An empty Lucky item pool falls back to Lucky fish instead of crashing.
						if (options.length > 0) candidates = [rng.pick(options)];
					}
				}

				const valid = candidates.filter(matchesCapabilities);
				if (valid.length > 0) picked = rng.pick(valid);
			}

			if (!picked) picked = await this.fallbackFish(biome, capabilities);
			if (!picked) throw new NoCatchError(`No catchable fish in ${biome} for capabilities [${capabilities.join(', ')}]`);
			choice.push(picked);
		}

		// merge any duplicate fish
		const uniqueChoices = [];
		choice.forEach(fish => {
			const existingFish = uniqueChoices.find(f => f.name === fish.name);
			if (existingFish) {
				existingFish.count++;
			}
			else {
				fish = { ...fish._doc };
				fish.count = count;
				uniqueChoices.push(fish);
			}
		});

		const clonedChoice = [];
		for (const fish of uniqueChoices) {
			clonedChoice.push(await user.sendToInventory(fish, fish.count));
		}

		// A species the player has locked stays protected: new catches of it are locked too.
		if (user) {
			const newIds = clonedChoice.map((c) => c.item._id);
			const names = [...new Set(clonedChoice.map((c) => c.item.name))];
			const lockedNames = await FishData.distinct('name', {
				_id: { $in: (await user.getInventory()).fish, $nin: newIds },
				name: { $in: names },
				locked: true,
			});
			const toLock = clonedChoice.filter((c) => lockedNames.includes(c.item.name));
			if (toLock.length > 0) {
				toLock.forEach((c) => { c.item.locked = true; });
				await FishData.updateMany({ _id: { $in: toLock.map((c) => c.item._id) } }, { $set: { locked: true } });
			}
		}

		return clonedChoice;
	};

	/**
	 * Deterministic last resort when rarity re-rolls found nothing: the lowest-rarity year-round
	 * fish in the biome that matches the capabilities (bootstrap guarantees one per rarity/quality).
	 */
	static async fallbackFish(biome, capabilities) {
		const candidates = await FishSchema.find({ biome, weather: 'all', season: 'all', user: null }).sort({ name: 1 });
		const eligible = candidates.filter((f) => capabilities.some((c) => (f.qualities || []).includes(c)));
		eligible.sort((a, b) => RARITY_ORDER.indexOf(a.rarity) - RARITY_ORDER.indexOf(b.rarity));
		return eligible[0] || null;
	}

	/**
	 * Sells every unprotected fish of a rarity (or 'all'). Locked fish are never sold.
	 * @returns {Promise<{ total: number, sold: number, protected: number }>}
	 */
	static async sellByRarity(userId, targetRarity) {
		const user = new User(await User.get(userId));

		// check for buffs
		const activeBuffs = await BuffData.find({ user: userId, active: true });
		const cashBuff = activeBuffs.find((buff) => buff.capabilities.includes('cash'));
		const cashMultiplier = cashBuff ? parseFloat(cashBuff.capabilities[1]) : 1;

		const target = targetRarity.toLowerCase();
		const matching = (await user.getFish()).filter((f) => target === 'all' || f.rarity.toLowerCase() === target);
		const { allowed, protected: protectedFish } = partitionProtected(matching);

		let totalValue = 0;
		for (const f of allowed) totalValue += f.value * cashMultiplier * f.count;

		const removed = await user.removeListOfFish(allowed.map((f) => f._id));
		if (removed.length !== allowed.length) throw new Error('Inventory changed while selling; nothing was paid out.');
		await user.addMoney(totalValue);

		return { total: totalValue, sold: allowed.length, protected: protectedFish.length };
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

module.exports = { Fish, NoCatchError };
