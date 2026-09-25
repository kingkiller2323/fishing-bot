const { SlashCommandBuilder, EmbedBuilder } = require('discord.js');
const { User } = require('../../../class/User');
const { Habitat } = require('../../../schemas/HabitatSchema');
const { PetFish } = require('../../../schemas/PetSchema');
const { Aquarium } = require('../../../class/Aquarium');
const { Pet } = require('../../../class/Pet');
const buttonPagination = require('../../../buttonPagination');
const config = require('../../../config');
const { Icons } = require('../../../class/Icons');

module.exports = {
	structure: new SlashCommandBuilder()
		.setName('aquarium')
		.setDescription('Everything about your aquariums!')
		.addSubcommand((o) => o.setName('view').setDescription('View your aquariums.'))
		.addSubcommand((o) => o.setName('upgrade').setDescription('Upgrade your aquarium.')
			.addStringOption((p) => p.setName('name').setDescription('The name of the aquarium you want to upgrade.').setRequired(true)))
		.addSubcommand((o) => o.setName('clean').setDescription('Clean your aquarium.')
			.addStringOption((p) => p.setName('name').setDescription('The name of the aquarium you want to clean.').setRequired(true)))
		.addSubcommand((o) => o.setName('feed').setDescription('Feed your fish.')
			.addStringOption((p) => p.setName('name').setDescription('The name of the aquarium you want to feed.').setRequired(true)))
		.addSubcommand((o) => o.setName('adjust').setDescription('Adjust the temperature of your aquarium.')
			.addStringOption((p) => p.setName('name').setDescription('The name of the aquarium you want to adjust.').setRequired(true))
			.addIntegerOption((p) => p.setName('temperature').setDescription('The temperature you want to set the aquarium to.').setRequired(true)))
		.addSubcommandGroup((o) => o.setName('fish').setDescription('Manage the fish in your aquarium.')
			.addSubcommand((p) => p.setName('move').setDescription('Add a fish to your aquarium.')
				.addStringOption(q => q.setName('pet').setDescription('The name of the pet fish you want to move').setRequired(true))
				.addStringOption(q => q.setName('aquarium').setDescription('The name of the aquarium you want to add the fish to').setRequired(true)),
			),
		),
	options: {
		cooldown: 3_000,
	},
	run: async (client, interaction, analyticsObject) => {
		const subcommand = interaction.options.getSubcommand();
		await interaction.deferReply();

		const user = new User(await User.get(interaction.user.id));
		if (!user) {
			if (process.env.ANALYTICS || config.client.analytics) {
				await analyticsObject.setStatus('failed');
				await analyticsObject.setStatusMessage('Failed to retrieve user data.');
			}
			return await interaction.followUp('There was an issue retrieving your data. Please try again later.');
		}

		if (subcommand === 'view') {
			// get aquariums owned by the user
			const aquariums = await Habitat.find({ owner: interaction.user.id });
			if (!aquariums.length) {
				if (process.env.ANALYTICS || config.client.analytics) {
					await analyticsObject.setStatus('failed');
					await analyticsObject.setStatusMessage('User does not own any aquariums.');
				}
				return await interaction.followUp('You do not own any aquariums. You can use the `build` command to create one.');
			}

			const embeds = [];
			const fields = [];

			for (const a of aquariums) {
				const aquarium = new Aquarium(a);
				await aquarium.updateStatus();
				const fish = await Promise.all((await aquarium.getFish()).map(async fishId => { return await PetFish.findById(fishId); }));
				const information = { name: `Aquarium: ${await aquarium.getName()}`, value: `**Fish**: ${(await aquarium.getFish()).length}/${await aquarium.getSize()}\n**Cleanliness**: ${await aquarium.getCleanliness()}%\n**Temperature**: ${await aquarium.getTemperature()}°C\n**Inhabitants**: ` };
				if (!fish.length) information.value += 'None';
				for (const f of fish) {
					const pet = new Pet(f);
					const fishData = await pet.getFishData();
					information.value += `${Icons.of(fishData)} ${f.name} `;
				}
				fields.push(information);
			}

			const chunkSize = 1;
			for (let i = 0; i < fields.length; i += chunkSize) {
				const chunk = fields.slice(i, i + chunkSize);

				embeds.push(new EmbedBuilder()
					.setFooter({ text: `Page ${Math.floor(i / chunkSize) + 1} / ${Math.ceil(fields.length / chunkSize)} ` })
					.setTitle(`${interaction.user.username}'s Aquariums`)
					.setDescription(`You own ${aquariums.length} aquariums.`)
					.setColor('Blue')
					.addFields(chunk),
				);
			}

			if (process.env.ANALYTICS || config.client.analytics) {
				await analyticsObject.setStatus('completed');
				await analyticsObject.setStatusMessage('Displayed aquariums.');
			}

			return await buttonPagination(interaction, embeds, analyticsObject, true);
		}

		else if (subcommand === 'upgrade') {
			const aquariumName = interaction.options.getString('name');
			const aquariumData = await Habitat.findOne({ name: aquariumName, owner: interaction.user.id });
			if (!aquariumData) {
				if (process.env.ANALYTICS || config.client.analytics) {
					await analyticsObject.setStatus('failed');
					await analyticsObject.setStatusMessage('User does not own the aquarium.');
				}
				return await interaction.followUp(`You do not own an aquarium named **${aquariumName}**.`);
			}

			const aquarium = new Aquarium(aquariumData);

			const license = await user.getAquariumLicense(await aquarium.getWaterType());
			if (license.aquarium.size <= await aquarium.getSize()) {
				if (process.env.ANALYTICS || config.client.analytics) {
					await analyticsObject.setStatus('failed');
					await analyticsObject.setStatusMessage('Aquarium is already at maximum size.');
				}
				return await interaction.followUp(`The aquarium named **${aquariumName}** is already at the maximum size allowed by your license.`);
			}
			else {
				await aquarium.upgrade(license.aquarium.size);
			}

			if (process.env.ANALYTICS || config.client.analytics) {
				await analyticsObject.setStatus('completed');
				await analyticsObject.setStatusMessage('Aquarium upgraded.');
			}

			return await interaction.followUp(`You have upgraded the aquarium named **${aquariumName}**. It can now hold ${await aquarium.getSize()} fish.`);
		}

		else if (subcommand === 'clean') {
			const aquariumName = interaction.options.getString('name');
			const aquariumData = await Habitat.findOne({ name: aquariumName, owner: interaction.user.id });
			if (!aquariumData) {
				if (process.env.ANALYTICS || config.client.analytics) {
					await analyticsObject.setStatus('failed');
					await analyticsObject.setStatusMessage('User does not own the aquarium.');
				}
				return await interaction.followUp(`You do not own an aquarium named **${aquariumName}**.`);
			}

			const aquarium = new Aquarium(aquariumData);
			await aquarium.clean();

			if (process.env.ANALYTICS || config.client.analytics) {
				await analyticsObject.setStatus('completed');
				await analyticsObject.setStatusMessage('Aquarium cleaned.');
			}

			return await interaction.followUp(`You have cleaned the aquarium named **${aquariumName}**.`);
		}

		else if (subcommand === 'feed') {
			const aquariumName = interaction.options.getString('name');
			const aquariumData = await Habitat.findOne({ name: aquariumName, owner: interaction.user.id });
			if (!aquariumData) {
				if (process.env.ANALYTICS || config.client.analytics) {
					await analyticsObject.setStatus('failed');
					await analyticsObject.setStatusMessage('User does not own the aquarium.');
				}
				return await interaction.followUp(`You do not own an aquarium named **${aquariumName}**.`);
			}

			const aquarium = new Aquarium(aquariumData);
			const fishIds = await aquarium.getFish();
			const fish = await Promise.all(fishIds.map(async fishId => { return await PetFish.findById(fishId); }));
			for (const f of fish) {
				const pet = new Pet(f);
				await pet.feed();
			}

			if (process.env.ANALYTICS || config.client.analytics) {
				await analyticsObject.setStatus('completed');
				await analyticsObject.setStatusMessage('Fish fed.');
			}

			return await interaction.followUp(`You have fed the fish in the aquarium named **${aquariumName}**.`);
		}

		else if (subcommand === 'adjust') {
			const aquariumName = interaction.options.getString('name');
			const aquariumData = await Habitat.findOne({ name: aquariumName, owner: interaction.user.id });
			if (!aquariumData) {
				if (process.env.ANALYTICS || config.client.analytics) {
					await analyticsObject.setStatus('failed');
					await analyticsObject.setStatusMessage('User does not own the aquarium.');
				}
				return await interaction.followUp(`You do not own an aquarium named **${aquariumName}**.`);
			}

			const aquarium = new Aquarium(aquariumData);
			const temperature = interaction.options.getInteger('temperature');
			if (temperature < -30 || temperature > 30) return await interaction.followUp('The temperature must be between -30 and 30 degrees Celsius.');

			await aquarium.adjustTemperature(temperature);

			if (process.env.ANALYTICS || config.client.analytics) {
				await analyticsObject.setStatus('completed');
				await analyticsObject.setStatusMessage('Temperature adjusted.');
			}

			return await interaction.followUp(`You have set the temperature of the aquarium named **${aquariumName}** to ${temperature}°C.`);
		}

		else if (subcommand === 'fish') {
			if (process.env.ANALYTICS || config.client.analytics) {
				await analyticsObject.setStatus('failed');
				await analyticsObject.setStatusMessage('No subcommand provided.');
			}
			return await interaction.followUp('Please provide a subcommand.');
		}

		else if (subcommand === 'move') {
			const fish = interaction.options.getString('fish');
			// find the pet fish owned by user
			const petFishData = await PetFish.findOne({ name: fish, owner: interaction.user.id });
			if (!petFishData) {
				if (process.env.ANALYTICS || config.client.analytics) {
					await analyticsObject.setStatus('failed');
					await analyticsObject.setStatusMessage('User does not own a pet with that name.');
				}
				return await interaction.followUp(`You do not own a pet fish named **${fish}**. You can use the \`adopt\` command to adopt one.`);
			}

			const aquariumName = interaction.options.getString('aquarium');
			// check if the aquarium exists
			const aquariumData = await Habitat.findOne({ name: aquariumName, owner: interaction.user.id });
			if (!aquariumData) {
				if (process.env.ANALYTICS || config.client.analytics) {
					await analyticsObject.setStatus('failed');
					await analyticsObject.setStatusMessage('User does not own the aquarium.');
				}
				return await interaction.followUp(`You do not own an aquarium named **${aquariumName}**.`);
			}
				
			// check if the fish is already in the aquarium
			if (aquariumData.fish.includes(petFishData.id)) {
				if (process.env.ANALYTICS || config.client.analytics) {
					await analyticsObject.setStatus('failed');
					await analyticsObject.setStatusMessage('Fish already in specified aquarium.');
				}
				return await interaction.followUp(`The fish named **${fish}** is already in the aquarium named **${aquariumName}**.`);
			}
			// check if the aquarium is full
			if (aquariumData.fish.length >= aquariumData.size) {
				if (process.env.ANALYTICS || config.client.analytics) {
					await analyticsObject.setStatus('failed');
					await analyticsObject.setStatusMessage('Aquarium is full.');
				}
				return await interaction.followUp(`The aquarium named **${aquariumName}** is full.`);
			}

			const pet = new Pet(petFishData);
			const aquarium = new Aquarium(aquariumData);

			// check if biome origin is the same as the aquarium's water type
			const petBiome = await pet.getBiome();
			if (!await aquarium.compareBiome(petBiome)) {
				if (process.env.ANALYTICS || config.client.analytics) {
					await analyticsObject.setStatus('failed');
					await analyticsObject.setStatusMessage('Fish cannot live in specified aquarium.');
				}
				return await interaction.followUp(`The fish named **${fish}** cannot live in a ${await aquarium.getWaterType()} aquarium.`);
			}

			// move pet to aquarium
			await aquarium.moveFish(pet, aquarium);

			if (process.env.ANALYTICS || config.client.analytics) {
				await analyticsObject.setStatus('completed');
				await analyticsObject.setStatusMessage('The pet fish has been moved to the specified aquarium.');
			}
			return await interaction.followUp(`You have moved **${fish}** to the aquarium named **${aquariumName}**.`);
		}
	},
};