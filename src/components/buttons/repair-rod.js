const { ButtonStyle, ActionRowBuilder, ButtonBuilder, EmbedBuilder, MessageFlags } = require('discord.js');
const { RodData } = require('../../schemas/RodSchema');
const { User } = require('../../class/User');
const config = require('../../config');
const { Interaction } = require('../../class/Interaction');

module.exports = {
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
				if (await user.getMoney() < rod.repairCost) {
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

				const newDurability = rod.maxDurability;
				const newRepairs = rod.repairs + 1;
				const newRodState = 'repaired';

				try {
					await RodData.findByIdAndUpdate(rod._id, {
						durability: newDurability,
						repairs: newRepairs,
						state: newRodState,
					});
				}
				catch (error) {
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

				await user.addMoney(-rod.repairCost);

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