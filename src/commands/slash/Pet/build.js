const { SlashCommandBuilder, EmbedBuilder, MessageFlags } = require('discord.js');
const { Utils } = require('../../../class/Utils');
const { Aquarium } = require('../../../class/Aquarium');
const { Habitat } = require('../../../schemas/HabitatSchema');
const { User } = require('../../../class/User');
const config = require('../../../config');

module.exports = {
	structure: new SlashCommandBuilder()
		.setName('build')
		.setDescription('Build and aquarium!')
		.addStringOption((option) =>
			option
				.setName('name')
				.setDescription('Name of the aquarium.')
				.setRequired(true),
		)
		.addStringOption((option) =>
			option
				.setName('watertype')
				.setDescription('Freshwater or Saltwater?')
				.setRequired(true),
		),
	options: {
		cooldown: 10_000,
	},
	/**
     * @param {ExtendedClient} client
     * @param {ChatInputCommandInteraction} interaction
     */
	run: async (client, interaction, analyticsObject) => {
		await interaction.deferReply();

		const user = new User(await User.get(interaction.user.id));
		if (!user) {
			if (process.env.ANALYTICS || config.client.analytics) {
				await analyticsObject.setStatus('failed');
				await analyticsObject.setStatusMessage('User not found.');
			}
			return interaction.followUp({ content: 'There was an error retrieving your data!', flags: MessageFlags.Ephemeral });
		}

		const name = interaction.options.getString('name');
		// check to see if user already has an aquarium with that name
		const exists = await Habitat.exists({ name: name, owner: await user.getUserId() });
		if (exists) {
			if (process.env.ANALYTICS || config.client.analytics) {
				await analyticsObject.setStatus('failed');
				await analyticsObject.setStatusMessage('Aquarium already exists.');
			}
			return interaction.followUp({ content: 'You already have an aquarium with that name!', flags: MessageFlags.Ephemeral });
		}

		let waterType = interaction.options.getString('watertype');
		waterType = Utils.capitalizeWords(waterType.toLowerCase());
		// make sure waterType is equal to either freshwater or saltwater
		if (waterType.toLowerCase() !== 'freshwater' && waterType.toLowerCase() !== 'saltwater') {
			if (process.env.ANALYTICS || config.client.analytics) {
				await analyticsObject.setStatus('failed');
				await analyticsObject.setStatusMessage('Invalid water type.');
			}
			return interaction.followUp({
				embeds: [
					new EmbedBuilder()
						.setTitle('Aquarium')
						.addFields(
							{ name: 'Build', value: 'Invalid water type!' },
						),
				],
			});
		}

		const license = await user.getAquariumLicense(waterType);
		if (!license) {
			if (process.env.ANALYTICS || config.client.analytics) {
				await analyticsObject.setStatus('failed');
				await analyticsObject.setStatusMessage('No license found.');
			}
			return interaction.followUp({ content: 'You do not have an aquarium license for that water type!', flags: MessageFlags.Ephemeral });
		}

		try {
			let newAquarium;
			if (license) {
				newAquarium = new Aquarium({
					name,
					size: license.aquarium.size,
					waterType,
					owner: await user.getUserId(),
				});

				await newAquarium.save();
				
				(await user.getInventory()).aquariums.push(await newAquarium.getId());
				await user.save();

				if (process.env.ANALYTICS || config.client.analytics) {
					await analyticsObject.setStatus('completed');
					await analyticsObject.setStatusMessage('Aquarium built.');
				}
				await interaction.followUp({
					embeds: [
						new EmbedBuilder()
							.setTitle('Aquarium')
							.addFields(
								{ name: 'Construction Complete', value: `You have successfully constructed aquarium **${name}**!` },
							),
					],
				});
			} 
			else {
				if (process.env.ANALYTICS || config.client.analytics) {
					await analyticsObject.setStatus('failed');
					await analyticsObject.setStatusMessage('Aquarium not built.');
				}
				await interaction.followUp({
					embeds: [
						new EmbedBuilder()
							.setTitle('Aquarium')
							.addFields(
								{ name: 'Construction Incomplete', value: 'Aquarium was unable to be constructed.' },
							),
					],
				});
			}
		}
		catch (error) {
			if (process.env.ANALYTICS || config.client.analytics) {
				await analyticsObject.setStatus('failed');
				await analyticsObject.setStatusMessage('Aquarium not built: ' + error);
			}
			await interaction.followUp({
				embeds: [
					new EmbedBuilder()
						.setTitle('Aquarium')
						.addFields(
							{ name: 'Construction Incomplete', value: 'Aquarium was unable to be constructed.' },
						),
				],
			});
		}
	},
};
