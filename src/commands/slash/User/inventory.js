const { SlashCommandBuilder, EmbedBuilder } = require('discord.js');
const { FishData } = require('../../../schemas/FishSchema');
const buttonPagination = require('../../../buttonPagination');
const { User } = require('../../../class/User');
const { Fish } = require('../../../class/Fish');
const { Biome } = require('../../../schemas/BiomeSchema');
const { ItemData } = require('../../../schemas/ItemSchema');
const config = require('../../../config');
const { Icons } = require('../../../class/Icons');

module.exports = {
	structure: new SlashCommandBuilder()
		.setName('inventory')
		.setDescription('Check your inventory!'),
	options: {
		cooldown: 10_000,
	},
	/**
     * @param {ExtendedClient} client
     * @param {ChatInputCommandInteraction} interaction
     */
	run: async (client, interaction, analyticsObject) => {
		try {
			const embeds = [];
			const fields = [];
			const fishInventory = {
				common: [],
				uncommon: [],
				rare: [],
				ultra: [],
				giant: [],
				legendary: [],
				lucky: [],
			};

			const user = new User(await User.get(interaction.user.id));
			const inventory = await user.getInventory();
			if (inventory.fish && Array.isArray(inventory.fish)) {
				const fishNames = new Set();
				await Promise.all(
					inventory.fish.map(async (fishObject) => {
						const fish = await FishData.findById(fishObject.valueOf());
						if (!fishNames.has(fish.name)) {
							fishNames.add(fish.name);
							const fishCount = await Fish.getCount(await user.getUserId(), fish.name);
							fishInventory[fish.rarity.toLowerCase()].push(`**${fishCount}** ${Icons.of(fish)} ${fish.name} ${fish.locked ? '🔒' : ''}\n`);
						}
					}),
				);
			}

			const chunkSize = 1;
			for (const rarity in fishInventory) {
				if (fishInventory[rarity].length > 0) {
					fields.push({ name: `${rarity.charAt(0).toUpperCase() + rarity.slice(1)} fish`, value: fishInventory[rarity].join('') });
				}
			}

			const equippedRod = await user.getEquippedRod();
			const equippedBait = await user.getEquippedBait();
			const inventoryValue = await user.getInventoryValue();
			const currentBiome = await user.getCurrentBiome();
			const userBiome = currentBiome.charAt(0).toUpperCase() + currentBiome.slice(1);
			const biome = await Biome.findOne({ name: userBiome });
			const balance = `
			**Balance:** $${inventory.money.toLocaleString()}\n`;
			const level = `**Level ${await user.getLevel()}**. ${await user.getXPToNextLevel()} to next level.\n`;
			const rod = `**Currently using**: ${Icons.of(equippedRod)} ${equippedRod?.name || 'None'}\n${equippedRod?.durability || 0} / ${equippedRod?.maxDurability || 0}\n`;
			const bait = `**With**: ${Icons.of(equippedBait)} ${equippedBait?.name || 'None'}\n`;
			const biomeString = `**Current biome**: ${Icons.of(biome)} ${biome.name.charAt(0).toUpperCase() + biome.name.slice(1) || 'Ocean'}\n`;
			const inventoryValueString = `**Inventory value**: $${await inventoryValue.toLocaleString()}\n\n`;
			const description = balance + level + rod + (equippedBait ? bait : '') + biomeString + inventoryValueString;

			if (inventory.fish.length === 0) {
				fields.push({ name: 'No fish', value: 'You have no fish in your inventory.' });
			}

			const rods = {};
			for (let i = 0; i < inventory.rods.length; i++) {
				const rodId = inventory.rods[i].valueOf();
				const rodObject = await ItemData.findById(rodId);
				const rodsOfType = await ItemData.find({ name: rodObject.name, user: await user.getUserId() });
				const count = rodsOfType.length;
				rods[rodObject.name] = `x${count || 1} ${Icons.of(rodObject)} ${rodObject.name || ''}\n`;
			}

			if (Object.keys(rods).length > 0) {
				fields.push({ name: 'Rods', value: Object.values(rods).join('') });
			}
			else {
				fields.push({ name: 'Rods', value: 'You have no fishing rods in your inventory.' });
			}

			const baits = {};
			for (let i = 0; i < inventory.baits.length; i++) {
				const baitId = inventory.baits[i].valueOf();
				const baitObject = await ItemData.findById(baitId);
				baits[baitObject.name] = `x${baitObject.count} ${Icons.of(baitObject)} ${baitObject.name || ''}\n`;
			}

			if (Object.keys(baits).length > 0) {
				fields.push({ name: 'Bait', value: Object.values(baits).join('') });
			}
			else {
				fields.push({ name: 'Bait', value: 'You have no bait in your inventory.' });
			}

			const items = {};
			for (let i = 0; i < inventory.items?.length; i++) {
				const itemId = inventory.items[i].valueOf();
				const itemObject = await ItemData.findById(itemId);
				const itemsOfType = await ItemData.find({ name: itemObject.name, user: await user.getUserId() });
				const count = itemsOfType.length;
				items[itemObject.name] = `x${count} ${Icons.of(itemObject)} ${itemObject.name || ''}\n`;
			}

			for (let i = 0; i < inventory.gacha?.length; i++) {
				const itemId = inventory.gacha[i].valueOf();
				const itemObject = await ItemData.findById(itemId);
				const count = itemObject.count;
				items[itemObject.name] = `x${count} ${Icons.of(itemObject)} ${itemObject.name || ''}\n`;
			}

			for (let i = 0; i < inventory.buffs?.length; i++) {
				const itemId = inventory.buffs[i].valueOf();
				const itemObject = await ItemData.findById(itemId);
				const count = itemObject.count;
				items[itemObject.name] = `x${count} ${Icons.of(itemObject)} ${itemObject.name || ''}\n`;
			}

			if (Object.keys(items).length > 0) {
				fields.push({ name: 'Items', value: Object.values(items).join('') });
			}
			else {
				fields.push({ name: 'Items', value: 'You have no items in your inventory.' });
			}

			for (let i = 0; i < fields.length; i += chunkSize) {
				const chunk = fields.slice(i, i + chunkSize);

				embeds.push(new EmbedBuilder()
					.setFooter({ text: `Page ${Math.floor(i / chunkSize) + 1} / ${Math.ceil(fields.length / chunkSize)} ` })
					.setTitle(`${interaction.user.username}'s Inventory`)
					.setDescription(description)
					.setColor('Green')
					.addFields(chunk),
				);
			}

			if (process.env.ANALYTICS || config.client.analytics) {
				await analyticsObject.setStatus('completed');
				await analyticsObject.setStatusMessage('Displayed inventory.');
			}

			await buttonPagination(interaction, embeds, analyticsObject);
		}
		catch (err) {
			if (process.env.ANALYTICS || config.client.analytics) {
				await analyticsObject.setStatus('failed');
				await analyticsObject.setStatusMessage(err);
			}
			console.error(err);
		}
	},
};
