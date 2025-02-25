import { userMention } from '@discordjs/builders';
import { ChannelType, ChatInputCommandInteraction, TextChannel } from 'discord.js';
import { Bank } from 'oldschooljs';

import { NEX_ID } from '../../../lib/constants';
import { trackLoot } from '../../../lib/lootTrack';
import { setupParty } from '../../../lib/party';
import { calculateNexDetails, checkNexUser } from '../../../lib/simulation/nex';
import { NexTaskOptions } from '../../../lib/types/minions';
import { calcPerHour, formatDuration } from '../../../lib/util';
import addSubTaskToActivityTask from '../../../lib/util/addSubTaskToActivityTask';
import { deferInteraction } from '../../../lib/util/interactionReply';
import { updateBankSetting } from '../../mahojiSettings';

export async function nexCommand(interaction: ChatInputCommandInteraction, user: MUser, channelID: string) {
	const channel = globalClient.channels.cache.get(channelID.toString());
	if (!channel || channel.type !== ChannelType.GuildText) return 'You need to run this in a text channel.';

	const ownerCheck = checkNexUser(user);
	if (ownerCheck[1]) {
		return `You can't start a Nex mass: ${ownerCheck[1]}`;
	}

	await deferInteraction(interaction);

	let usersWhoConfirmed: MUser[] = [];
	try {
		usersWhoConfirmed = await setupParty(channel as TextChannel, user, {
			minSize: 2,
			maxSize: 10,
			leader: user,
			ironmanAllowed: true,
			message: `${user} is hosting a Nex mass! Use the buttons below to join/leave.`,
			customDenier: async user => checkNexUser(await mUserFetch(user.id))
		});
	} catch (err: any) {
		return {
			content: typeof err === 'string' ? err : 'Your mass failed to start.',
			ephemeral: true
		};
	}
	usersWhoConfirmed = usersWhoConfirmed.filter(i => !i.minionIsBusy);

	if (usersWhoConfirmed.length < 2 || usersWhoConfirmed.length > 10) {
		return `${user}, your mass didn't start because it needs atleast 2 users.`;
	}

	const mahojiUsers = await Promise.all(usersWhoConfirmed.map(i => mUserFetch(i.id)));

	for (const user of mahojiUsers) {
		const result = checkNexUser(user);
		if (result[1]) {
			return result[1];
		}
	}

	const details = calculateNexDetails({
		team: mahojiUsers
	});

	for (const user of details.team) {
		const mUser = await mUserFetch(user.id);
		if (!mUser.allItemsOwned().has(user.cost)) {
			return `${mUser.usernameOrMention} doesn't have the required items: ${user.cost}.`;
		}
	}

	const removeResult = await Promise.all(
		details.team.map(async i => {
			const klasaUser = await mUserFetch(i.id);
			return {
				id: klasaUser.id,
				cost: (await klasaUser.specialRemoveItems(i.cost)).realCost
			};
		})
	);

	const totalCost = new Bank();
	for (const u of removeResult) totalCost.add(u.cost);

	await Promise.all([
		await updateBankSetting('nex_cost', totalCost),
		await trackLoot({
			totalCost,
			id: 'nex',
			type: 'Monster',
			changeType: 'cost',
			users: removeResult.map(i => ({
				id: i.id,
				cost: i.cost
			}))
		})
	]);

	await addSubTaskToActivityTask<NexTaskOptions>({
		userID: user.id,
		channelID: channelID.toString(),
		duration: details.duration,
		type: 'Nex',
		leader: user.id,
		users: details.team.map(i => i.id),
		userDetails: details.team.map(i => [i.id, i.contribution, i.deaths]),
		fakeDuration: details.fakeDuration,
		quantity: details.quantity,
		wipedKill: details.wipedKill
	});

	let str = `${user.usernameOrMention}'s party (${usersWhoConfirmed
		.map(u => u.usernameOrMention)
		.join(', ')}) is now off to kill ${details.quantity}x Nex! (${calcPerHour(
		details.quantity,
		details.fakeDuration
	).toFixed(1)}/hr) - the total trip will take ${formatDuration(details.fakeDuration)}.

${details.team
	.map(i => {
		const mUser = mahojiUsers.find(t => t.id === i.id)!;
		return `${userMention(i.id)}: Contrib[${i.contribution.toFixed(2)}%] Death[${i.deathChance.toFixed(
			2
		)}%] KC[${mUser.getKC(NEX_ID)}] Offence[${Math.round(i.totalOffensivePecent)}%] Defence[${Math.round(
			i.totalDefensivePercent
		)}%] *${i.messages.join(', ')}*`;
	})
	.join('\n')}
`;

	return str;
}
