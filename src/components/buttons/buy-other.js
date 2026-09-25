const { ActionRowBuilder, StringSelectMenuBuilder, ComponentType, ButtonBuilder, ButtonStyle, EmbedBuilder, Colors, MessageFlags } = require('discord.js');
const { Utils } = require('../../class/Utils');
const { Item, ItemData } = require('../../schemas/ItemSchema');
const { User } = require('../../class/User');
const config = require('../../config');
const { Interaction } = require('../../class/Interaction');

module.exports = {
	customId: 'buy-other',
	run: async (client, interaction, analyticsObject) => {
		const user = interaction.user;

		try {
			const options = await getSelectionOptions();

			if (options.length === 0) {
				return await interaction.reply({
					content: 'There is nothing for you to buy!',
					flags: MessageFlags.Ephemeral,
					components: [],
				});
			}

			const select = await createSelectMenu(options);
			const row = await createActionRow(select);

			const components = await removeAdditionalActionRows(2, interaction.message.components);

			const response = await updateInteraction(interaction, row, components);

			await getSelection(response, user.id, analyticsObject);
		}
		catch (err) {
			// console.error(err);
			// if (process.env.ANALYTICS || config.client.analytics) {
			// 	await analyticsObject.setStatus('failed');
			// 	await analyticsObject.setStatusMessage(err);
			// }
		}
	},
};

const getSelectionOptions = async () => {
	let options = await Promise.all([
		...(await Utils.selectionOptions('item')),
		...(await Utils.selectionOptions('gacha')),
		...(await Utils.selectionOptions('buff')),
		...(await Utils.selectionOptions('license')),
	]);
	options = options.filter((option) => option !== undefined);
	return options;
};

const createSelectMenu = async (options) => {
	return new StringSelectMenuBuilder()
		.setCustomId('select-item')
		.setPlaceholder('Make a selection!')
		.addOptions(options);
};

const createActionRow = async (select) => {
	return new ActionRowBuilder().addComponents(select);
};

const removeAdditionalActionRows = (num, components) => {
	const savedRows = [];
	for (let i = 0; i < num; i++) {
		const row = components.find((r) => r.type === ComponentType.ActionRow);
		savedRows.push(row);
		components.splice(components.indexOf(row), 1);
	}

	components.length = 0;

	for (let i = 0; i < savedRows.length; i++) {
		components.push(savedRows[i]);
	}

	return components;
};

const updateInteraction = async (interaction, row, components) => {
	return await interaction.update({
		embeds: interaction.message.embeds,
		components: [...components, row],
	});
};

const getSelection = async (response, userId, analyticsObject) => {
	const collector = response.createMessageComponentCollector({ filter: Utils.getCollectionFilter(['select-item'], userId), time: 90_000 });

	collector.on('collect', async i => {
		if (process.env.ANALYTICS || config.client.analytics) {
			await Interaction.generateCommandObject(i, analyticsObject);
		}
		const userData = new User(await User.get(userId));
		return await processItemSelection(i, userData, analyticsObject);
	});
};

const processItemSelection = async (selection, userData, analyticsObject) => {
	const itemChoice = selection.values[0];
	const originalItem = await getItemById(itemChoice);

	const canBuy = await checkItemRequirements(originalItem, userData);

	if (await userData.getMoney() < originalItem.price && canBuy) {
		if (process.env.ANALYTICS || config.client.analytics) {
			await analyticsObject.setStatus('failed');
			await analyticsObject.setStatusMessage('User does not have enough money to buy item');
		}

		let embeds = [];
		embeds.push(new EmbedBuilder()
			.setTitle('Shop')
			.setColor('Red')
			.addFields(
				{ name: 'Uh-oh!', value: 'You do not have enough money to buy that item', inline: false },
				{ name: 'Price', value: `$${(originalItem.price).toLocaleString()}`, inline: true },
				{ name: 'Balance', value: `$${(await userData.getMoney()).toLocaleString()}`, inline: true },
			),
		);
		
		return await selection.reply({
			embeds: embeds,
			flags: MessageFlags.Ephemeral,
			components: [],
		});
	}
	else if (canBuy) {
		let amount = 1;
		if (originalItem.type === 'gacha') {
			const amountRow = createAmountActionRow();
			const components = removeAdditionalActionRows(3, selection.message.components);

			const amountResponse = await selection.update({
				embeds: selection.message.embeds,
				components: [...components, amountRow],
			});

			const amountCollector = await amountResponse.createMessageComponentCollector({ filter: Utils.getCollectionFilter(['buy-one', 'buy-five', 'buy-ten', 'buy-hundred'], await userData.getUserId()), time: 90_000 });
			amountCollector.on('collect', async i => {
				if (process.env.ANALYTICS || config.client.analytics) {
					await Interaction.generateCommandObject(i, analyticsObject);
				}
				const amountChoice = i.customId;
				amount = await getAmountFromChoice(amountChoice);
				if (await userData.getMoney() >= originalItem.price * amount) {
					await buyItem(i, originalItem, userData, amount);
				}
				else {
					if (process.env.ANALYTICS || config.client.analytics) {
						await analyticsObject.setStatus('failed');
						await analyticsObject.setStatusMessage('User does not have enough money to buy items');
					}

					let embeds = [];
					embeds.push(new EmbedBuilder()
						.setTitle('Shop')
						.setColor('Red')
						.addFields(
							{ name: 'Uh-oh!', value: 'You do not have enough money to buy that amount', inline: false },
							{ name: 'Price', value: `$${(originalItem.price * amount).toLocaleString()}`, inline: true },
							{ name: 'Balance', value: `$${(await userData.getMoney()).toLocaleString()}`, inline: true },
						),
					);

					await i.reply({
						embeds: embeds,
						flags: MessageFlags.Ephemeral,
						components: [],
					});
				}
			});
		}
		else {
			await buyItem(selection, originalItem, userData, amount);
		}

		if (process.env.ANALYTICS || config.client.analytics) {
			await analyticsObject.setStatus('completed');
			await analyticsObject.setStatusMessage('User has successfully bought item');
		}
	}
	else {
		let content = 'You do not meet the requirements to buy this item!\n';
		if (originalItem.toJSON().requirements.level) {
			content += `- You need to be at least level ${originalItem.toJSON().requirements.level || 0}.\n`;
		}
		if (originalItem.prerequisites) {
			content += `- You need to have the following item(s): ${originalItem.prerequisites.join(', ')}.\n`;
		}
		if (process.env.ANALYTICS || config.client.analytics) {
			await analyticsObject.setStatus('failed');
			await analyticsObject.setStatusMessage(content);
		}

		// remove gacha amount action row
		let components = selection.message.components;
		if (originalItem.type !== 'gacha') {
			components = removeAdditionalActionRows(3, selection.message.components);
		}

		await selection.update({
			components: components,
		})

		let embeds = [];
		embeds.push(new EmbedBuilder()
			.setTitle('Shop')
			.setColor('Red')
			.addFields({ name: 'Requirements', value: content, inline: false }),
		);

		await selection.followUp({
			embeds: embeds,
			flags: MessageFlags.Ephemeral,
			components: [],
		});
	}
};

const getItemById = async (itemId) => {
	return await Item.findById(itemId);
};

const checkItemRequirements = async (item, userData) => {
	item = item.toJSON();
	const userLevel = await userData.getLevel();
	const meetsLevelRequirement = userLevel >= (item.requirements?.level || 0);

	const items = await Promise.all((await userData.getItems()).map(async (i) => await ItemData.findById(i)));
	const meetsPrerequisites = item.prerequisites ? item.prerequisites.every((prereq) => items.some((i) => i.name === prereq)) : true;
	return meetsLevelRequirement && meetsPrerequisites;
};

const createAmountActionRow = () => {
	const amount1 = new ButtonBuilder().setCustomId('buy-one').setLabel('Buy 1').setStyle(ButtonStyle.Primary);
	const amount5 = new ButtonBuilder().setCustomId('buy-five').setLabel('Buy 5').setStyle(ButtonStyle.Primary);
	const amount10 = new ButtonBuilder().setCustomId('buy-ten').setLabel('Buy 10').setStyle(ButtonStyle.Primary);
	const amount100 = new ButtonBuilder().setCustomId('buy-hundred').setLabel('Buy 100').setStyle(ButtonStyle.Primary);
	return new ActionRowBuilder().addComponents(amount1, amount5, amount10, amount100);
};

const getAmountFromChoice = async (amountChoice) => {
	if (amountChoice === 'buy-one') {
		return 1;
	}
	else if (amountChoice === 'buy-five') {
		return 5;
	}
	else if (amountChoice === 'buy-ten') {
		return 10;
	}
	else if (amountChoice === 'buy-hundred') {
		return 100;
	}
};

const buyItem = async (i, originalItem, userData, amount) => {
	await userData.addMoney(-originalItem.price * amount);
	await userData.sendToInventory(originalItem, amount);

	let embeds = [];
	embeds.push(new EmbedBuilder()
		.setTitle('Shop')
		.setColor('Green')
		.addFields(
			{ name: 'Congrats!', value: `You have successfully bought ${amount} ${originalItem.name}`, inline: false },
			{ name: 'New Balance', value: `$${(await userData.getMoney()).toLocaleString()}`, inline: true },
		),
	);
	return await i.reply({
		components: [],
		embeds: embeds,
		flags: MessageFlags.Ephemeral,
	});
};
