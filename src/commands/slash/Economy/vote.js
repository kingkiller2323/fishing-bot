const { SlashCommandBuilder, EmbedBuilder } = require('discord.js');
const { User } = require('../../../class/User');

module.exports = {
	structure: new SlashCommandBuilder()
		.setName('vote')
		.setDescription('Claim your voting rewards! Vote now at top.gg!'),
	options: {
		cooldown: 10_000,
	},
	/**
     * @param {ExtendedClient} client
     * @param {ChatInputCommandInteraction} interaction
     */
	run: async (client, interaction) => {
		// 5B (P-STREAK-VOTE): voting rewards are retired; no Top.gg call is made. Private notice.
		if (require('../../../engine/balance').isBalance5b()) {
			return interaction.reply({ content: 'Voting rewards have ended. Your daily reward is now your streak: fish a little every day. See /daily. Your Voter\'s Crates still open with /open.', flags: require('discord.js').MessageFlags.Ephemeral });
		}

		await interaction.deferReply();

		const user = new User(await User.get(interaction.user.id));
		const vote = await user.vote();

		await interaction.followUp({
			embeds: [
				new EmbedBuilder()
					.addFields(
						{ name: `${vote.voted ? 'Success' : 'Failure'}`, value: vote.message },
					),
			],
		});

	},
};
