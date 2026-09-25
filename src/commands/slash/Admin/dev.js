const { SlashCommandBuilder, PermissionFlagsBits, EmbedBuilder, MessageFlags } = require('discord.js');
const dev = require('../../../engine/dev');
const branding = require('../../../branding');

const targetOption = (o) => o.setName('user').setDescription('Target player (defaults to you)').setRequired(false);

module.exports = {
	structure: new SlashCommandBuilder()
		.setName('dev')
		.setDescription('Developer tools')
		// Hidden from regular members; DEVELOPER_IDS is still enforced on every call.
		.setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
		.setDMPermission(false)
		.addSubcommandGroup((g) => g.setName('money').setDescription('Change a player\'s money')
			.addSubcommand((s) => s.setName('add').setDescription('Add money')
				.addIntegerOption((o) => o.setName('amount').setDescription('Amount (negative to remove)').setRequired(true))
				.addUserOption(targetOption))
			.addSubcommand((s) => s.setName('set').setDescription('Set money')
				.addIntegerOption((o) => o.setName('amount').setDescription('New balance').setRequired(true).setMinValue(0))
				.addUserOption(targetOption)))
		.addSubcommandGroup((g) => g.setName('xp').setDescription('Change a player\'s XP')
			.addSubcommand((s) => s.setName('add').setDescription('Add XP')
				.addIntegerOption((o) => o.setName('amount').setDescription('Amount (negative to remove)').setRequired(true))
				.addUserOption(targetOption))
			.addSubcommand((s) => s.setName('set').setDescription('Set XP')
				.addIntegerOption((o) => o.setName('amount').setDescription('New XP total').setRequired(true).setMinValue(0))
				.addUserOption(targetOption)))
		.addSubcommand((s) => s.setName('give').setDescription('Give a catalog item')
			.addStringOption((o) => o.setName('item').setDescription('Item name, e.g. Magic Lure').setRequired(true))
			.addIntegerOption((o) => o.setName('count').setDescription('How many').setRequired(false).setMinValue(1).setMaxValue(1000))
			.addUserOption(targetOption))
		.addSubcommand((s) => s.setName('spawn').setDescription('Spawn a specific fish (never competitive)')
			.addStringOption((o) => o.setName('fish').setDescription('Fish name, e.g. Kraken').setRequired(true))
			.addIntegerOption((o) => o.setName('count').setDescription('How many').setRequired(false).setMinValue(1).setMaxValue(100))
			.addNumberOption((o) => o.setName('size').setDescription('Size in cm').setRequired(false).setMinValue(0))
			.addNumberOption((o) => o.setName('weight').setDescription('Weight in kg').setRequired(false).setMinValue(0))
			.addUserOption(targetOption))
		.addSubcommand((s) => s.setName('luck').setDescription('Temporary extra Luck (0 clears; catches become non-competitive)')
			.addNumberOption((o) => o.setName('value').setDescription('Luck bonus, e.g. 2 = +200%').setRequired(true).setMinValue(0).setMaxValue(50))
			.addIntegerOption((o) => o.setName('minutes').setDescription('Duration (default 60)').setRequired(false).setMinValue(1).setMaxValue(10080))
			.addUserOption(targetOption))
		.addSubcommand((s) => s.setName('founder').setDescription('Override a player\'s profile (Founder / Normal / Test)')
			.addStringOption((o) => o.setName('mode').setDescription('on, off, test, or default (FOUNDER_IDS)').setRequired(true)
				.addChoices({ name: 'on (Founder)', value: 'on' }, { name: 'off (Normal)', value: 'off' }, { name: 'test (unrestricted)', value: 'test' }, { name: 'default (FOUNDER_IDS)', value: 'default' }))
			.addUserOption(targetOption)),
	options: {
		developers: true,
	},
	run: async (client, interaction) => {
		await interaction.deferReply({ flags: MessageFlags.Ephemeral });
		const actor = interaction.user.id;
		const target = interaction.options.getUser('user') || interaction.user;
		const group = interaction.options.getSubcommandGroup(false);
		const sub = interaction.options.getSubcommand();
		const op = group ? `${group} ${sub}` : sub;

		let summary;
		try {
			switch (op) {
			case 'money add':
			case 'money set': {
				const r = await dev.money(actor, target.id, sub, interaction.options.getInteger('amount'));
				summary = `💰 Money: $${r.before.toLocaleString('en-US')} → $${r.after.toLocaleString('en-US')}`;
				break;
			}
			case 'xp add':
			case 'xp set': {
				const r = await dev.xp(actor, target.id, sub, interaction.options.getInteger('amount'));
				summary = `✨ XP: ${r.before.xp.toLocaleString('en-US')} (Lv ${r.before.level}) → ${r.after.xp.toLocaleString('en-US')} (Lv ${r.after.level})`;
				break;
			}
			case 'give': {
				const r = await dev.give(actor, target.id, interaction.options.getString('item'), interaction.options.getInteger('count') || 1);
				summary = `🎁 ${r.item}: ${r.before} → ${r.after}`;
				break;
			}
			case 'spawn': {
				const r = await dev.spawn(actor, target.id, interaction.options.getString('fish'), {
					count: interaction.options.getInteger('count') || 1,
					size: interaction.options.getNumber('size') ?? undefined,
					weight: interaction.options.getNumber('weight') ?? undefined,
				});
				summary = `🐟 Spawned ${r.name} (${r.size} cm · ${r.weight} kg · $${r.value}) · non-competitive`;
				break;
			}
			case 'luck': {
				const r = await dev.luck(actor, target.id, interaction.options.getNumber('value'), interaction.options.getInteger('minutes') || 60);
				summary = r.after ? `🍀 Luck +${Math.round(r.after.value * 100)}% until <t:${Math.floor(new Date(r.after.expiresAt).getTime() / 1000)}:t> · non-competitive` : '🍀 Luck override cleared';
				break;
			}
			case 'founder': {
				const r = await dev.founder(actor, target.id, interaction.options.getString('mode'));
				summary = `👑 Profile override: ${r.before} → ${r.after}`;
				break;
			}
			default:
				summary = 'Unknown developer command.';
			}
		}
		catch (error) {
			summary = `⚠️ ${error.message}`;
		}

		await interaction.editReply({
			embeds: [
				new EmbedBuilder()
					.setTitle(`🛠️ /dev ${op}`)
					.setDescription(`${summary}\n-# Target: ${target.username} · audited`)
					.setColor(branding.color)
					.setFooter({ text: branding.name }),
			],
		});
	},
};
