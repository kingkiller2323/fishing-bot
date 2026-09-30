// "Use Old Rod" on the broken-rod card (5B release only): equips the player's unbreakable Old Rod, granting one
// only if none is owned. Private reply.
const { MessageFlags } = require('discord.js');
const { isBalance5b } = require('../../engine/balance');

module.exports = {
	customId: 'use-old-rod',
	run: async (client, interaction) => {
		if (!isBalance5b()) return interaction.reply({ content: 'This button is not available.', flags: MessageFlags.Ephemeral });
		await require('../../engine/b5/rodOps').useOldRod(interaction.user.id);
		return interaction.reply({ content: '🎣 You switched to your Old Rod. It never breaks. Repair your rod any time to switch back.', flags: MessageFlags.Ephemeral });
	},
};
