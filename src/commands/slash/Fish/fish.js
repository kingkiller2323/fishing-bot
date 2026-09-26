const { SlashCommandBuilder, EmbedBuilder, ButtonStyle, ActionRowBuilder, ButtonBuilder, ComponentType, MessageFlags } = require('discord.js');
const { User } = require('../../../class/User');
const config = require('../../../config');
const { Interaction } = require('../../../class/Interaction');
const { Icons } = require('../../../class/Icons');
const branding = require('../../../branding');
const { castLine, applyCastResult, recoverPendingCasts } = require('../../../engine/cast');
const { withUserLock } = require('../../../engine/userLock');
const { remainingMs, startCooldown } = require('../../../engine/cooldown');
const { COOLDOWN } = require('../../../engine/balance');
const { formatMeasure } = require('../../../engine/presentation');

/**
 * One cast: decide everything (castLine), then persist it once (applyCastResult).
 * Serialized per player so casts and sells never interleave.
 */
const cast = (interaction, userId) => withUserLock(userId, async () => {
	// Make sure the player exists (creates the account and starter rod on first cast).
	await User.get(userId);
	await recoverPendingCasts({ userId });
	// Authoritative cooldown check, inside the lock so simultaneous clicks cannot both cast.
	const wait = remainingMs(userId);
	if (wait > 0) return { status: 'failed', failure: { code: 'COOLDOWN', message: `Slow down! You can cast again in ${(wait / 1000).toFixed(1)}s.` } };
	const result = await castLine({ userId, guildId: interaction.guild?.id, channelId: interaction.channel?.id });
	// Fishing Speed shortens the cooldown; failed casts use the base cooldown.
	startCooldown(userId, result.cooldownMs || COOLDOWN.fishMs);
	if (result.status === 'ok') await applyCastResult(result);
	return result;
});

// Presentation helpers for the catch embed.
const RARITY_ORDER = Object.keys(branding.rarityColors);

const formatCatch = (f) => {
	const count = f.count > 1 ? ` ×${f.count}` : '';
	let line = `${Icons.of(f)} **${f.name}**${count} · ${f.rarity}`;
	// Size/weight only exist on fish (a Lucky draw can also return an item).
	if (Number.isFinite(f.size) && Number.isFinite(f.weight)) {
		line += `\n-# ↳ ${formatMeasure(f.size)} cm · ${formatMeasure(f.weight)} kg`;
	}
	return line;
};

const catchColor = (fishArray) => {
	const best = fishArray.reduce((top, f) => Math.max(top, RARITY_ORDER.indexOf(f.rarity)), -1);
	return best >= 0 ? branding.rarityColors[RARITY_ORDER[best]] : branding.color;
};

const followUpMessage = async (interaction, user, result) => {
	const fields = [];
	const warnings = [];
	const success = result.status === 'ok';
	const catches = success ? result.catches : [];
	let fishAgainDisabled = false;
	const rodState = success ? result.rod.after.state : result.rodState;

	// Public card: identical for every profile. Profile details live in the private /fishing-stats.
	const embed = new EmbedBuilder().setFooter({ text: branding.name });

	if (success) {
		embed
			.setTitle(`🎣 ${user.displayName}'s catch`)
			.setColor(catchColor(catches))
			// Public amounts are the base-game rewards; the account receives the final (profile) amounts.
			// The real breakdown is in the private /fishing-stats.
			.setDescription(`${catches.map(formatCatch).join('\n')}\n\n**+${result.rewards.catchXp.base} XP**`);

		const completed = result.quests.filter((q) => q.completed);
		if (completed.length > 0) {
			const questLines = completed.map((q) => {
				const rewards = [`+${q.reward.xp.base} XP`, `+$${q.reward.cash.base.toLocaleString('en-US')}`, ...q.rewards.map((r) => r.name)];
				return `✅ **${q.title}**\n-# ${rewards.join(' · ')}`;
			});
			fields.push({ name: '📜 Quest complete', value: questLines.join('\n') });
		}

		// Public level-ups only: the card shows base XP, so the level it announces must come from base XP
		// too (a Founder's real level rises faster and would contradict the XP on the card).
		if (result.level.public.levelUp) {
			fields.push({ name: '⭐ Level up!', value: `You reached level **${result.level.public.after}**.` });
		}

		if (rodState === 'broken') {
			fishAgainDisabled = true;
			warnings.push('Your fishing rod has broken! Repair it to keep fishing.');
		}
		else if (rodState === 'destroyed') {
			fishAgainDisabled = true;
			warnings.push('Your fishing rod has been destroyed! Looks like you need to buy a new one.');
		}

		if (result.bait?.depleted) {
			warnings.push('You ran out of bait!');
		}

		if (warnings.length > 0) {
			fields.push({ name: '⚠️ Heads up', value: warnings.join('\n') });
		}
	}
	else {
		embed
			.setTitle('🎣 No catch')
			.setColor(branding.errorColor)
			.setDescription(result.failure?.message || 'Something went wrong while fishing.');
		fishAgainDisabled = true;
	}

	if (fields.length > 0) embed.addFields(fields);

	let components = [
		new ActionRowBuilder()
			.addComponents(
				new ButtonBuilder()
					.setCustomId('fish-again')
					.setLabel('Fish again')
					.setEmoji('🎣')
					.setStyle(ButtonStyle.Primary)
					.setDisabled(fishAgainDisabled),
				new ButtonBuilder()
					.setCustomId(`sell-one-fish:${success ? result.castId : 0}`)
					.setLabel('Sell')
					.setEmoji('💰')
					.setStyle(ButtonStyle.Danger)
					.setDisabled(!catches.some((c) => c.kind === 'fish')),
			),
	];

	if (rodState === 'broken') {
		components = [
			new ActionRowBuilder()
				.addComponents(
					new ButtonBuilder()
						.setCustomId('repair-rod')
						.setLabel('Repair Rod')
						.setEmoji('🔧')
						.setStyle(ButtonStyle.Primary),
				),
		];
	}

	return await interaction.followUp({
		embeds: [embed],
		components: components,
	});
};

module.exports = {
	customId: 'fish-again',
	structure: new SlashCommandBuilder()
		.setName('fish')
		.setDescription('Fish!'),
	// No static cooldown: /fish and Fish again share the engine cooldown (Fishing Speed aware).
	options: {},
	/**
     * @param {ExtendedClient} client
     * @param {ChatInputCommandInteraction} interaction
     */
	async run(client, interaction, analyticsObject, user = null) {
		if (user === null) user = interaction.user;

		const wait = remainingMs(user.id);
		if (wait > 0) {
			return interaction.reply({ content: `🎣 Slow down! You can cast again in ${(wait / 1000).toFixed(1)}s.`, flags: MessageFlags.Ephemeral });
		}

		await interaction.deferReply();

		const result = await cast(interaction, user.id);
		const success = result.status === 'ok';

		if (process.env.ANALYTICS || config.client.analytics) {
			await analyticsObject.setStatus(success ? 'completed' : 'failed');
			await analyticsObject.setStatusMessage(result.failure?.message || 'Fished.');
		}

		const followUp = await followUpMessage(interaction, user, result);

		if (success && result.pond?.warn) {
			await interaction.followUp({
				embeds: [
					new EmbedBuilder()
						.setTitle('Pond')
						.addFields({ name: 'Pond Status', value: `The pond is running low! There are only ${result.pond.after} fish left!` }),
				],
			});
		}

		// const filter = () => interaction.user.id === interaction.message.author.id;

		const collector = followUp.createMessageComponentCollector({
			componentType: ComponentType.Button,
			// filter,
			time: 30_000,
		});

		collector.on('collect', async collectionInteraction => {
			if (collectionInteraction.user.id !== user.id) return;
			if (collectionInteraction.customId === 'fish-again') {
				if (process.env.ANALYTICS || config.client.analytics) {
					await Interaction.generateCommandObject(collectionInteraction, analyticsObject);
				}
				await this.run(client, collectionInteraction, analyticsObject, user);
			}
		});

		collector.on('end', async () => {
			await followUp.edit({
				components: [],
			});
		});
	},
};
