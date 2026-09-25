const { SlashCommandBuilder, EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, ComponentType } = require('discord.js');
const config = require('../../../config');
const { Icons } = require('../../../class/Icons');
const { User } = require('../../../class/User');
const { openBox } = require('../../../engine/gacha');
const { RARITIES } = require('../../../engine/balance');
const branding = require('../../../branding');
const { formatMeasure } = require('../../../engine/presentation');

const label = (r) => r.charAt(0).toUpperCase() + r.slice(1);

/** One line per slot; Rare and above get bold names, Legendary/Lucky an extra sparkle. */
function slotLine(slot) {
	const r = slot.reward;
	const high = ['legendary', 'lucky'].includes(slot.rarity);
	const name = RARITIES.indexOf(slot.rarity) >= RARITIES.indexOf('rare') ? `**${r.name}**` : r.name;
	const extra = r.kind === 'fish' && Number.isFinite(r.size) ? `\n-# ↳ ${formatMeasure(r.size)} cm · ${formatMeasure(r.weight)} kg` : '';
	return `${Icons.of({ icon: r.icon, type: r.type })} ${name} · ${label(slot.rarity)}${high ? ' ✨' : ''}${extra}`;
}

/** Public reveal. Identical structure for every profile (no profile/luck/pity information). */
function revealEmbed(result) {
	return new EmbedBuilder()
		.setTitle(`🎁 ${result.box.name}`)
		.setDescription(result.slots.map(slotLine).join('\n'))
		.setColor(branding.rarityColors[label(result.best)] || branding.color)
		.setFooter({ text: branding.name });
}

module.exports = {
	customId: 'open-again',
	structure: new SlashCommandBuilder()
		.setName('open')
		.setDescription('Opens a gacha box.')
		.addStringOption((option) =>
			option
				.setName('name')
				.setDescription('Name of the box you wish to open.')
				.setRequired(true),
		),
	/**
	 * @param {ExtendedClient} client
	 * @param {ChatInputCommandInteraction<true>} interaction
	 */
	// Extra args: (user, boxName) when called from the 'Open another' button.
	run: async (client, interaction, analyticsObject, ...rest) => {
		await interaction.deferReply();
		const name = rest[1] || interaction.options.getString('name');
		await User.get(interaction.user.id);
		const result = await openBox({ userId: interaction.user.id, guildId: interaction.guild?.id, boxName: name });

		if (result.status !== 'ok') {
			if (process.env.ANALYTICS || config.client.analytics) {
				await analyticsObject.setStatus('failed');
				await analyticsObject.setStatusMessage(result.failure.message);
			}
			return interaction.editReply({ content: result.failure.message });
		}

		if (process.env.ANALYTICS || config.client.analytics) {
			await analyticsObject.setStatus('completed');
			await analyticsObject.setStatusMessage('Opened a box.');
		}

		const againId = `open-again:${result.box.name}`;
		const message = await interaction.editReply({
			embeds: [revealEmbed(result)],
			components: result.box.depleted ? [] : [
				new ActionRowBuilder().addComponents(
					new ButtonBuilder().setCustomId(againId).setLabel('Open another').setEmoji('🎁').setStyle(ButtonStyle.Primary),
				),
			],
		});

		if (result.box.depleted || !message?.createMessageComponentCollector) return message;
		// Scoped to this message and this player (the old collector listened to the whole channel).
		const collector = message.createMessageComponentCollector({
			componentType: ComponentType.Button,
			filter: (i) => i.user.id === interaction.user.id && i.customId === againId,
			time: 30_000,
			max: 1,
		});
		collector.on('collect', async (i) => {
			await module.exports.run(client, i, analyticsObject, null, result.box.name);
		});
		collector.on('end', async () => {
			await interaction.editReply({ components: [] }).catch(() => undefined);
		});
		return message;
	},
	revealEmbed,
};
