const { Fish: FishSchema, FishData } = require('../schemas/FishSchema');
const { Item, ItemData } = require('../schemas/ItemSchema');
const { BuffData } = require('../schemas/BuffSchema');
const { Utils } = require('./Utils');
const { User } = require('../class/User');
const { WeatherPattern } = require('./WeatherPattern');
const { Season } = require('./Season');
const { rng } = require('../engine/rng');

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
					count = countMatch[1];
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
	
	static async generateFish(number, count, capabilities, choices, weights, user, weather, season) {
		const choice = [];
		for (let i = 0; i < number; i++) {
		
			let draw = await Utils.getWeightedChoice(choices, weights);
			draw = draw.charAt(0).toUpperCase() + draw.slice(1);
			const currentBiome = await user.getCurrentBiome();
			const biome = currentBiome.charAt(0).toUpperCase() + currentBiome.slice(1);

			const currentWeather = await weather.getWeather();
			const weatherType = currentWeather.charAt(0).toUpperCase() + currentWeather.slice(1);
			const currentSeason = season.season;
		
			let weatherFish = await FishSchema.find({ rarity: draw, biome: biome, weather: weatherType, season: currentSeason }) || [];
			let weatherlessFish = await FishSchema.find({ rarity: draw, biome: biome, weather: 'all', season: currentSeason}) || [];
			let seasonlessFish = await FishSchema.find({ rarity: draw, biome: biome, weather: weatherType, season: 'all' }) || [];
			let globalFish = await FishSchema.find({ rarity: draw, biome: biome, weather: 'all', season: 'all' }) || [];
			let f = weatherFish.concat(weatherlessFish, seasonlessFish, globalFish);

			if (draw === 'Lucky') {
				const itemFind = await Utils.getWeightedChoice(['fish', 'item'], [80, 20]);
				if (itemFind === 'item') {
					const options = await Item.find({ rarity: draw });
					const random = Math.floor(rng.random() * options.length);
					f = [options[random]];
				}
			}
			const filteredChoices = await Promise.all(f.map(async fishObj => {
				await new Promise(resolve => setTimeout(resolve, 100));
		
				const isMatch = capabilities.some(capability => fishObj.qualities.includes(capability));
		
				if (isMatch) {
					return fishObj;
				}
				else {
					return null;
				}
			}));
		
			// Remove null values (fish that didn't match the capabilities) from the array
			const validChoices = filteredChoices.filter(choice => choice !== null);
		
			if (validChoices.length === 0) {
				return await this.generateFish(number, count, capabilities, choices, weights, user, weather, season);
			}
		
			choice.push(validChoices[Math.floor(rng.random() * validChoices.length)]);
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

		// Check for locked status and update the cloned fish as necessary.
		if (user) {
			const fishIds = (await user.getInventory()).fish;
			const lockedFishToUpdate = await FishData.find({ _id: { $in: fishIds }, name: clonedChoice.name, locked: true });
	
			if (lockedFishToUpdate.length > 0) {
				const updateOperations = lockedFishToUpdate.map(fishToUpdate => ({
					updateOne: {
						filter: { _id: fishToUpdate._id },
						update: { locked: true },
					},
				}));
	
				await FishData.bulkWrite(updateOperations);
			}
		}
	
		return clonedChoice;
	};
	
	static async sellByRarity(userId, targetRarity) {
		let totalValue = 0;
		const fishToRemove = [];
		const user = new User(await User.get(userId));
	
		// check for buffs
		const activeBuffs = await BuffData.find({ user: userId, active: true });
		const cashBuff = activeBuffs.find((buff) => buff.capabilities.includes('cash'));
		const cashMultiplier = cashBuff ? parseFloat(cashBuff.capabilities[1]) : 1;
	
		const fishList = await user.getFish();
		fishList.forEach(async (f) => {
			if (f.rarity.toLowerCase() === targetRarity.toLowerCase() || targetRarity.toLowerCase() === 'all') {
				totalValue += f.value * cashMultiplier * f.count;
				fishToRemove.push(f._id);
			}
		});
	
		await user.removeListOfFish(fishToRemove);
		await user.addMoney(totalValue);
	
		return totalValue;
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
