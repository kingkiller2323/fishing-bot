const {
	SlashCommandBuilder,
	EmbedBuilder,
} = require('discord.js');
const { User } = require('../../../class/User');
const { Utils } = require('../../../class/Utils');
const config = require('../../../config');
const { setOwnedSpeciesLocked, setSpeciesAutoLock } = require('../../../engine/locking');

module.exports = {
	structure: new SlashCommandBuilder()
		.setName('lock')
		.setDescription('Locks fish in your inventory by name.')
		.addStringOption((option) =>
			option
				.setName('name')
				.setDescription('Name of the fish you wish to lock.')
				.setRequired(true),
		),
	/**
     * @param {ExtendedClient} client
     * @param {ChatInputCommandInteraction<true>} interaction
     */
	run: async (client, interaction, analyticsObject) => {
		await interaction.deferReply();

		const name = interaction.options.getString('name');
		const user = new User(await User.get(interaction.user.id));

		if (!user) {
			if (process.env.ANALYTICS || config.client.analytics) {
				await analyticsObject.setStatus('failed');
				await analyticsObject.setStatusMessage('User not found.');
			}
			Utils.log('User not found.', 'err');
			await interaction.editReply({
				embeds: [
					new EmbedBuilder()
						.setTitle('Fish Not Locked')
						.setDescription('Failed to lock fish. User not found.')
						.setColor('Red'),
				],
			});
			return;
		}

		

		try {
			// Species command: (un)lock every owned fish of the species and switch auto-lock for
			// future catches. Individual-catch locking is a separate concept (engine/locking.js).
			await setOwnedSpeciesLocked(interaction.user.id, name, true);
			await setSpeciesAutoLock(interaction.user.id, name, true);

			if (process.env.ANALYTICS || config.client.analytics) {
				await analyticsObject.setStatus('completed');
				await analyticsObject.setStatusMessage('Locked fish.');
			}
			await interaction.editReply({
				embeds: [
					new EmbedBuilder()
						.setTitle('Fish Locked')
						.setDescription(`Successfully locked all **${name}**.`)
						.setColor('Green'),
				],
			});
		}
		catch (err) {
			if (process.env.ANALYTICS || config.client.analytics) {
				await analyticsObject.setStatus('failed');
				await analyticsObject.setStatusMessage(err);
			}
			Utils.log('Error updating fish: ' + err, 'err');
			await interaction.editReply({
				embeds: [
					new EmbedBuilder()
						.setTitle('Fish Not Locked')
						.setDescription(`Failed to lock **${name}**. An error occurred.`)
						.setColor('Red'),
				],
			});
		}
	},
};
