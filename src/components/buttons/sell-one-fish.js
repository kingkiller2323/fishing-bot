const { User } = require('../../class/User');
const { FishData } = require('../../schemas/FishSchema');
const { BuffData } = require('../../schemas/BuffSchema');
const { ButtonComponent, ButtonBuilder } = require('discord.js');
const config = require('../../config');

module.exports = {
	customId: 'sell-one-fish',
	/**
	 *
	 * @param {ExtendedClient} client
	 * @param {ButtonInteraction} interaction
	 */
	run: async (client, interaction, analyticsObject, prop) => {
		const catchId = prop;
		const userData = new User(await User.get(interaction.user.id));
		if (!userData) return;

		const stats = await userData.getStats();

		// if (stats.soldLatestFish) {
		// 	if (process.env.ANALYTICS || config.client.analytics) {
		// 		await analyticsObject.setStatus('failed');
		// 		await analyticsObject.setStatusMessage('User already sold these fish!');
		// 	}
		// 	await interaction.reply({
		// 		content: 'You already sold these fish!',
		// 		ephemeral: true,
		// 	});
		// 	return;
		// }

		const fishArray = (await userData.getFish()).filter(fish => fish.catchId == catchId);
		// let newFish = (await userData.getInventory()).fish;

		if (fishArray.length === 0) {
			if (process.env.ANALYTICS || config.client.analytics) {
				await analyticsObject.setStatus('failed');
				await analyticsObject.setStatusMessage('User tried to sell fish that no longer exist!');
			}
			await interaction.reply({
				content: 'This catch has already been sold!',
				ephemeral: true,
			});
			return;
		}

		// check for buffs
		const activeBuffs = await BuffData.find({ user: await userData.getUserId(), active: true });
		const cashBuff = activeBuffs.find((buff) => buff.capabilities.includes('cash'));
		const cashMultiplier = cashBuff ? parseFloat(cashBuff?.capabilities[1]) : 1;

		let total = 0;
		for (const fish of fishArray) {
			const fishData = await FishData.findById(fish.valueOf());
			const value = fishData.value * cashMultiplier * fishData.count;
			total += value;
			// newFish.push(...userData.inventory.fish.filter(x => x._id.valueOf() !== fishData._id.valueOf()));
			await userData.removeFish(fishData._id, fishData.count);
			await userData.addMoney(value);
		}

		//stats.soldLatestFish = true;
		//await userData.setStats(stats);

		if (process.env.ANALYTICS || config.client.analytics) {
			await analyticsObject.setStatus('completed');
			await analyticsObject.setStatusMessage('User sold catch with id: ' + catchId);
		}
		
		// disable the sell button
		const embeds = interaction.message.embeds
		const components = interaction.message.components

		embeds[0].fields.push({ name: 'Sold Fish', value: `You sold this catch for a total of $${total.toLocaleString()}!` });
		components[0].components[1] = ButtonBuilder.from(components[0].components[1])
		components[0].components[1].setDisabled(true);

		return await interaction.update({
			embeds: embeds,
			components: components,
		});
	},
};
