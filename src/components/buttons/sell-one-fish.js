const { User } = require('../../class/User');
const { FishData } = require('../../schemas/FishSchema');
const { BuffData } = require('../../schemas/BuffSchema');
const { ButtonBuilder, EmbedBuilder, MessageFlags } = require('discord.js');
const config = require('../../config');
const { partitionProtected } = require('../../engine/protection');
const { withUserLock } = require('../../engine/userLock');
const { recordSale } = require('../../engine/sales');

module.exports = {
	customId: 'sell-one-fish',
	/**
	 *
	 * @param {ExtendedClient} client
	 * @param {ButtonInteraction} interaction
	 */
	run: async (client, interaction, analyticsObject, prop) => {
		return withUserLock(interaction.user.id, async () => {
			// New buttons carry the cast id; messages from before Foundation V2 carry a numeric catchId.
			const catchKey = String(prop);
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

			const catchFish = (await userData.getFish()).filter(fish => fish.castId === catchKey || (catchKey !== '0' && fish.catchId != null && String(fish.catchId) === catchKey));
			const { allowed: fishArray, protected: lockedFish } = partitionProtected(catchFish);

			if (fishArray.length === 0 && lockedFish.length > 0) {
				await interaction.reply({
					content: '🔒 These fish are locked. Unlock them with `/unlock` if you really want to sell them.',
					flags: MessageFlags.Ephemeral,
				});
				return;
			}
			// let newFish = (await userData.getInventory()).fish;

			if (fishArray.length === 0) {
				if (process.env.ANALYTICS || config.client.analytics) {
					await analyticsObject.setStatus('failed');
					await analyticsObject.setStatusMessage('User tried to sell fish that no longer exist!');
				}
				await interaction.reply({
					content: 'This catch has already been sold!',
					flags: MessageFlags.Ephemeral,
				});
				return;
			}

			// check for buffs
			const activeBuffs = await BuffData.find({ user: await userData.getUserId(), active: true });
			const cashBuff = activeBuffs.find((buff) => buff.capabilities.includes('cash'));
			const cashMultiplier = cashBuff ? parseFloat(cashBuff?.capabilities[1]) : 1;

			// `total` is paid; `publicTotal` (base values, no profile bonus) is what the message shows.
			let total = 0;
			let publicTotal = 0;
			for (const fish of fishArray) {
				const fishData = await FishData.findById(fish.valueOf());
				const value = fishData.value * cashMultiplier * fishData.count;
				total += value;
				publicTotal += (fishData.valueBase ?? fishData.value) * cashMultiplier * fishData.count;
				// newFish.push(...userData.inventory.fish.filter(x => x._id.valueOf() !== fishData._id.valueOf()));
				await userData.removeFish(fishData._id, fishData.count);
				await userData.addMoney(value);
			}

			//stats.soldLatestFish = true;
			//await userData.setStats(stats);

			if (process.env.ANALYTICS || config.client.analytics) {
				await analyticsObject.setStatus('completed');
				await analyticsObject.setStatusMessage('User sold catch with id: ' + catchKey);
			}
		
			// disable the sell button
			await recordSale(interaction.user.id, publicTotal, total);

			const components = interaction.message.components;
			const keptNote = lockedFish.length > 0 ? `\n🔒 ${lockedFish.length} locked fish kept.` : '';
			const embeds = [
				EmbedBuilder.from(interaction.message.embeds[0])
					.addFields({ name: '💰 Sold', value: `You sold this catch for $${Math.round(publicTotal).toLocaleString('en-US')}.${keptNote}` }),
				...interaction.message.embeds.slice(1),
			];
			components[0].components[1] = ButtonBuilder.from(components[0].components[1])
			components[0].components[1].setDisabled(true);

			return await interaction.update({
				embeds: embeds,
				components: components,
			});
		});
	},
};
