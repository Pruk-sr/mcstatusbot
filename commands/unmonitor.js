'use strict';
import { InteractionContextType, PermissionFlagsBits, SlashCommandBuilder } from 'discord.js';
import { getMissingPermissions, isMissingPermissions } from '../functions/botPermissions.js';
import { beaver } from '../functions/consoleLogging.js';
import { deleteServer, deleteServers, getServers } from '../functions/databaseFunctions.js';
import { findDefaultServer, findServer } from '../functions/findServer.js';
import { isNotMonitored, isServerUnspecified, noMonitoredServers, removingDefaultServer } from '../functions/inputValidation.js';
import { sendMessage } from '../functions/sendMessage.js';
import {
	deletionErrorLocalizations,
	descriptionLocalizations,
	errorMessageLocalizations,
	nameLocalizations,
	noChannelSpecifiedErrorLocalizations,
	serverDescriptionLocalizations,
	serverLocalizations,
	successMessageLocalizations,
	unmonitoringErrorLocalizations
} from '../localizations/unmonitor.js';

// prettier-ignore
export const data = new SlashCommandBuilder()
	.setName('unmonitor')
    .setNameLocalizations(nameLocalizations)
	.setDescription('Unmonitor the specified server or all servers')
    .setDescriptionLocalizations(descriptionLocalizations)
	.addStringOption((option) => option
		.setName('server')
        .setNameLocalizations(serverLocalizations)
		.setDescription('Server IP address or nickname')
        .setDescriptionLocalizations(serverDescriptionLocalizations)
		.setRequired(false))
	.setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
	.setContexts(InteractionContextType.Guild);

export async function execute(interaction) {
	if (await noMonitoredServers(interaction.guildId, interaction)) return;
	if (await isServerUnspecified(interaction.options.getString('server'), interaction.guildId, interaction)) return;

	// Unmonitor all servers if specified
	if (interaction.options.getString('server') == 'all') {
		let notUnmonitored = [];
		let notDeleted = [];
		let monitoredServers = await getServers(interaction.guild.id);
		await Promise.allSettled(
			monitoredServers.map(async (server) => {
				// Check if the bot has the required permissions'
				let missingPermissions = false;
				const channels = [
					{ id: server.categoryId, type: 'Category' },
					{ id: server.statusId, type: 'Status Channel' },
					{ id: server.playersId, type: 'Players Channel' }
				];
				await Promise.all(
					channels.map(async (channel) => {
						if (await isMissingPermissions(channel.type, interaction.guild.channels.cache.get(channel.id))) {
							let missingPermissions = getMissingPermissions(channel.type, interaction.guild.channels.cache.get(channel.id));
							notUnmonitored.push({
								ip: server.ip,
								name: server.nickname || server.ip,
								type: channel.type,
								missingPermissions
							});
							throw new Error();
						}
					})
				).catch(() => (missingPermissions = true));
				if (missingPermissions) return;

				try {
					await removeChannels(server, interaction.guild);
				} catch (error) {
					notDeleted.push(server.nickname || server.ip);
				}
			})
		);
		const unmonitoredServers = monitoredServers.filter((server1) => !notUnmonitored.some((server2) => server1.ip == server2.ip));
		deleteServers(interaction.guildId, unmonitoredServers);

		if (!notUnmonitored.length && !notDeleted.length) {
			await sendMessage(interaction, successMessageLocalizations[interaction.locale] ?? 'The server has successfully been unmonitored.');
		} else {
			let notUnmonitoredList = notUnmonitored
				.map((server) => {
					return `${server.name} // ${server.type}: ${server.missingPermissions}`;
				})
				.join('\n');
			let notDeletedList = notDeleted.join(', ');
			await sendMessage(
				interaction,
				errorMessageLocalizations[interaction.locale]?.default ??
					`There was an error while unmonitoring some of the servers!
				${
					notUnmonitored.length
						? (errorMessageLocalizations[interaction.locale]?.notUnmonitored ??
							`
				The following servers need the required category and/or channel permissions before you can unmonitor them:\n
				${notUnmonitoredList}`)
						: ''
				} ${
					notDeleted.length
						? (errorMessageLocalizations[interaction.locale]?.notDeleted ??
							`
				The following servers were unmonitored, but the channels need to be removed manually:\n
				${notDeletedList}`)
						: ''
				}`
			);
		}
		return;
	}

	let server;

	if (interaction.options.getString('server')) {
		server = await findServer(interaction.options.getString('server'), ['ip', 'nickname'], interaction.guildId);
		if (await isNotMonitored(server, interaction)) return;
	} else {
		server = await findDefaultServer(interaction.guildId);
	}

	if (await removingDefaultServer(server, interaction.guildId, interaction)) return;

	// Check if the bot has the required permissions
	let missingPermissions = false;
	const channels = [
		{ id: server.categoryId, type: 'Category' },
		{ id: server.statusId, type: 'Status Channel' },
		{ id: server.playersId, type: 'Players Channel' }
	];
	await Promise.all(
		channels.map(async (channel) => {
			if (await isMissingPermissions(channel.type, interaction.guild.channels.cache.get(channel.id), interaction)) throw new Error();
		})
	).catch(() => (missingPermissions = true));
	if (missingPermissions) return;

	// Unmonitor the server
	try {
		await deleteServer(interaction.guildId, server);
	} catch {
		beaver.log(
			'unmonitor',
			'Error removing server from database',
			JSON.stringify({
				'Guild ID': interaction.guildId,
				'Server IP': server.ip
			}),
			error
		);
		await sendMessage(
			interaction,
			unmonitoringErrorLocalizations[interaction.locale] ?? 'There was an error while unmonitoring the server. Please try again later!'
		);
		return;
	}

	try {
		await removeChannels(server, interaction.guild);
	} catch (error) {
		await sendMessage(
			interaction,
			deletionErrorLocalizations[interaction.locale] ?? 'There was an error while deleting some of the channels. Please delete them manually!'
		);
		return;
	}

	await sendMessage(interaction, successMessageLocalizations[interaction.locale] ?? 'The server has successfully been unmonitored.');
}

async function removeChannels(server, guild) {
	const channels = [
		await guild.channels.cache.get(server.statusId),
		await guild.channels.cache.get(server.playersId),
		await guild.channels.cache.get(server.categoryId)
	];

	await Promise.allSettled(
		channels.map(async (channel) => {
			try {
				if (!channel) throw new Error(noChannelSpecifiedErrorLocalizations[interaction.locale] ?? 'No channel specified');
				await channel.delete();
			} catch (error) {
				beaver.log(
					'unmonitor',
					JSON.stringify({
						'Channel ID': channel.id,
						'Guild ID': guild.id,
						'Server IP': server.ip
					}),
					error
				);
				throw error;
			}
		})
	).then((promises) => {
		promises.forEach((promise) => {
			if (promise.status == 'rejected')
				throw new Error(
					deletionErrorLocalizations[interaction.locale] ?? 'There was an error while deleting some of the channels. Please delete them manually!'
				);
		});
	});
}
