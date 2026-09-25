const { SlashCommandBuilder, ActionRowBuilder, StringSelectMenuBuilder, StringSelectMenuOptionBuilder, ComponentType } = require('discord.js');
const { Biome } = require('../../../schemas/BiomeSchema');
const { User } = require('../../../class/User');
const { Interaction } = require('../../../class/Interaction');
const config = require('../../../config');
const { Icons } = require('../../../class/Icons');

module.exports = {
	structure: new SlashCommandBuilder()
		.setName('biome')
		.setDescription('Switch to a new biome.'),
	options: {
		cooldown: 10_000,
	},
	/**
     * @param {ExtendedClient} client
     * @param {ChatInputCommandInteraction} interaction
     */
	async run(client, interaction, analyticsObject, user = null) {
		if (user === null) user = interaction.user;

		const biomes = await Biome.find({});
		
		// sort biomes by level requirement
		biomes.sort((a, b) => {
			const aLevel = a.requirements.find((req) => req.toLowerCase().includes('level'));
			const bLevel = b.requirements.find((req) => req.toLowerCase().includes('level'));

			if (aLevel && bLevel) {
				return aLevel.split(' ')[1] - bLevel.split(' ')[1];
			}
			return 0;
		});

		const uniqueValues = new Set();

		let options = [];
		const biomePromises = biomes.map(async (biome) => {
			try {
				const value = biome._id.toString();

				if (!uniqueValues.has(value)) {
					uniqueValues.add(value);

					return new StringSelectMenuOptionBuilder()
						.setLabel(biome.name)
						.setDescription(`${biome.requirements}`)
						.setEmoji(Icons.component(biome))
						.setValue(value);
				}

			}
			catch (error) {
				if (process.env.ANALYTICS || config.client.analytics) {
					await analyticsObject.setStatus('failed');
					await analyticsObject.setStatusMessage(error);
				}
				console.error(error);
			}
		});

		options = await Promise.all(biomePromises);
		options = options.filter((option) => option !== undefined);

		const select = new StringSelectMenuBuilder()
			.setCustomId('switch-biome')
			.setPlaceholder('Make a selection!')
			.addOptions(options);

		const row = new ActionRowBuilder()
			.addComponents(select);

		const response = await interaction.reply({
			content: 'Which biome would you like to switch to?',
			components: [row],
		});

		const collector = response.createMessageComponentCollector({ componentType: ComponentType.StringSelect, time: 15000 });

		collector.on('collect', async i => {
			if (process.env.ANALYTICS || config.client.analytics) {
				await Interaction.generateCommandObject(i, analyticsObject);
			}

			const selection = i.values[0];
			const userData = new User(await User.get(user.id));
			const originalBiome = await Biome.findById(selection);

			// check if user meets biome requirements
			let unlocked = true;
			let reqLevel = 0;
			for (const requirement of originalBiome.requirements) {
				if (requirement.toLowerCase().includes('level')) {
					reqLevel = requirement.split(' ')[1];
					const level = await userData.getLevel();

					if (level < reqLevel) {
						unlocked = false;
						break;
					}
				}
			}

			if (unlocked) {
				if (process.env.ANALYTICS || config.client.analytics) {
					await analyticsObject.setStatus('completed');
					await analyticsObject.setStatusMessage('User has switched biomes');
				}

				await userData.setCurrentBiome(originalBiome.name);
				await i.reply(`${i.user} has switched to the **${originalBiome.name}**!`);
			}
			else {
				if (process.env.ANALYTICS || config.client.analytics) {
					await analyticsObject.setStatus('failed');
					await analyticsObject.setStatusMessage('User does not meet biome requirements');
				}
				await i.reply({
					content: `You need to be level ${reqLevel} to switch to the ${originalBiome.name}!`,
					ephemeral: true,
				});
			}
		});

		collector.on('end', async () => {
			await response.edit({
				components: [],
			});
		});
	},
};
