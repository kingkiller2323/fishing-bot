const { ActionRowBuilder, StringSelectMenuBuilder, ComponentType, EmbedBuilder, MessageFlags } = require('discord.js');
const { Utils } = require('../../class/Utils');
const { Item } = require('../../schemas/ItemSchema');
const { User } = require('../../class/User');
const config = require('../../config');
const { Interaction } = require('../../class/Interaction');
const { purchase, replaceCollector } = require('../../engine/purchase');

module.exports = {
	customId: 'buy-rod',
	run: async (client, interaction, analyticsObject) => {
		const user = interaction.user;

		try {
			const options = await getRodOptions();

			if (options.length === 0) {
				return await interaction.reply({
					content: 'There is no fishing rod for you to buy!',
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
		}
	},
};

const getRodOptions = async () => {
	let options = await Promise.all(await Utils.selectionOptions('rod'));
	options = options.filter((option) => option !== undefined);
	return options;
};

const createSelectMenu = async (options) => {
	return new StringSelectMenuBuilder()
		.setCustomId('select-rod')
		.setPlaceholder('Select a fishing rod to buy...')
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
	const collector = response.createMessageComponentCollector({ filter: Utils.getCollectionFilter(['select-rod'], userId), time: 90_000 });
	replaceCollector('buy-rod:select', messageId, userId, collector);

	collector.on('collect', async i => {
		if (process.env.ANALYTICS || config.client.analytics) {
			await Interaction.generateCommandObject(i, analyticsObject);
		}
		const userData = new User(await User.get(userId));
		return await processRodSelection(i, userData, analyticsObject);
	});
};

const processRodSelection = async (selection, userData, analyticsObject) => {
	const rodChoice = selection.values[0];
	const originalItem = await getItemById(rodChoice);

	const canBuy = await checkItemRequirements(originalItem, userData);

	if (await userData.getMoney() < originalItem.price && canBuy) {
		if (process.env.ANALYTICS || config.client.analytics) {
			await analyticsObject.setStatus('failed');
			await analyticsObject.setStatusMessage('User does not have enough money to buy this item!');
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
		const result = await buyItem(originalItem, await userData.getUserId());
		if (!result.ok) {
			if (process.env.ANALYTICS || config.client.analytics) {
				await analyticsObject.setStatus('failed');
				await analyticsObject.setStatusMessage('User does not have enough money to buy this item!');
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
		if (process.env.ANALYTICS || config.client.analytics) {
			await analyticsObject.setStatus('completed');
			await analyticsObject.setStatusMessage('User has successfully bought a fishing rod!');
		}
		let embeds = [];
		embeds.push(new EmbedBuilder()
			.setTitle('Shop')
			.setColor('Green')
			.addFields(
				{ name: 'Congrats!', value: `You have successfully bought ${originalItem.name}`, inline: false },
				{ name: 'New Balance', value: `$${(result.balance).toLocaleString()}`, inline: true },
			),
		);
		return await selection.reply({
			components: [],
			embeds: embeds,
			flags: MessageFlags.Ephemeral,
		});
	}
	else {
		if (process.env.ANALYTICS || config.client.analytics) {
			await analyticsObject.setStatus('failed');
			await analyticsObject.setStatusMessage('User does not meet level requirements');
		}

		let embeds = [];
		embeds.push(new EmbedBuilder()
			.setTitle('Shop')
			.setColor('Red')
			.addFields(
				{ name: 'Uh-oh!', value: `You need to be level ${(originalItem.toJSON()).requirements.level} to buy this item!`, inline: false },
			),
		);

		await selection.reply({
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
	const userLevel = await userData.getLevel();
	return userLevel >= item.toJSON().requirements.level;
};

/** Pays and grants in one locked step (see engine/purchase). Resolves { ok, balance }. */
const buyItem = async (item, userId) => {
	return purchase(userId, item.price, (userData) => userData.sendToInventory(item));
};
