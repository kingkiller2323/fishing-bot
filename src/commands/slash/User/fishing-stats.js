const { SlashCommandBuilder, EmbedBuilder, MessageFlags } = require('discord.js');
const { fishingStats } = require('../../../engine/cast');
const { privateStatsFields } = require('../../../engine/presentation');
const { Cast } = require('../../../schemas/CastSchema');
const { User } = require('../../../class/User');
const branding = require('../../../branding');

module.exports = {
	structure: new SlashCommandBuilder()
		.setName('fishing-stats')
		.setDescription('Your current fishing odds, multipliers and last cast (only visible to you).'),
	options: {
		cooldown: 5000,
	},
	run: async (client, interaction) => {
		// Always private: this is where profile details (e.g. Founder bonuses) are shown.
		await interaction.deferReply({ flags: MessageFlags.Ephemeral });
		const userId = interaction.user.id;
		const userDoc = await User.get(userId);
		const stats = await fishingStats(userId);
		const last = await Cast.findOne({ userId, status: 'applied' }).sort({ createdAt: -1 }).lean();

		await interaction.editReply({
			embeds: [
				new EmbedBuilder()
					.setTitle('🎣 Your fishing stats')
					.setColor(branding.color)
					.addFields(privateStatsFields({
						stats,
						lastCast: last?.result,
						lastSale: userDoc?.stats?.lastSale,
						gachaPity: userDoc?.pity?.gacha instanceof Map ? Object.fromEntries(userDoc.pity.gacha) : userDoc?.pity?.gacha,
					}))
					.setFooter({ text: `${branding.name} · only you can see this` }),
			],
		});
	},
};
