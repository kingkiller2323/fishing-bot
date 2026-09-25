const { SlashCommandBuilder, EmbedBuilder } = require('discord.js');
const { FishData } = require('../../../schemas/FishSchema');
const buttonPagination = require('../../../buttonPagination');
const config = require('../../../config');
const { competitiveCatches } = require('../../../engine/competitive');

module.exports = {
	structure: new SlashCommandBuilder()
		.setName('global-leaderboard')
		.setDescription('Check the global leaderboard!')
		.addSubcommand(subcommand =>
			subcommand
				.setName('fish-caught')
				.setDescription('Check the leaderboard for the most fish caught'))
		.addSubcommand(subcommand =>
			subcommand
				.setName('largest-size')
				.setDescription('Check the leaderboard for the largest size fish caught'))
		.addSubcommand(subcommand =>
			subcommand
				.setName('largest-weight')
				.setDescription('Check the leaderboard for the largest weight fish caught')),
	options: {
		cooldown: 10_000,
	},
	/**
	 * @param {ExtendedClient} client
	 * @param {ChatInputCommandInteraction} interaction
	 */
	run: async (client, interaction, analyticsObject) => {
		await interaction.deferReply();
		const subcommand = interaction.options.getSubcommand();
		
		if (subcommand === 'fish-caught') {
			try {
				const embeds = [];
				const fields = [];
	
				const fish = await FishData.find(competitiveCatches());
				const now = new Date();
				const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);
	
				const monthlyFish = fish.filter((f) => f.obtained >= startOfMonth);
	
				const userData = [];
				for (const f of monthlyFish) {
					if (!f.user) continue;
					if (userData.some((u) => u.user === f.user)) {
						const index = userData.findIndex((u) => u.user === f.user);
						userData[index].count++;
					}
					else {
						userData.push({ user: f.user, count: 1 });
					}
	
					// sort the array by count
					userData.sort((a, b) => b.count - a.count);
				}
	
				// sort the array by count
				userData.sort((a, b) => b.count - a.count);
	
				const chunkSize = 10;
				for (let i = 0; i < userData.length; i++) {
					if (userData[i].count > 1) {
						const userId = userData[i].user;
						const user = await interaction.client.users.fetch(userId);
						fields.push(`Rank ${i + 1}: **${user?.username || 'undefined'}** - ${userData[i].count} fish\n`);
					}
				}
	
				for (let i = 0; i < fields.length; i += chunkSize) {
					const chunk = fields.slice(i, i + chunkSize);
					embeds.push(
						new EmbedBuilder()
							.setFooter({ text: `Page ${Math.floor(i / chunkSize) + 1} / ${Math.ceil(fields.length / chunkSize)} ` })
							.setTitle('Monthly Global Leaderboard')
							.setColor('Green')
							.addFields([{ name: 'Rankings', value: chunk.join('') }]),
					);
				}
	
				if (process.env.ANALYTICS || config.client.analytics) {
					await analyticsObject.setStatus('completed');
					await analyticsObject.setStatusMessage('Displayed leaderboard.');
				}
	
				await buttonPagination(interaction, embeds, analyticsObject, true);
			}
			catch (err) {
				if (process.env.ANALYTICS || config.client.analytics) {
					await analyticsObject.setStatus('failed');
					await analyticsObject.setStatusMessage(err);
				}
				console.error(err);
			}
		}
		else if (subcommand === 'largest-size') {
			try {
				const embeds = [];
				const fields = [];
	
				const fish = await FishData.find(competitiveCatches());
				const now = new Date();
				const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);
	
				const monthlyFish = fish.filter((f) => f.obtained >= startOfMonth);
	
				const userData = [];
				for (const f of monthlyFish) {
					if (!f.user) continue;
					if (userData.some((u) => u.user === f.user)) {
						const index = userData.findIndex((u) => u.user === f.user);
						if (f.size > userData[index].size) {
							userData[index].size = f.size;
							userData[index].fishType = f.name;
						}
					}
					else {
						userData.push({ user: f.user, size: f.size, fishType: f.name });
					}
	
					// sort the array by size
					userData.sort((a, b) => b.size - a.size);
				}
	
				const chunkSize = 10;
				for (let i = 0; i < userData.length; i++) {
					if (userData[i].size > 1) {
						const userId = userData[i].user;
						const user = await interaction.client.users.fetch(userId);
						fields.push(`Rank ${i + 1}: **${user?.username || 'undefined'}** - **${userData[i].fishType}**: ${parseFloat(userData[i].size).toFixed(3)} cm\n`);
					}
				}
	
				for (let i = 0; i < fields.length; i += chunkSize) {
					const chunk = fields.slice(i, i + chunkSize);
					embeds.push(
						new EmbedBuilder()
							.setFooter({ text: `Page ${Math.floor(i / chunkSize) + 1} / ${Math.ceil(fields.length / chunkSize)} ` })
							.setTitle('Monthly Global Size Leaderboard')
							.setColor('Green')
							.addFields([{ name: 'Rankings', value: chunk.join('') }]),
					);
				}
	
				if (process.env.ANALYTICS || config.client.analytics) {
					await analyticsObject.setStatus('completed');
					await analyticsObject.setStatusMessage('Displayed leaderboard.');
				}
	
				await buttonPagination(interaction, embeds, analyticsObject, true);
			}
			catch (err) {
				if (process.env.ANALYTICS || config.client.analytics) {
					await analyticsObject.setStatus('failed');
					await analyticsObject.setStatusMessage(err);
				}
				console.error(err);
			}
		}
		else if (subcommand === 'largest-weight') {
			try {
				const embeds = [];
				const fields = [];
	
				const fish = await FishData.find(competitiveCatches());
				const now = new Date();
				const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);
	
				const monthlyFish = fish.filter((f) => f.obtained >= startOfMonth);
	
				const userData = [];
				for (const f of monthlyFish) {
					if (!f.user) continue;
					if (userData.some((u) => u.user === f.user)) {
						const index = userData.findIndex((u) => u.user === f.user);
						if (f.weight > userData[index].weight) {
							userData[index].weight = f.weight;
							userData[index].fishType = f.name;
						}
					}
					else {
						userData.push({ user: f.user, weight: f.weight, fishType: f.name });
					}
	
					// sort the array by weight
					userData.sort((a, b) => b.weight - a.weight);
				}
	
				const chunkSize = 10;
				for (let i = 0; i < userData.length; i++) {
					if (userData[i].weight > 1) {
						const userId = userData[i].user;
						const user = await interaction.client.users.fetch(userId);
						fields.push(`Rank ${i + 1}: **${user?.username || 'undefined'}** - **${userData[i].fishType}**: ${parseFloat(userData[i].weight).toFixed(3)} kg\n`);
					}
				}
	
				for (let i = 0; i < fields.length; i += chunkSize) {
					const chunk = fields.slice(i, i + chunkSize);
					embeds.push(
						new EmbedBuilder()
							.setFooter({ text: `Page ${Math.floor(i / chunkSize) + 1} / ${Math.ceil(fields.length / chunkSize)} ` })
							.setTitle('Monthly Global Weight Leaderboard')
							.setColor('Green')
							.addFields([{ name: 'Rankings', value: chunk.join('') }]),
					);
				}
	
				if (process.env.ANALYTICS || config.client.analytics) {
					await analyticsObject.setStatus('completed');
					await analyticsObject.setStatusMessage('Displayed leaderboard.');
				}
	
				await buttonPagination(interaction, embeds, analyticsObject, true);
			}
			catch (err) {
				if (process.env.ANALYTICS || config.client.analytics) {
					await analyticsObject.setStatus('failed');
					await analyticsObject.setStatusMessage(err);
				}
				console.error(err);
			}
		}
	},
};
