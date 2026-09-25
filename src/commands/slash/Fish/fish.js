const { SlashCommandBuilder, EmbedBuilder, ButtonStyle, ActionRowBuilder, ButtonBuilder, ComponentType } = require('discord.js');
const { Fish } = require('../../../class/Fish');
const { Quest } = require('../../../class/Quest');
const { Pond } = require('../../../schemas/PondSchema');
const { Item } = require('../../../schemas/ItemSchema');
const { User } = require('../../../class/User');
const config = require('../../../config');
const { Interaction } = require('../../../class/Interaction');
const { Icons } = require('../../../class/Icons');
const branding = require('../../../branding');

const updateUserWithFish = async (interaction, userId) => {
	const user = new User(await User.get(userId));
	const pond = await Pond.findOne({ id: interaction.channel.id });
	if (pond && pond.count <= 0) {
		return { fish: [], questsCompleted: [], xp: 0, rodState: '', success: false, message: 'The pond is empty!' };
	}
	let rod = await user.getEquippedRod();
	const bait = await user.getEquippedBait();
	const biome = await user.getCurrentBiome();
	const fishArray = await Fish.reel(rod._id, bait, biome, interaction.guild.id, user);
	let xp = 0;
	let levelUp = false;

	for (let i = 0; i < fishArray.length; i++) {
		xp += await user.generateBoostedXP();
	}

	if (bait) {
		xp = Math.floor(xp * bait.multiplier);
	}

	const completedQuests = [];
	// const user = await User.get(userId);
	if (user) {
		const stats = await user.getStats();
		stats.latestFish = [];
		if (bait) {
			bait.count -= fishArray.reduce((acc, f) => acc + (f.count || 1), 0);
			if (bait.count < 0) bait.count = 0;
			if (bait.count == 0) {
				await user.setEquippedBait(null);
				// delete bait from user inventory
				await user.removeBait(bait._id);
			}
		}
		for (let i = 0; i < fishArray.length; i++) {
			const f = fishArray[i];
			if (!f.count) f.count = 1;

			// await user.sendToInventory(f._id, f.count);

			let message = '';
			switch (rod.state) {
			case 'broken':
				message = `Your rod is ${rod.state}! You can't catch any more fish until you repair it.`;
				break;
			case 'destroyed':
				message = `Your rod is ${rod.state}! You can't use it anymore.`;
				break;
			default:
				message = '';
				break;
			}

			if (rod.state === 'broken' || rod.state === 'destroyed') {
				return { fish: [], questsCompleted: [], xp: 0, rodState: rod.state, success: false, message: message };
			}
			else {
				rod = await user.decreaseRodDurability(f.count || 1);
			}

			rod.fishCaught += f.count || 1;
			stats.fishCaught += f.count || 1;
			stats.latestFish.push(f);
			stats.soldLatestFish = false;
			stats.fishStats.set(f.name.toLowerCase(), (stats.fishStats.get(f.name.toLowerCase()) || 0) + (f.count || 1));
			await user.setStats(stats);
			await user.addXP(xp);
			levelUp = await user.updateLevel();

			if (pond) {
				pond.count -= f.count || 1;
				if (pond.count <= 0) {
					pond.count = 0;
				}
				else if (pond.count <= 250 && !pond.warning) {
					pond.warning = true;
					await pond.save();
					await interaction.followUp({
						embeds: [
							new EmbedBuilder()
								.setTitle('Pond')
								.addFields({ name: 'Pond Status', value: `The pond is running low! There are only ${pond.count} fish left!` }),
						],
					});
				}
				pond.lastFished = Date.now();
				await pond.save();
			}

			// quest stuff
			const quests = await user.findQuests(f.name.toLowerCase(), rod.name.toLowerCase(), f.qualities.map(q => q.toLowerCase()));

			for (let j = 0; j < quests.length; j++) {
				const quest = new Quest(quests[j]);
				// check to see if fish matches progressType
				const questProgress = {
					fish: false,
					rarity: false,
					rod: false,
					qualities: false,
					size: false,
					weight: false,
				};

				const progressType = await quest.getProgressType();

				if (progressType.fish.includes('any') || progressType.fish.includes(f.name.toLowerCase())) questProgress.fish = true;
				if (progressType.rarity.includes('any') || progressType.rarity.includes(f.rarity.toLowerCase())) questProgress.rarity = true;
				if (progressType.rod === 'any' || progressType.rod === rod.name.toLowerCase()) questProgress.rod = true;
				if (progressType.qualities.includes('any') || progressType.qualities.some(q => f.qualities.map(quality => quality.toLowerCase()).includes(q))) questProgress.qualities = true;
				if (progressType.size === 'any' || parseFloat(progressType.size).toFixed(3) <= f.size.toFixed(3)) questProgress.size = true;
				if (progressType.weight === 'any' || parseFloat(progressType.weight).toFixed(3) <= f.weight.toFixed(3)) questProgress.weight = true;

				if (questProgress.fish && questProgress.rarity && questProgress.rod && questProgress.qualities && questProgress.size && questProgress.weight) {
					const currentProgress = await quest.getProgress();
					await quest.setProgress(currentProgress + (f.count || 1));
				}

				if (await quest.getProgress() >= await quest.getMaxProgress()) {
					await user.addXP(await quest.getXP());
					if (await user.updateLevel()) levelUp = true;
					await user.addMoney(await quest.getCash());

					const reward = await quest.getReward();
					if (reward && reward.length > 0) {
						for (const r of reward) {
							await user.sendToInventory(r);
						}
					}

					quest.end();
					completedQuests.push(quest);
				}
				// await quest.save();
			}
			// end quest stuff

			await f.save();
		}

		await rod.save();
		if (bait) await bait.save();
		// await user.save();
		return { fish: fishArray, questsCompleted: completedQuests.filter((quest, index, self) => self.findIndex(async q => await q.getTitle() === await quest.getTitle()) === index), xp: xp, rodState: rod.state, bait: bait, levelUp: levelUp, success: true, message: '' };
	}
};

// Presentation helpers for the catch embed.
const RARITY_ORDER = Object.keys(branding.rarityColors);
const formatMeasure = (n) => n.toLocaleString('en-US', { maximumFractionDigits: n < 10 ? 2 : 1 });

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

const followUpMessage = async (interaction, user, fishArray, completedQuests, xp, rodState, bait, levelUp, success, message) => {
	const fields = [];
	const warnings = [];
	let fishAgainDisabled = false;
	const userObj = new User(await User.get(user.id));

	const embed = new EmbedBuilder().setFooter({ text: branding.name });

	let catchId;
	if (success) {
		fishArray.forEach(f => {
			if (!catchId) catchId = f.catchId;
		});

		embed
			.setTitle(`🎣 ${user.displayName}'s catch`)
			.setColor(catchColor(fishArray))
			.setDescription(`${fishArray.map(formatCatch).join('\n')}\n\n**+${xp} XP**`);

		if (completedQuests.length > 0) {
			const questLines = [];
			for await (const quest of completedQuests) {
				const rewards = [`+${await quest.getXP()} XP`, `+$${((await quest.getCash()) || 0).toLocaleString('en-US')}`];

				const reward = await quest.getReward();
				if (reward && reward.length > 0) {
					for await (const rew of reward) {
						const r = await Item.findById(rew);
						if (r) rewards.push(`${Icons.of(r)} ${r.name}`);
					}
				}
				questLines.push(`✅ **${await quest.getTitle()}**\n-# ${rewards.join(' · ')}`);
			}
			fields.push({ name: '📜 Quest complete', value: questLines.join('\n') });
		}

		if (levelUp) {
			fields.push({ name: '⭐ Level up!', value: `You reached level **${await userObj.getLevel()}**.` });
		}

		if (rodState === 'broken') {
			fishAgainDisabled = true;
			warnings.push('Your fishing rod has broken! Repair it to keep fishing.');
		}
		else if (rodState === 'destroyed') {
			fishAgainDisabled = true;
			warnings.push('Your fishing rod has been destroyed! Looks like you need to buy a new one.');
		}

		if (bait?.count == 0) {
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
			.setDescription(message || 'Something went wrong while fishing.');
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
					.setCustomId(`sell-one-fish:${catchId || 0}`)
					.setLabel('Sell')
					.setEmoji('💰')
					.setStyle(ButtonStyle.Danger)
					.setDisabled(fishArray.length === 0),
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
	options: {
		cooldown: 5000,
	},
	/**
     * @param {ExtendedClient} client
     * @param {ChatInputCommandInteraction} interaction
     */
	async run(client, interaction, analyticsObject, user = null) {
		if (user === null) user = interaction.user;

		await interaction.deferReply();

		const object = await updateUserWithFish(interaction, user.id);
		const newFish = object.fish;
		const completedQuests = object.questsCompleted;
		const xp = object.xp;
		const rodState = object.rodState;
		const bait = object.bait;
		const levelUp = object.levelUp;
		const success = object.success;
		const message = object.message;

		if (process.env.ANALYTICS || config.client.analytics) {
			await analyticsObject.setStatus(success ? 'completed' : 'failed');
			await analyticsObject.setStatusMessage(message || 'Fished.');
		}

		const followUp = await followUpMessage(interaction, user, newFish, completedQuests, xp, rodState, bait, levelUp, success, message);

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
