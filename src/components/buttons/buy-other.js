const { ActionRowBuilder, StringSelectMenuBuilder, ComponentType, ButtonBuilder, ButtonStyle, EmbedBuilder, Colors, MessageFlags } = require('discord.js');
const { Utils } = require('../../class/Utils');
const { Item, ItemData } = require('../../schemas/ItemSchema');
const { User } = require('../../class/User');
const config = require('../../config');
const { Interaction } = require('../../class/Interaction');
const { purchase, replaceCollector } = require('../../engine/purchase');
const { User: UserSchemaModel } = require('../../schemas/UserSchema');
const { ownedLicenseTiers, licenseOffered } = require('../../engine/aquariumRules');

module.exports = {
	customId: 'buy-other',
	run: async (client, interaction, analyticsObject) => {
		const user = interaction.user;

		try {
			const options = await getSelectionOptions(user.id);

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

			await getSelection(response, user.id, analyticsObject, interaction.message.id);
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

/** The player's owned license tiers per water type (A7). */
const licenseTiersOf = async (userId) => {
	const doc = await UserSchemaModel.findOne({ userId: String(userId) }).select('inventory.items').lean();
	return ownedLicenseTiers(doc?.inventory?.items || []);
};

const getSelectionOptions = async (userId) => {
	// A7: a license is offered only above the tier the player already owns for its water type.
	const tiers = await licenseTiersOf(userId);
	const licenseOptions = (await Promise.all(await Utils.selectionOptions('license'))).filter(Boolean);
	const offered = [];
	for (const option of licenseOptions) {
		if (licenseOffered(await Item.findById(option.data.value).lean(), tiers)) offered.push(option);
	}
	let options = await Promise.all([
		...(await Utils.selectionOptions('item')),
		...(await Utils.selectionOptions('gacha')),
		...(await Utils.selectionOptions('buff')),
	]);
	options = [...options.filter((option) => option !== undefined), ...offered];
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

const getSelection = async (response, userId, analyticsObject, messageId) => {
	const collector = response.createMessageComponentCollector({ filter: Utils.getCollectionFilter(['select-item'], userId), time: 90_000 });
	replaceCollector('buy-other:select', messageId, userId, collector);

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
		const amount = 1;
		if (originalItem.type === 'gacha') {
			const amountRow = createAmountActionRow();
			const components = removeAdditionalActionRows(3, selection.message.components);

			const amountResponse = await selection.update({
				embeds: selection.message.embeds,
				components: [...components, amountRow],
			});

			const userId = await userData.getUserId();
			const amountCollector = await amountResponse.createMessageComponentCollector({ filter: Utils.getCollectionFilter(['buy-one', 'buy-five', 'buy-ten', 'buy-hundred'], userId), time: 90_000 });
			replaceCollector('buy-other:amount', selection.message.id, userId, amountCollector);
			amountCollector.on('collect', async i => {
				if (process.env.ANALYTICS || config.client.analytics) {
					await Interaction.generateCommandObject(i, analyticsObject);
				}
				const amountChoice = i.customId;
				const chosenAmount = await getAmountFromChoice(amountChoice);
				// The balance check is the guarded debit at click time, never the snapshot from the select.
				const result = await buyItem(i, originalItem, userId, chosenAmount);
				if (!result.ok) {
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
							{ name: 'Price', value: `$${(originalItem.price * chosenAmount).toLocaleString()}`, inline: true },
							{ name: 'Balance', value: `$${(result.balance).toLocaleString()}`, inline: true },
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
			const result = await buyItem(selection, originalItem, await userData.getUserId(), amount);
			if (!result.ok) {
				if (process.env.ANALYTICS || config.client.analytics) {
					await analyticsObject.setStatus('failed');
					await analyticsObject.setStatusMessage('User does not have enough money to buy item');
				}
				return await selection.reply({
					embeds: [new EmbedBuilder()
						.setTitle('Shop')
						.setColor('Red')
						.addFields(
							{ name: 'Uh-oh!', value: 'You do not have enough money to buy that item', inline: false },
							{ name: 'Price', value: `$${(originalItem.price).toLocaleString()}`, inline: true },
							{ name: 'Balance', value: `$${(result.balance).toLocaleString()}`, inline: true },
						)],
					flags: MessageFlags.Ephemeral,
					components: [],
				});
			}
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
	const userLevel = await userData.getGateLevel();
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

/** Pays and grants in one locked step; on success replies with the new balance. Returns the purchase result. */
const buyItem = async (i, originalItem, userId, amount) => {
	let result;
	try {
		result = await purchase(userId, originalItem.price * amount, async (fresh) => {
			// A7: re-checked under the player's lock (a menu opened before an earlier purchase is stale).
			if (originalItem.type === 'license' && !licenseOffered(originalItem, await licenseTiersOf(userId))) {
				throw Object.assign(new Error('license already owned'), { code: 'LICENSE_OWNED' });
			}
			return fresh.sendToInventory(originalItem, amount);
		});
	}
	catch (error) {
		if (error?.code !== 'LICENSE_OWNED') throw error;
		await i.reply({ content: 'You already own this license or a higher tier for that water type. You have not been charged.', flags: MessageFlags.Ephemeral, components: [] });
		return { ok: true, refused: true };
	}
	if (!result.ok) return result;

	let embeds = [];
	embeds.push(new EmbedBuilder()
		.setTitle('Shop')
		.setColor('Green')
		.addFields(
			{ name: 'Congrats!', value: `You have successfully bought ${amount} ${originalItem.name}`, inline: false },
			{ name: 'New Balance', value: `$${(result.balance).toLocaleString()}`, inline: true },
		),
	);
	await i.reply({
		components: [],
		embeds: embeds,
		flags: MessageFlags.Ephemeral,
	});
	return result;
};
