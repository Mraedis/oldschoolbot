import { shuffleArr } from 'e';
import { Bank } from 'oldschooljs';
import { ChambersOfXeric } from 'oldschooljs/dist/simulation/misc/ChambersOfXeric';

import { Emoji, Events } from '../../../lib/constants';
import { chambersOfXericCL, chambersOfXericMetamorphPets } from '../../../lib/data/CollectionsExport';
import { createTeam } from '../../../lib/data/cox';
import { trackLoot } from '../../../lib/lootTrack';
import { getMinigameScore, incrementMinigameScore } from '../../../lib/settings/settings';
import { RaidsOptions } from '../../../lib/types/minions';
import { randomVariation, roll } from '../../../lib/util';
import { formatOrdinal } from '../../../lib/util/formatOrdinal';
import { handleTripFinish } from '../../../lib/util/handleTripFinish';
import resolveItems from '../../../lib/util/resolveItems';
import { updateBankSetting } from '../../../mahoji/mahojiSettings';

interface RaidResultUser {
	personalPoints: number;
	loot: Bank;
	mUser: MUser;
	deaths: number;
	deathChance: number;
	gotAncientTablet?: boolean;
}

const notPurple = resolveItems(['Torn prayer scroll', 'Dark relic', 'Onyx']);
const greenItems = resolveItems(['Twisted ancestral colour kit']);
const blueItems = resolveItems(['Metamorphic dust']);
const purpleButNotAnnounced = resolveItems(['Dexterous prayer scroll', 'Arcane prayer scroll']);

const purpleItems = chambersOfXericCL.filter(i => !notPurple.includes(i));

export const raidsTask: MinionTask = {
	type: 'Raids',
	async run(data: RaidsOptions) {
		const { channelID, users, challengeMode, duration, leader, quantity: _quantity } = data;
		const quantity = _quantity ?? 1;
		const allUsers = await Promise.all(users.map(async u => mUserFetch(u)));

		let totalPoints = 0;
		const raidResults = new Map<string, RaidResultUser>();
		for (let x = 0; x < quantity; x++) {
			const team = await createTeam(allUsers, challengeMode);
			// Prevent getting multiple Ancient Tablets
			for (const teamMate of team) {
				if (raidResults.get(teamMate.id)?.gotAncientTablet) {
					teamMate.canReceiveAncientTablet = false;
				}
			}
			// Vary completion times for CM time limits
			const timeToComplete = quantity === 1 ? duration : randomVariation(duration / quantity, 5);
			const raidLoot = ChambersOfXeric.complete({
				challengeMode,
				timeToComplete,
				team
			});
			for (const [userID, userLoot] of Object.entries(raidLoot)) {
				let userData = raidResults.get(userID);
				// Do all the one-time / per-user stuff:
				if (!userData) {
					// User already fetched earlier, no need to make another DB call
					const mUser = allUsers.find(u => u.id === userID)!;
					userData = {
						personalPoints: 0,
						loot: new Bank(),
						mUser,
						deaths: 0,
						deathChance: 0
					};
				}
				// Handle the per-raid stuff
				const member = team.find(m => m.id === userID)!;
				userData.personalPoints += member.personalPoints;
				userData.deaths += member.deaths;
				userData.deathChance = member.deathChance;
				totalPoints += member.personalPoints;

				const hasDust = userData.loot.has('Metamorphic dust') || userData.mUser.cl.has('Metamorphic dust');
				if (challengeMode && roll(50) && hasDust) {
					const { bank } = userData.loot.clone().add(userData.mUser.allItemsOwned());
					const unownedPet = shuffleArr(chambersOfXericMetamorphPets).find(pet => !bank[pet]);
					if (unownedPet) {
						userLoot.add(unownedPet);
					}
				}
				if (userLoot.has('Ancient tablet')) {
					userData.gotAncientTablet = true;
				}

				userData.loot.add(userLoot);
				raidResults.set(userID, userData);
			}
		}

		const minigameID = challengeMode ? 'raids_challenge_mode' : 'raids';

		const totalLoot = new Bank();

		let resultMessage = `<@${leader}> Your ${challengeMode ? 'Challenge Mode Raid' : 'Raid'}${
			quantity > 1 ? 's have' : ' has'
		} finished. The total amount of points your team got is ${totalPoints.toLocaleString()}.\n`;
		await Promise.all(allUsers.map(u => incrementMinigameScore(u.id, minigameID, quantity)));

		for (let [userID, userData] of raidResults) {
			const { personalPoints, deaths, deathChance, loot, mUser: user } = userData;
			if (!user) continue;

			await user.update({
				total_cox_points: {
					increment: personalPoints
				}
			});

			const { itemsAdded } = await transactItems({
				userID,
				itemsToAdd: loot,
				collectionLog: true
			});
			totalLoot.add(itemsAdded);

			const items = itemsAdded.items();

			const isPurple = items.some(([item]) => purpleItems.includes(item.id));
			const isGreen = items.some(([item]) => greenItems.includes(item.id));
			const isBlue = items.some(([item]) => blueItems.includes(item.id));
			const specialLoot = isPurple;
			const emote = isBlue ? Emoji.Blue : isGreen ? Emoji.Green : Emoji.Purple;
			if (items.some(([item]) => purpleItems.includes(item.id) && !purpleButNotAnnounced.includes(item.id))) {
				const itemsToAnnounce = itemsAdded.filter(item => purpleItems.includes(item.id), false);
				globalClient.emit(
					Events.ServerNotification,
					`${emote} ${user.usernameOrMention} just received **${itemsToAnnounce}** on their ${formatOrdinal(
						await getMinigameScore(user.id, minigameID)
					)} raid.`
				);
			}
			const str = specialLoot ? `${emote} ||${itemsAdded}||` : itemsAdded.toString();
			const deathStr = deaths === 0 ? '' : new Array(deaths).fill(Emoji.Skull).join(' ');

			resultMessage += `\n${deathStr} **${user}** received: ${str} (${personalPoints?.toLocaleString()} pts, ${
				Emoji.Skull
			}${deathChance.toFixed(0)}%) `;
		}

		updateBankSetting('cox_loot', totalLoot);
		await trackLoot({
			totalLoot,
			id: minigameID,
			type: 'Minigame',
			changeType: 'loot',
			duration,
			kc: quantity,
			users: allUsers.map(i => ({
				id: i.id,
				duration,
				loot: raidResults.get(i.id)?.loot ?? new Bank()
			}))
		});

		handleTripFinish(allUsers[0], channelID, resultMessage, undefined, data, null);
	}
};
