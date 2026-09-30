const { SlashCommandBuilder, EmbedBuilder, ButtonStyle, ActionRowBuilder, ButtonBuilder } = require('discord.js');
const { Item } = require('../../../schemas/ItemSchema');
const buttonPagination = require('../../../buttonPagination');

module.exports = {
	structure: new SlashCommandBuilder()
		.setName('shop')
		.setDescription('Check the shop!'),
	options: {
		cooldown: 10_000,
	},
	/**
     * @param {ExtendedClient} client
     * @param {ChatInputCommandInteraction} interaction
     */
	run: async (client, interaction, analyticsObject) => {
		// The 5B shop: tabs, the Rod Workshop, private replies (src/class/Shop5b.js).
		if (require('../../../engine/balance').isBalance5b()) return require('../../../class/Shop5b').openShop(interaction);
		try {
			const embeds = [];
			const shopItems = await Item.find({ shopItem: true });

			// sort the shopItems by item.type and item.price
			const order = ['rod', 'bait', 'gacha', 'license', 'other', 'boost', 'item'];
			shopItems.sort((a, b) => {
				if (a.type === b.type) {
					return a.price - b.price;
				}
				return order.indexOf(a.type) - order.indexOf(b.type);
			});

			let fields = [];
			fields = shopItems.map((item) => ({
				name: item.name,
				value: `${item.description}\n**Price:** $${item.price.toLocaleString()}`,
				inline: false,
			}));

			const chunkSize = 6;

			for (let i = 0; i < fields.length; i += chunkSize) {
				const chunk = fields.slice(i, i + chunkSize);

				embeds.push(new EmbedBuilder()
					.setFooter({ text: `Page ${Math.floor(i / chunkSize) + 1} / ${Math.ceil(fields.length / chunkSize)} ` })
					.setTitle('Shop')
					.setColor('Green')
					.addFields(chunk),
				);
			}

			const buyRod = new ButtonBuilder()
				.setCustomId('buy-rod')
				.setLabel('Fishing Rod')
				.setStyle(ButtonStyle.Primary);

			const buyBait = new ButtonBuilder()
				.setCustomId('buy-bait')
				.setLabel('Bait')
				.setStyle(ButtonStyle.Primary);

			const buyOther = new ButtonBuilder()
				.setCustomId('buy-other')
				.setLabel('Other')
				.setStyle(ButtonStyle.Primary);

			const buttonRow = new ActionRowBuilder()
				.addComponents(buyRod, buyBait, buyOther);

			await buttonPagination(interaction, embeds, analyticsObject, false, [buttonRow]);
		}
		catch (err) {
			console.error(err);
		}
	},
};
