const { SlashCommandBuilder, EmbedBuilder } = require('discord.js');
const { User } = require('../../../class/User');
const buttonPagination = require('../../../buttonPagination');
const { Fish } = require('../../../class/Fish');
const config = require('../../../config');

module.exports = {
	structure: new SlashCommandBuilder()
		.setName('collection')
		.setDescription('Check your fish collection!'),
	options: {
		cooldown: 10_000,
	},
	/**
     * @param {ExtendedClient} client
     * @param {ChatInputCommandInteraction} interaction
     */
	run: async (client, interaction, analyticsObject) => {
		try {
			const embeds = [];
			const target = interaction.user;
			const user = new User(await User.get(target.id));

			const fields = [];
			const stats = await user.getStats();
			for (const [key] of stats.fishStats) {
				const fish = await Fish.getByName(key);
				if (!fish) continue;
				const value = `
				${fish.description}
				**Caught:** ${stats.fishStats.get(key)}
				`;
				fields.push({
					name: fish.name,
					value: value,
					inline: false,
				});
			}

			const chunkSize = 5;

			for (let i = 0; i < fields.length; i += chunkSize) {
				const chunk = fields.slice(i, i + chunkSize);

				embeds.push(
					new EmbedBuilder()
						.setFooter({ text: `Page ${Math.floor(i / chunkSize) + 1} / ${Math.ceil(fields.length / chunkSize)} ` })
						.setTitle(`${interaction.user.globalName}'s Collection`)
						.setColor('Green')
						.addFields(chunk),
				);
			}

			if (process.env.ANALYTICS || config.client.analytics) {
				await analyticsObject.setStatus('completed');
				await analyticsObject.setStatusMessage('Checked collection.');
			}

			await buttonPagination(interaction, embeds, analyticsObject);
		}
		catch (err) {
			console.error(err);
		}

	},
};
