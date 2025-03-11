'use strict';
import { Collection, Events, MessageFlags } from 'discord.js';
import { beaver } from '../functions/consoleLogging.js';
import { cooldownErrorLocalizations, errorMessageLocalizations } from '../localizations/interactionCreate.js';

export const name = Events.InteractionCreate;
export const once = false;

export async function execute(interaction) {
	if (!interaction.isChatInputCommand()) return;

	const command = interaction.client.commands.get(interaction.commandName);

	if (!command) return;

	// Defer the reply to the interaction
	try {
		await interaction.deferReply({ flags: MessageFlags.Ephemeral });
		if (!interaction.deferred) throw new Error('Interaction was not deferred');
	} catch (error) {
		const commandOptions = getCommandOptions(interaction);

		beaver.log(
			'interaction-create',
			'Error deferring reply to command',
			JSON.stringify({
				'Guild ID': interaction.guildId,
				'Command Name': interaction.commandName,
				'Command Options': commandOptions || 'None'
			}),
			error
		);

		return;
	}

	// Check to see if the user is on cooldown
	const { cooldowns } = interaction.client;

	if (!cooldowns.has(command.data.name)) {
		cooldowns.set(command.data.name, new Collection());
	}

	const now = Date.now();
	const timestamps = cooldowns.get(command.data.name);
	const cooldownAmount = 3 * 1000; // 3 seconds cooldown

	if (timestamps.has(interaction.user.id)) {
		const expirationTime = timestamps.get(interaction.user.id) + cooldownAmount;

		if (now < expirationTime) {
			const expiredTimestamp = Math.round(expirationTime / 1000);

			const localizedError = cooldownErrorLocalizations[interaction.locale];

			if (localizedError) {
				await interaction.editReply({
					content: `${localizedError[1]} ${expiredTimestamp} ${localizedError[2]}`,
					flags: MessageFlags.Ephemeral
				});
			} else {
				await interaction.editReply({
					content: `Please wait. You are on a cooldown for ${expiredTimestamp} seconds.`,
					flags: MessageFlags.Ephemeral
				});
			}

			return;
		}
	}

	timestamps.set(interaction.user.id, now);
	setTimeout(() => timestamps.delete(interaction.user.id), cooldownAmount);

	// Now execute the command
	try {
		await command.execute(interaction);
	} catch (error) {
		const commandOptions = getCommandOptions(interaction);

		beaver.log(
			'interaction-create',
			'Error executing command',
			JSON.stringify({
				'Guild ID': interaction.guildId,
				'Command Name': interaction.commandName,
				'Command Options': commandOptions || 'None'
			}),
			error
		);

		await interaction.editReply({
			content:
				errorMessageLocalizations[interaction.locale] ??
				'There was an error while executing this command! Please try again in a few minutes. If the problem persists, please open an issue on GitHub.',
			flags: MessageFlags.Ephemeral
		});
	}
}

function getCommandOptions(interaction) {
	const commandOptions = interaction.options.data.map((option) => ({ name: option.name, value: option.value }));
	return commandOptions.length ? commandOptions : null;
}
