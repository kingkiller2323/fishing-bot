const { SlashCommandBuilder, EmbedBuilder, MessageFlags } = require('discord.js');
const { BuffData } = require('../../../schemas/BuffSchema');
const { User } = require('../../../class/User');
const buttonPagination = require('../../../buttonPagination');
const { Icons } = require('../../../class/Icons');
const config = require('../../../config');

module.exports = {
	structure: new SlashCommandBuilder()
		.setName('boosters')
		.setDescription('Check your boosters!'),
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
			const fields = [];

			const buffInventory = [];

			const user = new User(await User.get(interaction.user.id));
			const inventory = await user.getInventory();
			if (inventory.buffs && Array.isArray(inventory.buffs)) {
				const buffNames = new Set();
				await Promise.all(
					inventory.buffs.map(async (buffObject) => {
						const buff = await BuffData.findById(buffObject.valueOf());
						if (!buffNames.has(buff.name)) {
							buffNames.add(buff.name);
							buffInventory.push(`**${buff.count}** ${Icons.of(buff)} ${buff.name}\n`);
						}
					}),
				);
			}

			const chunkSize = 1;

			if (require('../../../engine/balance').isBalance5b()) {
				// 5B: the activations on the account (time left, Lucky Draw charges).
				const e = require('../../../engine/b5/buffs').effectsAt(user.user);
				const lines = [
					...[e.xp, e.cash].filter(Boolean).map((b) => `${b.name} ×${b.multiplier} · ends <t:${Math.floor(b.endsAt / 1000)}:R>`),
					...(e.gacha ? [`${e.gacha.name} · ${e.gacha.chargesLeft} bonus slot(s) left`] : []),
				];
				fields.push(lines.length ? { name: 'Active Boosters', value: lines.join('\n') } : { name: 'No Active Boosters', value: 'You have no active boosters.' });
			}
			const activeBuffs = require('../../../engine/balance').isBalance5b() ? [] : await BuffData.find({ user: interaction.user.id, active: true });
			if (require('../../../engine/balance').isBalance5b()) {
				// shown above
			}
			else if (activeBuffs.length > 0) {
				const activeBuffNames = activeBuffs.map((buff) => buff.name);
				fields.push({ name: 'Active Boosters', value: activeBuffNames.join('\n') });
			}
			else {
				fields.push({ name: 'No Active Boosters', value: 'You have no active boosters.' });
			}

			if (inventory.buffs.length === 0) {
				fields.push({ name: 'No boosters', value: 'You have no boosters in your inventory.' });
			}
			else {
				fields.push({ name: 'Boosters', value: buffInventory.join('') });
			}

			for (let i = 0; i < fields.length; i += chunkSize) {
				const chunk = fields.slice(i, i + chunkSize);

				embeds.push(new EmbedBuilder()
					.setFooter({ text: `Page ${Math.floor(i / chunkSize) + 1} / ${Math.ceil(fields.length / chunkSize)} ` })
					.setTitle(`${interaction.user.username}'s Inventory`)
					// .setDescription(description)
					.setColor('Green')
					.addFields(chunk),
				);
			}

			if (process.env.ANALYTICS || config.client.analytics) {
				await analyticsObject.setStatus('completed');
				await analyticsObject.setStatusMessage('Displayed boosters.');
			}

			// Private for everyone (B1): the first page and every page button reply only to the player.
			await buttonPagination(interaction, embeds, analyticsObject, false, [], undefined, { privateReply: true });
		}
		catch (err) {
			console.error(err);
			const payload = { content: 'Something went wrong while loading your boosters.', flags: MessageFlags.Ephemeral };
			if (interaction.deferred || interaction.replied) await interaction.followUp(payload).catch(() => undefined);
			else await interaction.reply(payload).catch(() => undefined);
		}
	},
};
