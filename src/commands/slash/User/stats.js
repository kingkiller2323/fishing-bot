const { SlashCommandBuilder, EmbedBuilder } = require('discord.js');
const buttonPagination = require('../../../buttonPagination');
const { User } = require('../../../class/User');
const config = require('../../../config');

module.exports = {
	structure: new SlashCommandBuilder()
		.setName('stats')
		.setDescription('Check your stats!'),
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
			const user = new User(await User.get(interaction.user.id));
			const rods = await user.getRods();
			const stats = await user.getStats();

			let fields = [{
				name: 'Total Fish Caught',
				value: `${stats.fishCaught || 0}`,
				inline: false,
			}];

			fields = fields.concat(rods.map((item) => ({
				name: item.name,
				value: `Fish Caught: ${item.fishCaught || 0}`,
				inline: true,
			})));

			stats.fishStats.forEach((value, key) => {
				fields.push({
					name: key[0].toUpperCase() + key.slice(1),
					value: value.toLocaleString(),
					inline: true,
				});
			});

			const chunkSize = 6;

			for (let i = 0; i < fields.length; i += chunkSize) {
				const chunk = fields.slice(i, i + chunkSize);

				embeds.push(new EmbedBuilder()
					.setFooter({ text: `Page ${Math.floor(i / chunkSize) + 1} / ${Math.ceil(fields.length / chunkSize)} ` })
					.setTitle('Stats')
					.setColor('Green')
					.addFields(chunk),
				);
			}

			if (process.env.ANALYTICS || config.client.analytics) {
				await analyticsObject.setStatus('completed');
				await analyticsObject.setStatusMessage('Displayed user stats.');
			}

			await buttonPagination(interaction, embeds, analyticsObject, false, [], undefined, { privateReply: true });
		}
		catch (err) {
			console.error(err);
		}
	},
};
