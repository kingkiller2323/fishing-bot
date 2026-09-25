/* eslint-disable no-mixed-spaces-and-tabs */
const { MessageFlags } = require('discord.js');
const config = require('../../config');
const { Utils } = require('../../class/Utils');
const { Interaction } = require('../../class/Interaction');

module.exports = {
	event: 'interactionCreate',
	/**
     *
     * @param {ExtendedClient} client
     * @param {import('discord.js').Interaction} interaction
     * @returns
     */
	run: async (client, interaction) => {
		if (interaction.isCommand()) return;
		const componentPermission = async (component) => {
			if (component.options?.public === false && interaction.user.id !== interaction.message.interaction.user.id) {
				await interaction.reply({
					content:
                        config.messageSettings.notHasPermissionComponent !== undefined &&
                        config.messageSettings.notHasPermissionComponent !== null &&
                        config.messageSettings.notHasPermissionComponent !== ''
                        	? config.messageSettings.notHasPermissionComponent
                        	: 'You do not have permission to use this component',
					flags: MessageFlags.Ephemeral,
				});
				return false;
			}

			return true;
		};

		// get most recent command ran by that user
		let analyticsObject;

		if (process.env.ANALYTICS || config.client.analytics) {
			analyticsObject = await Interaction.findMostRecentInteraction(interaction.user.id);
		}

		if (interaction.isButton()) {
			// If customId has a : it means it's passing a unique property
			const prop = interaction.customId.split(':').pop();
			const component = client.collection.components.buttons.get(interaction.customId.split(':')[0]);

			if (!component) return;

			if (!(await componentPermission(component))) return;

			try {
				if (process.env.ANALYTICS || config.client.analytics) {
					await Interaction.generateCommandObject(interaction, analyticsObject);
				}
				component.run(client, interaction, analyticsObject, prop);
			}
			catch (error) {
				Utils.log(error, 'error');
			}

			return;
		}

		if (interaction.isAnySelectMenu()) {
			const component = client.collection.components.selects.get(interaction.customId);

			if (!component) return;

			if (!(await componentPermission(component))) return;

			try {
				if (process.env.ANALYTICS || config.client.analytics) {
					await Interaction.generateCommandObject(interaction, analyticsObject);
				}
				component.run(client, interaction, analyticsObject);
			}
			catch (error) {
				Utils.log(error, 'error');
			}

			return;
		}

		if (interaction.isModalSubmit()) {
			const component = client.collection.components.modals.get(interaction.customId);

			if (!component) return;

			try {
				if (process.env.ANALYTICS || config.client.analytics) {
					await Interaction.generateCommandObject(interaction, analyticsObject);
				}
				component.run(client, interaction, analyticsObject);
			}
			catch (error) {
				Utils.log(error, 'error');
			}

			return;
		}

		if (interaction.isAutocomplete()) {
			const component = client.collection.components.autocomplete.get(interaction.commandName);

			if (!component) return;

			try {
				component.run(client, interaction);
			}
			catch (error) {
				Utils.log(error, 'error');
			}

			return;
		}
	},
};
