const { SlashCommandBuilder, ActionRowBuilder, StringSelectMenuBuilder, StringSelectMenuOptionBuilder, ComponentType, MessageFlags } = require('discord.js');
const { Biome } = require('../../../schemas/BiomeSchema');
const { User } = require('../../../class/User');
const { Interaction } = require('../../../class/Interaction');
const config = require('../../../config');
const { Icons } = require('../../../class/Icons');
const { isBalance5b } = require('../../../engine/balance');
const { visibleCatalog } = require('../../../engine/b5/catalog');

/**
 * 5B /biome: every biome with its status for the player ("Open", "Permit $X", "Requires Lv N"). Selecting an
 * open biome switches to it; a biome whose level is reached but whose permit is missing offers a private
 * "Buy permit" button (engine/b5/permitOps: one guarded write), then switches.
 */
/** One field write (a whole-document save could overwrite a concurrent cast). */
const setBiome = (userId, name) => require('../../../schemas/UserSchema').User.updateOne({ userId: String(userId) }, { $set: { currentBiome: name } });

async function run5b(interaction, user) {
	const world = require('../../../engine/b5/world');
	const { buyPermit } = require('../../../engine/b5/permitOps');
	const { ButtonBuilder, ButtonStyle } = require('discord.js');
	const userData = new User(await User.get(user.id));
	const level = await userData.getGateLevel();
	const permits = userData.user.permits || [];
	const biomes = (await Biome.find(visibleCatalog()).lean()).filter((b) => world.canonBiome(b.name));
	biomes.sort((a, b) => world.biomeLevel(a.name) - world.biomeLevel(b.name));
	const describe = (b) => ({ open: 'Open', permit: `Permit $${world.permitPrice(b.name).toLocaleString()}`, level: `Requires Lv ${world.biomeLevel(b.name)}` })[world.biomeStatus(level, permits, b.name)];
	const select = new StringSelectMenuBuilder().setCustomId('switch-biome').setPlaceholder('Make a selection!').addOptions(biomes.map((b) => new StringSelectMenuOptionBuilder().setLabel(b.name).setDescription(describe(b)).setEmoji(Icons.component(b)).setValue(b.name)));
	const response = await interaction.reply({ content: 'Which biome would you like to switch to?', components: [new ActionRowBuilder().addComponents(select)], flags: MessageFlags.Ephemeral, fetchReply: true });
	const collector = response.createMessageComponentCollector({ filter: (i) => i.user.id === user.id, time: 60_000 });
	collector.on('collect', async (i) => {
		const fresh = await User.get(user.id);
		const gate = await new User(fresh).getGateLevel();
		if (i.customId === 'switch-biome') {
			const name = i.values[0];
			const status = world.biomeStatus(gate, fresh.permits || [], name);
			if (status === 'open') {
				await setBiome(user.id, name);
				return i.update({ content: `You switched to the **${name}**!`, components: [] });
			}
			if (status === 'level') return i.update({ content: `The ${name} opens at Lv ${world.biomeLevel(name)}. You are Lv ${gate}.`, components: [] });
			const buy = new ButtonBuilder().setCustomId(`buy-permit:${name}`).setLabel(`Buy permit ($${world.permitPrice(name).toLocaleString()})`).setStyle(ButtonStyle.Success);
			return i.update({ content: `The ${name} needs a one-time permit: $${world.permitPrice(name).toLocaleString()}. It never expires.`, components: [new ActionRowBuilder().addComponents(buy)] });
		}
		if (i.customId.startsWith('buy-permit:')) {
			const name = i.customId.slice('buy-permit:'.length);
			const result = await buyPermit(user.id, name);
			if (!result.ok) return i.update({ content: result.message, components: [] });
			await setBiome(user.id, name);
			return i.update({ content: `🎫 You bought the ${name} permit for $${result.price.toLocaleString()} and switched to the **${name}**!`, components: [] });
		}
	});
	collector.on('end', async () => {
		await interaction.editReply({ components: [] }).catch(() => undefined);
	});
}

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

		if (isBalance5b()) return run5b(interaction, user);
		// Rows added by the 5B release (Mountain Stream) are not part of today's world.
		const biomes = await Biome.find(visibleCatalog());
		
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

		// Only the invoker may use this menu: the selection acts on their account.
		const collector = response.createMessageComponentCollector({
			componentType: ComponentType.StringSelect,
			filter: (i) => i.user.id === user.id,
			time: 15000,
		});
		collector.on('ignore', async (i) => {
			await i.reply({ content: 'This menu is not yours! Run the command yourself to use it.', flags: MessageFlags.Ephemeral }).catch(() => undefined);
		});

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
					const level = await userData.getGateLevel();

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
					flags: MessageFlags.Ephemeral,
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
