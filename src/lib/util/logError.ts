import { captureException } from '@sentry/node';
import { Interaction } from 'discord.js';
import { convertAPIOptionsToCommandOptions } from 'mahoji/dist/lib/util';

import { production } from '../../config';

export function logError(err: Error | unknown, context?: Record<string, string>) {
	if (production) {
		captureException(err, {
			tags: context
		});
	} else {
		console.error(context, err);
	}
}

export function logErrorForInteraction(err: Error | unknown, interaction: Interaction) {
	const context: Record<string, any> = {
		user_id: interaction.user.id,
		channel_id: interaction.channelId,
		guild_id: interaction.guildId,
		interaction_id: interaction.id,
		interaction_type: interaction.type
	};
	if (interaction.isChatInputCommand()) {
		context.options = convertAPIOptionsToCommandOptions(interaction.options.data, interaction.options.resolved);
		context.command_name = interaction.commandName;
	}

	logError(err, context);
}
