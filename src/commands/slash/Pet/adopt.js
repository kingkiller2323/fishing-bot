const { SlashCommandBuilder, EmbedBuilder } = require('discord.js');
const { Utils } = require('../../../class/Utils');
const { Pet } = require('../../../class/Pet');
const { Fish } = require('../../../schemas/FishSchema');
const { Habitat } = require('../../../schemas/HabitatSchema');
const { Aquarium } = require('../../../class/Aquarium');
const { PetFish } = require('../../../schemas/PetSchema');
const { User } = require('../../../class/User');
const config = require('../../../config');
const { Icons } = require('../../../class/Icons');
const { isProtected } = require('../../../engine/protection');

module.exports = {
	structure: new SlashCommandBuilder()
		.setName('adopt')
		.setDescription('Adopt a fish!')
		.addStringOption((option) =>
			option
				.setName('species')
				.setDescription('Species of the fish you wish to adopt.')
				.setRequired(true),
		)
		.addStringOption((option) =>
			option
				.setName('name')
				.setDescription('Name the fish you wish to adopt.')
				.setRequired(true),
		)
		.addStringOption((option) =>
			option
				.setName('aquarium')
				.setDescription('Name of the aquarium your pet belongs to.')
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
			return interaction.editReply({ content: 'There was an error retrieving your data!' });
		}

		const inventory = await user.getInventory();

		let species = interaction.options.getString('species');
		species = Utils.capitalizeWords(species.toLowerCase());
		// check if species exists in database
		const exists = await Fish.exists({ name: species });
		if (!exists) {
			if (process.env.ANALYTICS || config.client.analytics) {
				await analyticsObject.setStatus('failed');
				await analyticsObject.setStatusMessage('Invalid fish species.');
			}
			return interaction.editReply({ content: 'That species does not exist!' });
		}

		const name = interaction.options.getString('name');
		// check if name is already in use
		const nameExists = await PetFish.exists({ name: name, owner: interaction.user.id });
		if (nameExists) {
			if (process.env.ANALYTICS || config.client.analytics) {
				await analyticsObject.setStatus('failed');
				await analyticsObject.setStatusMessage('Name already in use.');
			}
			return interaction.editReply({ content: 'That name is already in use!' });
		}

		const aquariumName = interaction.options.getString('aquarium');
		// check if aquarium exists in user's inventory
		const aquariums = await Promise.all(inventory.aquariums.map(async (a) => await Habitat.findById(a)));
		const aquariumExists = await aquariums.find((a) => a.name.toLowerCase() === aquariumName.toLowerCase());
		if (!aquariumExists) {
			if (process.env.ANALYTICS || config.client.analytics) {
				await analyticsObject.setStatus('failed');
				await analyticsObject.setStatusMessage('Invalid aquarium.');
			}
			return interaction.editReply({ content: 'That aquarium does not exist! Use the `build` command to construct one.' });
		}

		// find the desired aquarium in user's inventory
		const aquariumData = await aquariums.find((a) => a.name.toLowerCase() === aquariumName.toLowerCase());
		const aquarium = new Aquarium(aquariumData);

		// check if aquarium is full
		if (await aquarium.isFull()) {
			if (process.env.ANALYTICS || config.client.analytics) {
				await analyticsObject.setStatus('failed');
				await analyticsObject.setStatusMessage('Aquarium is full.');
			}
			return interaction.editReply({ content: 'Your aquarium is full! Use the `upgrade` command to increase its capacity.' });
		}

		// find the desired fish in user's inventory
		const fishes = await user.getFish();
		const fishInInventory = fishes.find((f) => f.name.toLowerCase() === species.toLowerCase() && !isProtected(f));
		if (!fishInInventory) {
			return interaction.editReply({ content: 'You do not have that fish in your inventory! Make sure it is unlocked.' });
		}

		// check if biome origin is the same as the aquarium's water type
		if (!await aquarium.compareBiome(fishInInventory.biome)) {
			if (process.env.ANALYTICS || config.client.analytics) {
				await analyticsObject.setStatus('failed');
				await analyticsObject.setStatusMessage(`Fish cannot live in a ${await aquarium.getWaterType()} aquarium.`);
			}
			return await interaction.followUp(`**${fishInInventory.name}** cannot live in a ${await aquarium.getWaterType()} aquarium.`);
		}

		let success = false;
		let newPet;
		if (fishInInventory) {
			newPet = new Pet({
				fish: fishInInventory.id,
				aquarium: await aquarium.getId(),
				name: name,
				age: 1,
				owner: await user.getUserId(),
				traits: {},
				health: 100,
				mood: 100,
				hunger: 50,
				stress: 20,
				xp: 0,
				species: fishInInventory.name,
			});

			await newPet.generateTraits();

			success = await newPet.save();
			if (success) {
				await aquarium.addFish(await newPet.getId());
				// Only take the fish once the pet exists, so a failed adoption never loses it.
				await user.removeFish(fishInInventory.id);
			}
		}
		else {
			if (process.env.ANALYTICS || config.client.analytics) {
				await analyticsObject.setStatus('failed');
				await analyticsObject.setStatusMessage('Fish not found in inventory.');
			}
			return interaction.editReply({ content: 'You do not have that fish in your inventory! Make sure it is unlocked.' });
		}

		if (success) {
			if (process.env.ANALYTICS || config.client.analytics) {
				await analyticsObject.setStatus('completed');
				await analyticsObject.setStatusMessage('Fish adopted.');
			}
			await interaction.followUp({
				embeds: [
					new EmbedBuilder()
						.setTitle('Adoption Agency')
						.addFields(
							{ name: 'Congratulations!', value: `You have successfully adopted the ${Icons.of(fishInInventory)} ${species} **${name}**! They have been added to aquarium **${aquariumName}**.` },
						),
				],
			});
		}
		else {
			if (process.env.ANALYTICS || config.client.analytics) {
				await analyticsObject.setStatus('failed');
				await analyticsObject.setStatusMessage('Failed to adopt fish.');
			}
			await interaction.followUp({
				embeds: [
					new EmbedBuilder()
						.setTitle('Adoption Agency')
						.addFields(
							{ name: 'Congratulations!', value: 'You have failed to adopt a fish!' },
						),
				],
			});
		}
	},
};
