const { ButtonStyle, ActionRowBuilder, ButtonBuilder, EmbedBuilder, MessageFlags } = require('discord.js');
const mongoose = require('mongoose');
const { ItemData } = require('../../schemas/ItemSchema');
const { User } = require('../../class/User');
const config = require('../../config');
const { Interaction } = require('../../class/Interaction');
const { purchase } = require('../../engine/purchase');

/**
 * C1: repairs the rod through the base ItemData model. A crafted rod is a CustomRodData document, so the
 * old RodData.findByIdAndUpdate matched nothing (the discriminator filter) and the player paid for no
 * repair. Guarded: it applies only while the rod is still broken (a second confirm, or a rod repaired in
 * the meantime, matches nothing); `repairs` is incremented atomically. Throws NOT_REPAIRABLE when nothing
 * matched, so purchase() refunds the debit. Today's rules: a broken rod goes back to its maxDurability.
 */
async function repairRod(rod) {
	// Raw collection write (as the cast engine does): the base ItemData schema has no state/durability/
	// repairs paths, so a model update would silently strip them.
	const res = await ItemData.collection.updateOne(
		{ _id: new mongoose.Types.ObjectId(String(rod._id)), state: 'broken' },
		{ $set: { durability: rod.maxDurability, state: 'repaired', updatedAt: new Date() }, $inc: { repairs: 1 } },
	);
	if (res.matchedCount !== 1) throw Object.assign(new Error('The rod is no longer broken; nothing was repaired.'), { code: 'NOT_REPAIRABLE' });
}

module.exports = {
	repairRod,
	customId: 'repair-rod',
	/**
	 *
	 * @param {ExtendedClient} client
	 * @param {ButtonInteraction} interaction
	 */
	run: async (client, interaction, analyticsObject) => {
		const user = new User(await User.get(interaction.user.id));
		const rod = await user.getEquippedRod();
		if (!rod) {
			if (process.env.ANALYTICS || config.client.analytics) {
				await analyticsObject.setStatus('failed');
				await analyticsObject.setStatusMessage('User does not have a rod equipped!');
			}
			await interaction.reply({
				content: 'You do not have a rod equipped!',
				flags: MessageFlags.Ephemeral,
			});
			return;
		}

		if (rod.state !== 'broken') {
			if (process.env.ANALYTICS || config.client.analytics) {
				await analyticsObject.setStatus('failed');
				await analyticsObject.setStatusMessage('Rod is not broken!');
			}
			await interaction.reply({
				content: 'Your rod can\'t be repaired!',
				flags: MessageFlags.Ephemeral,
			});
			return;
		}

		const confirm = new ButtonBuilder()
			.setCustomId('confirm')
			.setLabel('Confirm Repair')
			.setStyle(ButtonStyle.Success);

		const cancel = new ButtonBuilder()
			.setCustomId('cancel')
			.setLabel('Cancel')
			.setStyle(ButtonStyle.Secondary);

		const row = new ActionRowBuilder()
			.addComponents(cancel, confirm);

		const response = await interaction.reply({
			// content: `Are you sure you want to repair your rod? This will cost $${rod.repairCost}!`,
			embeds: [
				new EmbedBuilder()
					.setTitle('Warning')
					.addFields(
						{ name: 'Are you sure?', value: `This will cost $${rod.repairCost.toLocaleString()}!` },
					),
			],
			fetchReply: true,
			components: [row],
		});

		const collectorFilter = i => {
			return i.user.id === interaction.user.id;
		};

		try {
			const confirmation = await response.awaitMessageComponent({ filter: collectorFilter, time: 90_000 });
			
			if (process.env.ANALYTICS || config.client.analytics) {
				await Interaction.generateCommandObject(confirmation, analyticsObject);
			}

			if (confirmation.customId === 'confirm') {
				// Guarded atomic debit at confirm time (not the balance loaded when the prompt opened);
				// the repair only happens if the debit did, and a repair that does not apply is refunded.
				let result;
				try {
					result = await purchase(interaction.user.id, rod.repairCost, () => repairRod(rod));
				}
				catch (error) {
					if (error?.code === 'NOT_REPAIRABLE') {
						await confirmation.update({
							embeds: [
								new EmbedBuilder()
									.setTitle('Nothing to Repair')
									.setDescription('Your rod is no longer broken, so it was not repaired. You have not been charged.'),
							],
							components: [],
						});
						return;
					}
					if (process.env.ANALYTICS || config.client.analytics) {
						await analyticsObject.setStatus('failed');
						await analyticsObject.setStatusMessage(error);
					}
					console.error(error);
					await confirmation.update({
						embeds: [
							new EmbedBuilder()
								.setTitle('Error')
								.setDescription('An error occurred while repairing your rod. You have not been charged.'),
						],
						components: [],
					});
					return;
				}

				if (!result.ok) {
					if (process.env.ANALYTICS || config.client.analytics) {
						await analyticsObject.setStatus('failed');
						await analyticsObject.setStatusMessage('User does not have enough money to repair rod!');
					}
					await confirmation.update({
						// content: 'You do not have enough money to repair your rod!',
						embeds: [
							new EmbedBuilder()
								.setTitle('Insufficient Balance')
								.setDescription('You do not have enough money to repair your rod!'),
						],
						components: [] });
					return;
				}

				if (process.env.ANALYTICS || config.client.analytics) {
					await analyticsObject.setStatus('completed');
					await analyticsObject.setStatusMessage('Rod has been repaired!');
				}

				await confirmation.update({
					components: [],
					embeds: [
						new EmbedBuilder()
							.setTitle('Congratulations!')
							.setDescription(`Repaired **${rod.name}** for **$${rod.repairCost.toLocaleString()}**!`),
					],
				});
			}
			else if (confirmation.customId === 'cancel') {
				if (process.env.ANALYTICS || config.client.analytics) {
					await analyticsObject.setStatus('completed');
					await analyticsObject.setStatusMessage('Repair has been cancelled.');
				}
				await confirmation.update({
					embeds: [
						new EmbedBuilder()
							.setTitle('Cancelled')
							.setDescription('Repair has been cancelled.'),
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
						.setDescription('Confirmation not received within 1 minute, cancelling.'),
				],
				components: [],
			});
		}

	},
};