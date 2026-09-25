const { Utils } = require('../class/Utils');
const { Fish, FishData } = require('../schemas/FishSchema');
const { Item, ItemData } = require('../schemas/ItemSchema');
const { User: UserSchema } = require('../schemas/UserSchema');
const { BuffData } = require('../schemas/BuffSchema');
const config = require('../config');
const fetch = require('node-fetch');
const { QuestData } = require('../schemas/QuestSchema');
const { rng } = require('../engine/rng');

class User {
	constructor(data) {
		this.user = new UserSchema(data);
	}

	save() {
		return UserSchema.findOneAndUpdate({ _id: this.user._id }, this.user, { upsert: true });
	}

	async getId() {
		return this.user._id;
	}

	async getUserId() {
		return this.user.userId;
	}

	async getCommands() {
		return this.user.commands;
	}

	async incrementCommandCount() {
		this.user.commands++;
		return await this.save();
	}

	async getCurrentBiome() {
		return this.user.currentBiome;
	}

	async setCurrentBiome(biome) {
		this.user.currentBiome = biome;
		return await this.save();
	}

	async getStats() {
		return this.user.stats;
	}

	async setStats(stats) {
		this.user.stats = stats;
		return await this.save();
	}

	async getMoney() {
		return this.user.inventory.money;
	}

	async addMoney(amount) {
		this.user.inventory.money += parseInt(amount);
		return await this.save();
	}

	async getInventory() {
		return this.user.inventory;
	}

	async getBaits() {
		const baitIds = this.user.inventory.baits;
		const baits = await ItemData.find({ _id: { $in: baitIds } });
		return baits;
	}

	async removeBait(baitId) {
		this.user.inventory.baits = this.user.inventory.baits.filter((b) => b.valueOf() !== baitId);
		return await this.save();
	}

	async getItems() {
		const itemIds = this.user.inventory.items;
		const items = await ItemData.find({ _id: { $in: itemIds } });
		return items;
	}

	async getBuffs() {
		const buffIds = this.user.inventory.buffs;
		const buffs = await BuffData.find({ _id: { $in: buffIds } });
		return buffs;
	}

	async getQuests() {
		const questIds = this.user.inventory.quests;
		const quests = await QuestData.find({ _id: { $in: questIds } });
		return quests || [];
	}

	async addQuest(questId) {
		const inventory = await this.getInventory();
		inventory.quests.push(questId);
		return await this.save();
	}

	async getGacha() {
		const gachaIds = this.user.inventory.gacha;
		const gacha = await ItemData.find({ _id: { $in: gachaIds } });
		return gacha;
	}

	async getRods() {
		const rodIds = this.user.inventory.rods;
		const rods = await ItemData.find({ _id: { $in: rodIds } });
		return rods;
	}

	async getFish() {
		const fishIds = this.user.inventory.fish;
		const fish = await FishData.find({ _id: { $in: fishIds } });
		return fish;
	}

	async removeFish(fishId, count) {
		if (!count || count < 1) count = 1;

		// if fish count is greater than 1, decrement count
		const fish = await FishData.findById(fishId);
		if (fish.count >= 1) {
			fish.count -= count;
			await fish.save();
		}

		if (fish.count <= 0) {
			this.user.inventory.fish = this.user.inventory.fish.filter((f) => f.valueOf() !== fishId.valueOf());
			await this.save();
		}

		return;
	}

	async removeListOfFish(fishIds) {
		fishIds = fishIds.map((f) => f.valueOf());
		this.user.inventory.fish = this.user.inventory.fish.filter((f) => !fishIds.includes(f.valueOf()));
		await this.save();
	}

	async getCodes() {
		return this.user.inventory.codes;
	}

	async addCode(codeId) {
		const codes = await this.getCodes();
		codes.push(codeId);
		return await this.save();
	}

	async generateBoostedXP() {
		// check for active buffs
		const activeBuffs = await BuffData.find({ user: await this.getUserId(), active: true });
		const xpBuff = activeBuffs.find((buff) => buff.capabilities.includes('xp'));
		const xpMultiplier = xpBuff ? parseFloat(xpBuff.capabilities[1]) : 1;

		return Utils.generateXP(10 * xpMultiplier, 25 * xpMultiplier);
	}

	async generateBoostedCash() {
		// check for active buffs
		const activeBuffs = await BuffData.find({ user: await this.getUserId(), active: true });
		const cashBuff = activeBuffs.find((buff) => buff.capabilities.includes('cash'));
		const cashMultiplier = cashBuff ? parseFloat(cashBuff.capabilities[1]) : 1;

		return Utils.generateCash(10 * cashMultiplier, 100 * cashMultiplier);
	}

	async getEquippedRod() {
		let user = this.user;
		const userId = await this.getUserId();
		if (!user) user = await this.createUser(userId);
		const rodId = user.inventory.equippedRod?.valueOf();
		if (!rodId) {
			const rod = await Item.findOne({ name: 'Old Rod' });
			const newRod = await this.sendToInventory(rod);
			const equippedRod = await this.setEquippedRod(newRod.item.id);
			return equippedRod;
		}
		else {
			const rod = await ItemData.findById(rodId);
			return rod;
		}
	}

	async setEquippedRod(rodId) {
		const user = this.user;
		if (rodId === 'none') {
			user.inventory.equippedRod = null;
			await this.save();
			return null;
		}
		else {
			if (rodId.valueOf()) rodId = rodId.valueOf();

			// Find the rod in user's inventory by name
			const rod = user.inventory.rods.find((r) => r.valueOf() === rodId);

			if (!rod) {
				throw new Error('Rod not found in inventory');
			}

			// Set the equippedRod field to the ObjectId of the found rod
			user.inventory.equippedRod = rod;

			const rodObject = await ItemData.findById(rod.valueOf());

			// Save the updated user document
			await this.save();
			return rodObject;
		}
	}

	async getXP() {
		return this.user.xp;
	}

	async addXP(amount) {
		this.user.xp += amount;
		return await this.save();
	}

	async getLevel() {
		const xp = await this.getXP();
		const level = Math.floor(0.1 * Math.sqrt(xp));
		return Math.max(level, 1);
	}

	async getXPToNextLevel() {
		const xp = await this.getXP();
		const level = await this.getLevel(xp);
		const progress = Math.max((xp - (level ** 2 * 100)), 0);
		const nextLevelProgress = ((level + 1) ** 2 * 100) - (level ** 2 * 100);
		return `${progress.toLocaleString()} / ${nextLevelProgress.toLocaleString()}`;
	}

	async getInventoryValue() {
		let totalValue = 0;
		const fishList = await this.getFish();
		fishList.forEach(async (f) => {
			totalValue += f.value * f.count;
		});

		return totalValue;
	}

	async getAquariumLicense(waterType) {
		const inventory = await this.getInventory();
		if (inventory.items) {
			// check if user has an aquarium license
			const items = await Promise.all(inventory.items.map(async (i) => await ItemData.findById(i)));
			const licenses = (await Promise.all(items.map(async (i) => i))).filter(i => i.type === 'license');
			const aquariumLicenses = await licenses.filter(async (l) => !l.name.toLowerCase().includes('aquarium'));
			// find the license that matches the waterType
			const waterLicenses = await aquariumLicenses.filter(async (l) => !l.aquarium.waterType.includes(waterType));
			// find the license with the highest size constraint
			const sortedLicenses = await waterLicenses.sort((a, b) => b.aquarium.size - a.aquarium.size);
			return sortedLicenses[0];
		}
	}

	async decreaseRodDurability(amount) {
		const user = this.user;
		const rod = await ItemData.findById(user.inventory.equippedRod);

		if (rod.durability - amount <= 0) {
			rod.state = 'broken';
			rod.durability = 0;

			if (rod.repairs >= rod.maxRepairs) {
				rod.state = 'destroyed';
				user.equippedRod = null;
			}
		}
		else {
			rod.durability -= amount;
		}

		await rod.save();
		await this.save();
		return rod;
	}

	async repairRod() {
		const user = this.user;
		const rod = await ItemData.findById(user.inventory.equippedRod);

		rod.repairs += 1;
		rod.durability = rod.maxDurability;
		rod.state = 'repaired';
		await rod.save();
		return rod;
	}

	async getEquippedBait() {
		const user = this.user;
		const baitId = user.inventory.equippedBait?.valueOf() || null;
		if (!baitId) return null;
		const bait = await ItemData.findById(baitId);
		return bait;
	}

	async setEquippedBait(baitId) {
		const user = this.user;
		const bait = user.inventory.baits.find((r) => r.valueOf() === baitId);

		user.inventory.equippedBait = bait;
		const baitObject = await ItemData.findById(bait?.valueOf()) || null;

		await this.save();
		return baitObject;
	}

	async getAllBaits() {
		const user = this.user;
		const baitIds = user.inventory.baits;
		const baits = await ItemData.find({ _id: { $in: baitIds } });
		return baits;
	}

	async openBox(name) {
		const user = this.user;
		// uppercase the first letter of each word in name
		name = name.split(' ').map((word) => word.charAt(0).toUpperCase() + word.slice(1)).join(' ');

		const gachaBoxes = await Promise.all(user.inventory.gacha.map(async (boxId) => await ItemData.findById(boxId)));
		const boxes = gachaBoxes.filter((box) => !box.opened && box.name === name);
		if (boxes.length === 0) return null;

		const box = await ItemData.findById(boxes[0]);
		if (!box.opened) {
			box.count--;
			await box.save();

			const stats = await this.getStats();
			stats.gachaBoxesOpened++;
			await this.setStats(stats);

			// remove box from user inventory
			if (box.count <= 0) {
				user.inventory.gacha = user.inventory.gacha.filter((i) => i.valueOf() !== box.id);
				await this.save();
			}

			// check box capabilities to generate items
			const capabilities = box.capabilities;
			const weights = box.weights;
			let items = [...await Item.find({ type: { $in: capabilities } })];
			if (capabilities.includes('fish')) {
				items = [...items, ...await Fish.find()];
			}

			// check for active buffs
			const activeBuffs = await BuffData.find({ user: await this.getUserId(), active: true });
			const gachaBuff = activeBuffs.find((buff) => buff.capabilities.includes('gacha'));
			const gachaMultiplier = gachaBuff ? parseFloat(gachaBuff.capabilities[1]) : 1;

			// multiply rare+ item weights by gachaMultiplier
			const weightValues = Object.values(weights);
			for (let i = 0; i < weightValues.length; i++) {
				if (i > 1) {
					weightValues[i] *= gachaMultiplier;
				}
			}

			// generate random items from box
			let filteredItems = [];
			while (filteredItems.length === 0) {
				let draw = await Utils.getWeightedChoice(Object.keys(box.weights), weightValues);
				draw = draw.charAt(0).toUpperCase() + draw.slice(1);
				filteredItems = items.filter((item) => item.rarity.toLowerCase() === draw.toLowerCase());
			}

			const numItems = box.items || 1;
			const generatedItems = [];
			for (let i = 0; i < numItems; i++) {
				const random = Math.floor(rng.random() * filteredItems.length);
				const item = filteredItems[random];
				generatedItems.push(await this.sendToInventory(item));
			}

			return generatedItems;
		}
		else {
			return null;
		}
	}

	async removeItems(itemIds) {
		const user = this.user;
		const inventory = user.inventory;
		const items = await ItemData.find({ _id: { $in: itemIds } });

		items.forEach(async (item) => {
			if (item.count <= 0) {
				switch (item.type) {
				case 'rod':
					inventory.rods = inventory.rods.filter((r) => r.valueOf() !== item.id);
					break;
				case 'bait':
					inventory.baits = inventory.baits.filter((b) => b.valueOf() !== item.id);
					break;
				case 'fish':
					inventory.fish = inventory.fish.filter((f) => f.valueOf() !== item.id);
					break;
				case 'buff':
					inventory.buffs = inventory.buffs.filter((b) => b.valueOf() !== item.id);
					break;
				case 'gacha':
					inventory.gacha = inventory.gacha.filter((g) => g.valueOf() !== item.id);
					break;
				case 'quest':
					inventory.quests = inventory.quests.filter((q) => q.valueOf() !== item.id);
					break;
				default:
					inventory.items = inventory.items.filter((i) => i.valueOf() !== item.id);
					break;
				}
			}
			else {
				const itemObject = await ItemData.findById(item);
				itemObject.count--;
				await itemObject.save();
			}
		});

		await this.save();
	}

	async addCustomRodToInventory(rodId) {
		(await this.getInventory()).rods.push(rodId);
		return await this.save();
	}

	async sendFishToInventory(fish, fields) {
		const user = this.user;
		const userId = await this.getUserId();
		let fishObject = await Fish.findById(fish);

		let clonedFish;
		let finalFish;
		let newFishCount;
		clonedFish = await Utils.clone(fishObject, userId);
		
		if (fields) {
			Object.keys(fields).forEach((key) => {
				if (clonedFish[key] !== undefined) {
					clonedFish[key] = fields[key];
				}
			});
		}

		user.inventory.fish.push(clonedFish);
		finalFish = clonedFish;
		newFishCount = clonedFish.count || 1;

		await finalFish.save();
		await await this.save();

		return { fish: finalFish, count: newFishCount, size: finalFish.size, weight: finalFish.weight, value: finalFish.value };
	}

	async sendToInventory(item, count) {
		if (!count) count = 1;
		const user = this.user;
		const userId = await this.getUserId();
		let itemObject = await Item.findById(item);
		if (!itemObject) itemObject = await Fish.findById(item);
		if (count !== 1) itemObject.count = count;

		let items;
		let existingItem;
		let clonedItem;
		let finalItem;
		let newItemCount;
		switch (itemObject.type) {
		case 'rod':
			clonedItem = await Utils.clone(itemObject, userId);
			user.inventory.rods.push(clonedItem);
			finalItem = clonedItem;
			newItemCount = clonedItem.count || 1;
			break;
		case 'bait':
			items = await Promise.all(user.inventory.baits.map(async (b) => await ItemData.findById(b)));
			existingItem = items.find((b) => b?.name === itemObject.name);
			if (existingItem) {
				existingItem.count += itemObject.count;
				await existingItem.save();
				finalItem = existingItem;
				newItemCount = itemObject.count || 1;
			}
			else {
				clonedItem = await Utils.clone(itemObject, userId);
				clonedItem.count = count;
				user.inventory.baits.push(clonedItem);
				finalItem = clonedItem;
				newItemCount = clonedItem.count || 1;
			}
			break;
		case 'fish':
			clonedItem = await Utils.clone(itemObject, userId);
			clonedItem.count = count;
			user.inventory.fish.push(clonedItem);
			finalItem = clonedItem;
			newItemCount = clonedItem.count || 1;
			break;
		case 'buff':
			items = await Promise.all(user.inventory.buffs.map(async (b) => await ItemData.findById(b)));
			existingItem = items.find((b) => b?.name === itemObject.name);
			if (existingItem) {
				existingItem.count += itemObject.count;
				await existingItem.save();
				finalItem = existingItem;
				newItemCount = itemObject.count || 1;
			}
			else {
				clonedItem = await Utils.clone(itemObject, userId);
				clonedItem.count = count;
				user.inventory.buffs.push(clonedItem);
				finalItem = clonedItem;
				newItemCount = clonedItem.count || 1;
			}
			break;
		case 'gacha':
			items = await Promise.all(user.inventory.gacha.map(async (b) => await ItemData.findById(b)));
			existingItem = items.find((b) => b?.name === itemObject.name);
			if (existingItem) {
				existingItem.count += itemObject.count;
				await existingItem.save();
				finalItem = existingItem;
				newItemCount = itemObject.count || 1;
			}
			else {
				clonedItem = await Utils.clone(itemObject, userId);
				clonedItem.count = count;
				user.inventory.gacha.push(clonedItem);
				finalItem = clonedItem;
				newItemCount = clonedItem.count || 1;
			}
			break;
		case 'quest':
			clonedItem = await Utils.clone(itemObject, userId);
			user.inventory.quests.push(clonedItem);
			finalItem = clonedItem;
			newItemCount = clonedItem.count || 1;
			break;
		default:
			items = await Promise.all(user.inventory.items.map(async (b) => await ItemData.findById(b)));
			existingItem = items.find((b) => b?.name === itemObject.name);
			if (existingItem && existingItem.count) {
				existingItem.count += itemObject.count;
				await existingItem.save();
				finalItem = existingItem;
				newItemCount = itemObject.count || 1;
			}
			else {
				clonedItem = await Utils.clone(itemObject, userId);
				clonedItem.count = count;
				user.inventory.items.push(clonedItem);
				finalItem = clonedItem;
				newItemCount = clonedItem.count || 1;
			}
			break;
		}
		await finalItem.save();
		await await this.save();

		return { item: finalItem, count: newItemCount };
	}

	async startBooster(id) {
		const buff = await BuffData.findById(id);
		if (!buff) return null;
		buff.active = true;
		buff.endTime = Date.now() + buff.length;
		await buff.save();
		return buff;
	}

	async endBooster(id) {
		const user = this.user;
		const buff = await BuffData.findById(id);
		if (!buff) return null;
		buff.active = false;
		await buff.save();

		user.inventory.buffs = user.inventory.buffs.filter((b) => b.id !== buff.id);
		return await this.save();
	}

	async updateLevel() {
		const user = this.user;
		const level = await this.getLevel();
		const oldLevel = user.level;
		user.level = level;
		await this.save();

		return oldLevel < level;
	}

	async getLastVoted() {
		return this.user.stats.lastVoted || 0;
	}

	async setLastVoted() {
		const user = this.user;
		user.stats.lastVoted = Date.now();
		return await this.save();
	}

	async vote() {
		// check if user has voted within the last 12 hours
		const lastVoted = await this.getLastVoted();
		const cooldown = 12 * 60 * 60 * 1000;
		if (Date.now() - lastVoted < cooldown) return { voted: false, message: "You have already voted today!" };

		// check api for vote
		const url = `https://top.gg/api/bots/${process.env.CLIENT_ID || config.client.id}/check?userId=${await this.getUserId()}`;

		return await fetch(url, { method: "GET", headers: { Authorization: process.env.TOPGG_TOKEN || config.client.topgg_token}})
			.then(async (res) => res.text())
			.then(async (json) => {
				var isVoted = JSON.parse(json).voted;

				if (isVoted === 0) {
					return { voted: false, message: `You haven't voted yet!\nYou can vote at https://top.gg/bot/${process.env.CLIENT_ID || config.client.id}/vote` };
				}

				// update user stats
				const stats = await this.getStats();
				stats.votes++;
				await this.setStats(stats);
				this.setLastVoted();

				// give user reward
				const reward = await Item.findOne({ name: 'Voter\'s Crate' });
				await this.sendToInventory(reward);

				// add money
				await this.addMoney(10000);

				return { voted: true, message: "Thank you for voting! You have received:\n- 1x Voter's Crate\n- $10000" };
			});
	}

	async findQuests(specificFish, specificRod, specificQualities) {
		const query = {
			'status': 'in_progress',
			$and: [],
		};
		
		query.$and.push({ user: await this.getUserId() });
		query.$and.push({ $or: [{ 'progressType.fish': specificFish }, { 'progressType.fish': 'any' }] });
		query.$and.push({ $or: [{ 'progressType.rod': specificRod }, { 'progressType.rod': 'any' }] });
		specificQualities.map(quality => query.$and.push({ $or: [{ 'progressType.qualities': quality }, { 'progressType.qualities': 'any' }] }));
	
		const quests = await QuestData.find(query);
		return quests;
	};

	async startQuest(originalQuest) {
		const userId = await this.getUserId();
		const cloned = await originalQuest.clone(userId);

		await this.addQuest(await cloned.getId());
		return cloned;
	};

	static async create(userId) {
		const rod = await Item.findOne({ name: 'Old Rod' });
		const data = new UserSchema({
			userId: userId,
			commands: 0,
			xp: 0,
			inventory: {
				equippedRod: null,
				equippedBait: null,
				items: [],
				baits: [],
				rods: [],
				fish: [],
				quests: [],
			},
			type: 'user',
		});
		await data.save();
		const user = new User(data);
		await user.sendToInventory(rod._id);
		await user.setEquippedRod((await user.getInventory()).rods[0]);
	
		return await UserSchema.findOne({ userId: userId });
	};
	
	static async get(userId) {
		if (!userId) return null;
		let user = await UserSchema.findOne({ userId: userId });
		if (!user) {
			user = await this.create(userId);
		}
	
		return user;
	};
}

module.exports = { User };
