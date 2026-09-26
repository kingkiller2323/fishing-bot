const { SlashCommandBuilder, EmbedBuilder, MessageFlags } = require('discord.js');
const { User } = require('../../../class/User');
const config = require('../../../config');

module.exports = {
	structure: new SlashCommandBuilder()
		.setName('balance')
		.setDescription('Check how much money you have!'),
	options: {
		cooldown: 10_000,
	},
	/**
     * @param {ExtendedClient} client
     * @param {ChatInputCommandInteraction} interaction
     */
	run: async (client, interaction, analyticsObject) => {

		await interaction.deferReply({ flags: MessageFlags.Ephemeral });

		let money = 0;
		const user = new User(await User.get(interaction.user.id));
		if (user) {
			money = await user.getMoney();
		}

		if (process.env.ANALYTICS || config.client.analytics) {
			await analyticsObject.setStatus('completed');
			await analyticsObject.setStatusMessage('Checked balance.');
		}

		await interaction.followUp({
			flags: MessageFlags.Ephemeral,
			embeds: [
				new EmbedBuilder()
					.setTitle('Bank')
					.addFields(
						{ name: 'Current Balance', value: `You currently have **$${money}**.` },
					),
			],
		});

	},
};
