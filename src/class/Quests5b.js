// 5B quest commands (step C.7): /daily shows (and issues) today's daily and the week's weekly; /start-quest
// lists the story chapters and repeatables with their start rule; /quests shows kind, progress and expiry.
// Replies are private. Rewards shown are the base (public) terms.
const { ActionRowBuilder, EmbedBuilder, StringSelectMenuBuilder, StringSelectMenuOptionBuilder, MessageFlags } = require('discord.js');
const { QuestData } = require('../schemas/QuestSchema');
const quests5b = require('../engine/b5/quests');

const money = (n) => `$${Math.round(n).toLocaleString()}`;
const until = (ms, now) => {
	const h = Math.max(0, (ms - now) / 3600e3);
	return h >= 24 ? `${(h / 24).toFixed(1)} d` : `${h.toFixed(1)} h`;
};
const line = (q, now) => {
	const exp = Number.isFinite(q.expiresAt) ? ` · ends in ${until(q.expiresAt, now)}` : '';
	const boxes = (q.reward || []).length ? ` · ${q.reward.length} Daily Box${q.reward.length > 1 ? 'es' : ''}` : '';
	return `**${q.title}** (${q.kind || 'legacy'}): ${q.progress || 0}/${q.progressMax}${exp}\n-# ${q.xp} XP · ${money(q.cash)}${boxes}`;
};

/** Text of today's daily and weekly (issuing them if needed). `extra` lines come from the streak (step C.8). */
async function dailyEmbed(userId, now = Date.now(), extra = []) {
	const out = await quests5b.issueDaily(userId, now);
	const lines = [];
	if (out?.daily) lines.push(`📅 ${line(out.daily, now)}`);
	if (out?.weekly) lines.push(`🗓️ ${line(out.weekly, now)}`);
	if (!lines.length) lines.push('No quest is available for you right now.');
	return new EmbedBuilder().setTitle('Daily').setColor('Green').setDescription([...extra, ...lines].join('\n\n'));
}

async function daily(interaction) {
	return interaction.reply({ embeds: [await dailyEmbed(interaction.user.id)], flags: MessageFlags.Ephemeral });
}

async function startQuest(interaction) {
	const userId = interaction.user.id;
	const list = await quests5b.startable(userId);
	const options = list.slice(0, 25).map(({ t, check, terms }) => new StringSelectMenuOptionBuilder()
		.setLabel(`${check.ok ? '' : '🔒 '}${t.title}`.slice(0, 100))
		.setDescription(`${t.kind} · ${terms.xp} XP, ${money(terms.cash)}${check.ok ? '' : ` · ${check.reason}`}`.slice(0, 100))
		.setValue(t.key));
	const message = await interaction.reply({
		content: 'Which quest would you like to start?',
		components: [new ActionRowBuilder().addComponents(new StringSelectMenuBuilder().setCustomId('start-quest-5b').setPlaceholder('Select a quest').addOptions(options))],
		flags: MessageFlags.Ephemeral,
		fetchReply: true,
	});
	const collector = message.createMessageComponentCollector({ filter: (i) => i.user.id === userId, time: 60_000, max: 1 });
	collector.on('collect', async (i) => {
		const r = await quests5b.startQuest(userId, i.values[0]);
		await i.update({ content: r.ok ? `✅ Started **${r.quest.title}**: ${r.quest.description}` : `❌ ${r.reason}.`, components: [] });
	});
	collector.on('end', () => interaction.editReply({ components: [] }).catch(() => undefined));
}

async function questsView(interaction, now = Date.now()) {
	const docs = await QuestData.find({ status: 'in_progress', user: interaction.user.id }).lean();
	const active = docs.filter((d) => !quests5b.isExpired(d, now));
	const text = active.length ? active.map((q) => line(q, now)).join('\n\n') : 'You have no active quest. Get today\'s with /daily, or start one with /start-quest.';
	return interaction.reply({ embeds: [new EmbedBuilder().setTitle('Quests').setColor('Green').setDescription(text.slice(0, 4000))], flags: MessageFlags.Ephemeral });
}

module.exports = { dailyEmbed, daily, startQuest, questsView };
