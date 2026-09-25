const {
	SlashCommandBuilder,
	EmbedBuilder,
	ActionRowBuilder,
	ButtonBuilder,
	ButtonStyle,
} = require('discord.js');
const { User } = require('../../../class/User');
const config = require('../../../config');
const { Icons } = require('../../../class/Icons');

module.exports = {
	customId: 'open-again',
	structure: new SlashCommandBuilder()
		.setName('open')
		.setDescription('Opens a gacha box.')
		.addStringOption((option) =>
			option
				.setName('name')
				.setDescription('Name of the box you wish to open.')
				.setRequired(true),
		),
	/**
	 * @param {ExtendedClient} client
	 * @param {ChatInputCommandInteraction<true>} interaction
	 */
	run: async (client, interaction, analyticsObject, usr = null, prop) => {
		await interaction.deferReply();

		const name = prop ? prop : interaction.options.getString('name');

		// Open the box
		const user = usr ? usr : new User(await User.get(interaction.user.id));
		const opened = await user.openBox(name.toLowerCase());
		let description = 'Rewards: \n';

		if (opened) {
			for (const object of opened) {
				const item = object.item;
				description += `${Icons.of(item)} ${object.count}x ${item.name}\n`;
			}

			if (process.env.ANALYTICS || config.client.analytics) {
				await analyticsObject.setStatus('completed');
				await analyticsObject.setStatusMessage('Opened a box.');
			}

			let components = [
				new ActionRowBuilder()
					.addComponents(
						new ButtonBuilder()
							.setCustomId('open-again:' + name)
							.setLabel('Open Again')
							.setStyle(ButtonStyle.Primary)
							.setDisabled(false),
					)
			];

			const filter = (i) => i.user.id === interaction.user.id;
			const collector = interaction.channel.createMessageComponentCollector({
				filter,
				time: 30000,
			});
			
			collector.on('collect', async (i) => {
				const cId = i.customId.split(':')[0];
				const propName = i.customId.split(':').pop();
				if (cId === 'open-again') {
					collector.stop();
					await module.exports.run(client, i, analyticsObject, user, propName);
				}
			});
			
			collector.on('end', async (collected) => {
				if (collected.size === 0) {
					await interaction.editReply({
						components: [],
					});
				}
			});

			return await interaction.editReply({
				embeds: [
					new EmbedBuilder()
						.setTitle(`Opened ${name.split(' ').map((word) => word.charAt(0).toUpperCase() + word.slice(1)).join(' ')}`)
						.setDescription(description)
						.setColor('Green'),
				],
				components: components,
			});
		}
		else {
			if (process.env.ANALYTICS || config.client.analytics) {
				await analyticsObject.setStatus('failed');
				await analyticsObject.setStatusMessage('You do not have a box with that name.');
			}

			return await interaction.editReply({
				content: 'You do not have a box with that name!',
				ephemeral: true,
			});
		}
	},
};
