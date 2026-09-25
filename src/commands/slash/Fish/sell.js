const {
	SlashCommandBuilder,
	EmbedBuilder,
} = require('discord.js');
const { Fish } = require('../../../class/Fish');
const config = require('../../../config');
const { withUserLock } = require('../../../engine/userLock');

module.exports = {
	structure: new SlashCommandBuilder()
		.setName('sell')
		.setDescription('Sells fish by rarity.')
		.addStringOption((option) =>
			option
				.setName('rarity')
				.setDescription('Rarity of the fishes you wish to sell.')
				.setRequired(true),
		),
	/**
     * @param {ExtendedClient} client
     * @param {ChatInputCommandInteraction<true>} interaction
     */
	run: async (client, interaction, analyticsObject) => {
		await interaction.deferReply();

		let sold = 0;
		const rarity = interaction.options.getString('rarity');

		// Check if the rarity is valid
		if (!await Fish.isValidRarity(rarity)) {
			const message = 'Please provide a valid rarity. Alternatively, you may choose to sell "all" fish.';
			if (process.env.ANALYTICS || config.client.analytics) {
				await analyticsObject.setStatus('failed');
				await analyticsObject.setStatusMessage(message);
			}

			return interaction.editReply({
				embeds: [
					new EmbedBuilder()
						.setTitle('Invalid Input')
						.setDescription(message)
						.setColor('Red'),
				],
			});
		}

		const result = await withUserLock(interaction.user.id, () => Fish.sellByRarity(interaction.user.id, rarity));
		// Public message shows base value; the balance receives result.total.
		sold = result.baseTotal;
		const keptNote = result.protected > 0 ? `\n🔒 ${result.protected} locked fish ${result.protected === 1 ? 'was' : 'were'} kept.` : '';

		if (process.env.ANALYTICS || config.client.analytics) {
			await analyticsObject.setStatus('completed');
			await analyticsObject.setStatusMessage('Sold fish.');
		}
		await interaction.editReply({
			embeds: [
				new EmbedBuilder()
					.setTitle('Fish Sold')
					.setDescription(`Successfully sold **${rarity}** fish for $${sold.toLocaleString('en-US')}.${keptNote}`)
					.setColor('Green'),
			],
		});

	},
};
