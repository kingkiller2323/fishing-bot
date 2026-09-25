const { SlashCommandBuilder, EmbedBuilder } = require('discord.js');
const buttonPagination = require('../../../buttonPagination');
const { RodData } = require('../../../schemas/RodSchema');
const { User } = require('../../../class/User');
const config = require('../../../config');
const { resolveProfile } = require('../../../engine/balance');

module.exports = {
	structure: new SlashCommandBuilder()
		.setName('profile')
		.setDescription('Check someone\'s profile!')
		.addUserOption((opt) =>
			opt.setName('user')
				.setDescription('The user.')
				.setRequired(false),
		),
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
			const target = interaction.options.getUser('user') || interaction.user;
			const user = new User(await User.get(target.id));
			const rods = await RodData.find({ user: target.id });
			const stats = await user.getStats();
			// Founder status is private: only shown when players view their own profile.
			const isFounder = target.id === interaction.user.id && resolveProfile(target.id, user.user).name === 'founder';

			let fields = [{
				name: `Level ${await user.getLevel() || 0}`,
				value: `${await user.getXPToNextLevel()}`,
				inline: false,
			}];

			fields = fields.concat([{
				name: 'Total Fish Caught',
				value: `${stats.fishCaught || 0}`,
				inline: false,
			}]);

			fields = fields.concat(rods.map((item) => ({
				name: item.name,
				value: `Fish Caught: ${item.fishCaught || 0}`,
				inline: true,
			})));

			const chunkSize = 6;

			for (let i = 0; i < fields.length; i += chunkSize) {
				const chunk = fields.slice(i, i + chunkSize);

				embeds.push(new EmbedBuilder()
					.setFooter({ text: `Page ${Math.floor(i / chunkSize) + 1} / ${Math.ceil(fields.length / chunkSize)} ` })
					.setTitle(`${target.globalName || target.username}'s Profile${isFounder ? ' · 👑 Founder' : ''}`)
					.setColor('Green')
					.addFields(chunk),
				);
			}

			if (process.env.ANALYTICS || config.client.analytics) {
				await analyticsObject.setStatus('completed');
				await analyticsObject.setStatusMessage('Displayed user profile.');
			}

			await buttonPagination(interaction, embeds, analyticsObject);
		}
		catch (err) {
			console.error(err);
		}
	},
};
