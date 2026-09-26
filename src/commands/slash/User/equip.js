const { SlashCommandBuilder, ActionRowBuilder, StringSelectMenuBuilder, StringSelectMenuOptionBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder, MessageFlags } = require('discord.js');
const { User } = require('../../../class/User');
const { ItemData } = require('../../../schemas/ItemSchema');
const config = require('../../../config');
const { Interaction } = require('../../../class/Interaction');
const { checkLevelGate } = require('../../../engine/levelGate');

const selectionOptions = async (inventoryPath, userData, allowNone = true) => {
	const uniqueValues = new Set();
	const counts = {};
	const ids = {};
	const desc = {};

	// Loop through inventory items
	for (const objectId of (await userData.getInventory())[inventoryPath]) {
		try {
			const item = await ItemData.findById(objectId.valueOf());
			const name = item.name;

			if (item.state && item.state === 'destroyed') continue;
			if (item.count <= 0) continue;

			if (uniqueValues.has(name)) {
				counts[name] += (item.count || 1);
				continue;
			}
			else {
				ids[name] = item._id.toString();
				desc[name] = item.description;
			}

			uniqueValues.add(name);
			counts[name] = item.count || 1;
		}
		catch (error) {
			console.error(error);
		}
	}

	const options = [];
	if (allowNone) {
		options.push(
			new StringSelectMenuOptionBuilder()
				.setLabel('None')
				.setDescription('Unequips your current item.')
				.setValue('none'),
		);
	}
	// check if uniqueValues is empty
	if (uniqueValues.size !== 0) {
		for (const name of uniqueValues) {
			const count = counts[name];
			const value = ids[name];
			const description = desc[name];

			if (count <= 0) continue;
			options.push(
				new StringSelectMenuOptionBuilder()
					.setLabel(name)
					.setDescription(`x${count} | ${description}`)
					.setValue(value),
			);
		}
	}
	return options;
};

/**
 * Level gate for equipping bait (rods: held, see L6B): the player's current real level (getLevel) must reach the item's
 * requirements.level. Returns the refusal to send, or null when the item may be equipped.
 */
const checkItemRequirements = async (item, userData) => {
	const gate = await checkLevelGate(userData, item);
	return gate.ok ? null : gate;
};

/** Refuses an equip: closes the menu, then explains privately (the shop's ephemeral "Uh-oh!" style). */
const refuseEquip = async (selection, item, gate, analyticsObject) => {
	if (process.env.ANALYTICS || config.client.analytics) {
		await analyticsObject.setStatus('failed');
		await analyticsObject.setStatusMessage('User does not meet level requirements');
	}
	await selection.update({
		embeds: [
			new EmbedBuilder()
				.setTitle('Equipment')
				.setDescription('You do not meet the requirements to equip this item.'),
		],
		components: [],
	});
	return await selection.followUp({
		embeds: [
			new EmbedBuilder()
				.setTitle('Equipment')
				.setColor('Red')
				.addFields({ name: 'Uh-oh!', value: `You need to be level ${gate.required} to equip ${item.name}!`, inline: false }),
		],
		flags: MessageFlags.Ephemeral,
		components: [],
	});
};

module.exports = {
	structure: new SlashCommandBuilder()
		.setName('equip')
		.setDescription('Equip an item from your inventory!'),
	options: {
		cooldown: 10_000,
	},
	/**
     * @param {ExtendedClient} client
     * @param {ChatInputCommandInteraction} interaction
     */
	async run(client, interaction, analyticsObject, user = null) {
		if (user === null) user = interaction.user;

		// Buttons
		const cancel = new ButtonBuilder()
			.setCustomId('equip-cancel')
			.setLabel('Cancel')
			.setStyle(ButtonStyle.Secondary);

		const equipRod = new ButtonBuilder()
			.setCustomId('equip-rod')
			.setLabel('Fishing Rod')
			.setStyle(ButtonStyle.Primary);

		const equipBait = new ButtonBuilder()
			.setCustomId('equip-bait')
			.setLabel('Bait')
			.setStyle(ButtonStyle.Primary);

		const equipBooster = new ButtonBuilder()
			.setCustomId('equip-booster')
			.setLabel('Booster')
			.setStyle(ButtonStyle.Primary);

		const buttonRow = new ActionRowBuilder()
			.addComponents(cancel, equipRod, equipBait, equipBooster);

		const buttonResponse = await interaction.reply({
			embeds: [
				new EmbedBuilder()
					.setTitle('Equipment')
					.setDescription('Choose an item type to equip!'),
			],
			fetchReply: true,
			components: [buttonRow],
		});

		const collectorFilter = i => {
			return i.user.id === user.id;
		};

		try {
			const choice = await buttonResponse.awaitMessageComponent({ filter: collectorFilter, time: 90_000 });
			const userData = new User(await User.get(user.id));

			if (process.env.ANALYTICS || config.client.analytics) {
				await Interaction.generateCommandObject(choice, analyticsObject);
			}

			if (choice.customId === 'equip-rod') {
				let options = [];
				options = await Promise.all(await selectionOptions('rods', userData, true));
				options = options.filter((option) => option !== undefined);

				if (process.env.ANALYTICS || config.client.analytics) {
					await analyticsObject.setStatus('failed');
					await analyticsObject.setStatusMessage('No fishing rods found.');
				}

				if (options.length === 0) {
					return await choice.update({
						embeds: [
							new EmbedBuilder()
								.setTitle('Equipment')
								.setDescription('You do not have any fishing rods to equip!'),
						],
						components: [],
					});
				}

				const select = new StringSelectMenuBuilder()
					.setCustomId('select-rod')
					.setPlaceholder('Make a selection!')
					.addOptions(options);

				const row = new ActionRowBuilder()
					.addComponents(select);

				const response = await choice.update({
					embeds: [
						new EmbedBuilder()
							.setTitle('Equipment')
							.setDescription('Choose your fishing rod!'),
					],
					components: [row],
				});

				const selection = await response.awaitMessageComponent({ filter: collectorFilter, time: 90_000 });
				const rodChoice = selection.values[0];
				// Rod level enforcement is held (hotfix L6B) until the rod progression redesign ships:
				// only bait is level-gated here for now.

				const newRod = await userData.setEquippedRod(rodChoice);

				if (newRod === null) {
					if (process.env.ANALYTICS || config.client.analytics) {
						await analyticsObject.setStatus('completed');
						await analyticsObject.setStatusMessage('Unequipped fishing rod.');
					}
					return await selection.update({
						embeds: [
							new EmbedBuilder()
								.setTitle('Equipment')
								.setDescription('Unequipped fishing rod.'),
						],
						components: [],
					});
				}
				else {
					if (process.env.ANALYTICS || config.client.analytics) {
						await analyticsObject.setStatus('completed');
						await analyticsObject.setStatusMessage('Equipped fishing rod.');
					}
					await selection.update({
						components: [],
						embeds: [
							new EmbedBuilder()
								.setTitle('Equipment')
								.setDescription(`Equipped fishing rod: **${newRod.name}**`),
						],
					});
				}
			}
			else if (choice.customId === 'equip-bait') {
				let options = [];
				options = await Promise.all(await selectionOptions('baits', userData));
				options = options.filter((option) => option !== undefined);

				if (options.length === 1) {
					if (process.env.ANALYTICS || config.client.analytics) {
						await analyticsObject.setStatus('failed');
						await analyticsObject.setStatusMessage('No bait found.');
					}
					return await choice.update({
						embeds: [
							new EmbedBuilder()
								.setTitle('Equipment')
								.setDescription('You do not have any bait to equip!'),
						],
						components: [],
					});
				}

				const select = new StringSelectMenuBuilder()
					.setCustomId('select-bait')
					.setPlaceholder('Make a selection!')
					.addOptions(options);

				const row = new ActionRowBuilder()
					.addComponents(select);

				const response = await choice.update({
					embeds: [
						new EmbedBuilder()
							.setTitle('Equipment')
							.setDescription('Choose your bait!'),
					],
					components: [row],
				});

				const selection = await response.awaitMessageComponent({ filter: collectorFilter, time: 90_000 });
				const chosenBait = selection.values[0];

				if (process.env.ANALYTICS || config.client.analytics) {
					await Interaction.generateCommandObject(selection, analyticsObject);
				}

				const item = await ItemData.findById(chosenBait);
				const refusal = await checkItemRequirements(item, userData);
				if (refusal) return await refuseEquip(selection, item, refusal, analyticsObject);

				let newBait = {};
				let description = '';
				if (chosenBait === 'none') {
					newBait = await userData.setEquippedBait(null);
					description = 'Unequipped bait.';
				}
				else {
					newBait = await userData.setEquippedBait(chosenBait);
					description = `Equipped bait: **${newBait.name}**`;
				}

				if (process.env.ANALYTICS || config.client.analytics) {
					await analyticsObject.setStatus('completed');
					await analyticsObject.setStatusMessage('Equipped bait.');
				}

				await selection.update({
					embeds: [
						new EmbedBuilder()
							.setTitle('Equipment')
							.setDescription(description),
					],
					components: [],
				});
			}
			else if (choice.customId === 'equip-booster') {
				let options = [];
				options = await Promise.all(await selectionOptions('buffs', userData, false));
				options = options.filter((option) => option !== undefined);

				if (options.length === 0) {
					if (process.env.ANALYTICS || config.client.analytics) {
						await analyticsObject.setStatus('failed');
						await analyticsObject.setStatusMessage('No boosters found.');
					}
					return await choice.update({
						embeds: [
							new EmbedBuilder()
								.setTitle('Equipment')
								.setDescription('You do not have any boosters to equip!'),
						],
						components: [],
					});
				}

				const select = new StringSelectMenuBuilder()
					.setCustomId('select-booster')
					.setPlaceholder('Make a selection!')
					.addOptions(options);

				const row = new ActionRowBuilder()
					.addComponents(select);

				const response = await choice.update({
					embeds: [
						new EmbedBuilder()
							.setTitle('Equipment')
							.setDescription('Choose your booster!'),
					],
					components: [row],
				});

				const selection = await response.awaitMessageComponent({ filter: collectorFilter, time: 90_000 });
				const chosenBooster = selection.values[0];

				if (process.env.ANALYTICS || config.client.analytics) {
					await Interaction.generateCommandObject(selection, analyticsObject);
				}

				let newBooster = {};
				let description = '';
				newBooster = await userData.startBooster(chosenBooster);
				description = `Equipped booster: **${newBooster.name}**`;

				if (process.env.ANALYTICS || config.client.analytics) {
					await analyticsObject.setStatus('completed');
					await analyticsObject.setStatusMessage('Equipped booster.');
				}

				await selection.update({
					embeds: [
						new EmbedBuilder()
							.setTitle('Equipment')
							.setDescription(description),
					],
					components: [],
				});
			}
			else if (choice.customId === 'cancel') {
				if (process.env.ANALYTICS || config.client.analytics) {
					await analyticsObject.setStatus('completed');
					await analyticsObject.setStatusMessage('Cancelled equip.');
				}
				await choice.update({
					embeds: [
						new EmbedBuilder()
							.setTitle('Equipment')
							.setDescription('Equip has been cancelled.'),
					],
					components: [],
				});
			}
		}
		catch (e) {
			if (process.env.ANALYTICS || config.client.analytics) {
				await analyticsObject.setStatus('failed');
				await analyticsObject.setStatusMessage(e);
			}

			await interaction.editReply({
				embeds: [
					new EmbedBuilder()
						.setTitle('Timed Out')
						.setDescription('Response not received within 1 minute, cancelling.'),
				],
				components: [],
			});
		}
	},
};
