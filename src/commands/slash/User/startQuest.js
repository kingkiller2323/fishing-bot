const { SlashCommandBuilder, ActionRowBuilder, StringSelectMenuBuilder, StringSelectMenuOptionBuilder, ComponentType, MessageFlags } = require('discord.js');
const { Quest: QuestSchema } = require('../../../schemas/QuestSchema');
const { User } = require('../../../class/User');
const { Quest } = require('../../../class/Quest');
const config = require('../../../config');
const { Interaction } = require('../../../class/Interaction');

module.exports = {
	structure: new SlashCommandBuilder()
		.setName('start-quest')
		.setDescription('Start a quest!'),
	options: {
		cooldown: 10_000,
	},
	/**
     * @param {ExtendedClient} client
     * @param {ChatInputCommandInteraction} interaction
     */
	async run(client, interaction, analyticsObject, user = null) {
		if (user === null) user = interaction.user;

		const questOptions = await QuestSchema.find({ daily: false });
		const uniqueValues = new Set();

		let options = [];
		const questPromises = questOptions.map(async (q) => {
			try {
				const value = q._id.toString();

				if (!uniqueValues.has(value)) {
					uniqueValues.add(value);

					return new StringSelectMenuOptionBuilder()
						.setLabel(q.title)
						.setDescription(`$${q.cash}, ${q.xp} XP ${q.reward.length > 0 ? q.reward.join(', ') : ''} | ${q.description}`)
						// .setEmoji(q.toJSON().icon.data.split(':')[1])
						.setValue(value);
				}

			}
			catch (error) {
				console.error(error);
			}
		});

		options = await Promise.all(questPromises);
		options = options.filter((option) => option !== undefined);

		const select = new StringSelectMenuBuilder()
			.setCustomId('start-quest')
			.setPlaceholder('Make a selection!')
			.addOptions(options);

		const row = new ActionRowBuilder()
			.addComponents(select);

		const response = await interaction.reply({
			content: 'Which quest would you like to start?',
			components: [row],
		});

		// Only the invoker may use this menu: the selection acts on their account.
		const collector = response.createMessageComponentCollector({
			componentType: ComponentType.StringSelect,
			filter: (i) => i.user.id === user.id,
			time: 15000,
		});
		collector.on('ignore', async (i) => {
			await i.reply({ content: 'This menu is not yours! Run the command yourself to use it.', flags: MessageFlags.Ephemeral }).catch(() => undefined);
		});
		collector.on('collect', async i => {
			if (process.env.ANALYTICS || config.client.analytics) {
				await Interaction.generateCommandObject(i, analyticsObject);
			}

			let canAccept = true;
			const selection = i.values[0];
			const userData = new User(await User.get(user.id));
			const originalQuest = new Quest(await Quest.get(selection));
			const title = await originalQuest.getTitle()

			// Check if user meets quest requirements
			const reqLevel = await originalQuest.getLevelRequirement();
			const level = await userData.getLevel();
			if (level < reqLevel) {
				if (process.env.ANALYTICS || config.client.analytics) {
					await analyticsObject.setStatus('failed');
					await analyticsObject.setStatusMessage('User does not meet level requirements');
				}
				canAccept = false;
				await i.reply({
					content: `You need to be level ${reqLevel} to start this quest!`,
					flags: MessageFlags.Ephemeral,
				});
				return;
			}

			const prereq = await originalQuest.getPrerequesites()
			if (prereq > 0) {
				const existingQuests = await userData.getQuests();
				const hasPrevious = existingQuests.some(quest => prereq.includes(quest.title) && quest.status === 'completed');

				if (!hasPrevious) {
					if (process.env.ANALYTICS || config.client.analytics) {
						await analyticsObject.setStatus('failed');
						await analyticsObject.setStatusMessage('User does not meet previous quest requirements');
					}
					canAccept = false;
					await i.reply({
						content: `You need to complete the previous quest(s) to start this quest!\n\n**Required Quests:**\n${originalQuest.requirements.previous.join('\n')}`,
						flags: MessageFlags.Ephemeral,
					});
					return;
				}
			}

			const existingQuests = await userData.getQuests();
			const hasExistingQuest = existingQuests.some((quest) => quest.title === title && quest.status === 'in_progress');

			if (hasExistingQuest) {
				if (process.env.ANALYTICS || config.client.analytics) {
					await analyticsObject.setStatus('failed');
					await analyticsObject.setStatusMessage('User already has quest');
				}
				await i.reply({
					content: `You already have a quest with the title **${title}**!`,
					flags: MessageFlags.Ephemeral,
				});
				return;
			}
			else if (canAccept) {
				if (process.env.ANALYTICS || config.client.analytics) {
					await analyticsObject.setStatus('completed');
					await analyticsObject.setStatusMessage('Quest started.');
				}
				await userData.startQuest(originalQuest);
				await i.reply(`${i.user} has started quest **${title}**!`);
			}
		});

		collector.on('end', async () => {
			await response.edit({
				components: [],
			});
		});
	},
};
