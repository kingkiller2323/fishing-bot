const { ActionRowBuilder, ButtonBuilder, ButtonStyle, ComponentType, MessageFlags } = require('discord.js');
const config = require('./config');
const { Interaction } = require('./class/Interaction');

// `options.privateReply`: reply privately to the invoking player (e.g. /inventory, /stats, /collection).
// Callers that omit it keep the previous public behaviour (e.g. /profile).
module.exports = async (interaction, pages, analyticsObject = null, deferred = false, components = [], time = 90_000, options = {}) => {
	try {
		if (!interaction || !pages || !Array.isArray(pages) || pages.length === 0) throw new Error('Invalid arguments');
		const ephemeral = Boolean(options?.privateReply);

		if (!deferred) {
			await interaction.deferReply(ephemeral ? { flags: MessageFlags.Ephemeral } : undefined);
		}

		if (pages.length === 1) {
			return await interaction.editReply({
				embeds: pages,
				components: [...components],
				fetchReply: true,
			});
		}

		const prev = new ButtonBuilder().setCustomId('prev').setEmoji('⬅️').setStyle(ButtonStyle.Primary).setDisabled(true);

		const home = new ButtonBuilder().setCustomId('home').setEmoji('🏠').setStyle(ButtonStyle.Secondary).setDisabled(true);

		const next = new ButtonBuilder().setCustomId('next').setEmoji('➡️').setStyle(ButtonStyle.Primary);

		const buttons = new ActionRowBuilder().addComponents([prev, home, next]);
		let index = 0;

		const msg = await interaction.editReply({
			embeds: [pages[index]],
			components: [buttons, ...components],
			fetchReply: true,
		});
		// An ephemeral message cannot be edited with the bot token (Message#edit); edit it through the
		// original interaction's webhook instead. Public replies keep using Message#edit as before.
		const edit = (payload) => (ephemeral ? interaction.editReply(payload) : msg.edit(payload));

		const mc = await msg.createMessageComponentCollector({
			componentType: ComponentType.Button,
			time,
			filter: (i) => ['prev', 'home', 'next'].includes(i.customId),
		});

		mc.on('collect', async (i) => {
			if (i.user.id !== interaction.user.id) return i.reply({ content: 'You are not allowed to do this!', flags: MessageFlags.Ephemeral });

			await i.deferUpdate({});

			if ((process.env.ANALYTICS || config.client.analytics) && analyticsObject) {
				await Interaction.generateCommandObject(i, analyticsObject);
			}

			if (i.customId === 'prev') {
				if (index > 0) index--;
			}
			else if (i.customId === 'home') {
				index = 0;
			}
			else if (i.customId === 'next') {
				if (index < pages.length - 1) index++;
			}

			if (index === 0) {
				prev.setDisabled(true);
				home.setDisabled(true);
			}
			else {
				prev.setDisabled(false);
				home.setDisabled(false);
			}

			if (index === pages.length - 1) {
				next.setDisabled(true);
			}
			else {
				next.setDisabled(false);
			}

			await edit({
				embeds: [pages[index]],
				components: [buttons, ...components],
			});

			mc.resetTimer();

			return msg;
		});

		mc.on('end', async () => {
			await edit({
				embeds: [pages[index]],
				components: [],
			});
		});
	}
	catch (err) {
		console.error(err);
	}
};