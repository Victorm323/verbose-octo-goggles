/**
 * Settling a hand.
 *
 * Two ways a hand ends:
 *
 * - **Dominó** — a player empties their hand. Their team scores every pip still held by
 *   the other three players, plus the capicúa bonus if the closing tile earned one.
 * - **Tranca** — all four players pass in turn and the game is locked. The team with the
 *   lower pip total wins the hand; by default it scores *all* the pips left on the table,
 *   its own included, which is the usual Dominican count. Equal totals means nobody
 *   scores and the same seat leads again.
 */

import type { RuleConfig } from './config';
import { sumPips, type Tile } from './tiles';
import {
	partnerOf,
	seatsOfTeam,
	teamOf,
	type HandResult,
	type Seat,
	type TeamId,
} from './types';

export type Hands = readonly [readonly Tile[], readonly Tile[], readonly Tile[], readonly Tile[]];

export function pipsBySeat(hands: Hands): readonly [number, number, number, number] {
	return [sumPips(hands[0]), sumPips(hands[1]), sumPips(hands[2]), sumPips(hands[3])];
}

export function pipsByTeam(perSeat: readonly [number, number, number, number]) {
	return [perSeat[0] + perSeat[2], perSeat[1] + perSeat[3]] as const;
}

export interface DominoSettlement {
	readonly handNumber: number;
	readonly hands: Hands;
	readonly closingSeat: Seat;
	readonly capicua: boolean;
	readonly rules: RuleConfig;
}

export function settleDomino(settlement: DominoSettlement): HandResult {
	const { handNumber, hands, closingSeat, capicua, rules } = settlement;
	const perSeat = pipsBySeat(hands);
	const perTeam = pipsByTeam(perSeat);
	const winningTeam = teamOf(closingSeat);

	// The closing seat is empty, so the total across all four hands is exactly what the
	// other three are still holding.
	const pipPoints = perSeat[0] + perSeat[1] + perSeat[2] + perSeat[3];
	const bonus = capicua ? rules.capicuaBonus : 0;

	return {
		handNumber,
		outcome: 'domino',
		winningTeam,
		closingSeat,
		points: pipPoints + bonus,
		pipPoints,
		capicua,
		pipsBySeat: perSeat,
		pipsByTeam: [perTeam[0], perTeam[1]],
		nextStarter: closingSeat,
	};
}

export interface TrancaSettlement {
	readonly handNumber: number;
	readonly hands: Hands;
	/** Seat that played the tile which locked the game (the last seat to actually play). */
	readonly blockingSeat: Seat;
	/** Seat that opened the hand — it leads again after a tie. */
	readonly starter: Seat;
	readonly rules: RuleConfig;
}

export function settleTranca(settlement: TrancaSettlement): HandResult {
	const { handNumber, hands, blockingSeat, starter, rules } = settlement;
	const perSeat = pipsBySeat(hands);
	const perTeam = pipsByTeam(perSeat);

	if (perTeam[0] === perTeam[1]) {
		return {
			handNumber,
			outcome: 'tie',
			winningTeam: null,
			closingSeat: blockingSeat,
			points: 0,
			pipPoints: 0,
			capicua: false,
			pipsBySeat: perSeat,
			pipsByTeam: [perTeam[0], perTeam[1]],
			nextStarter: starter,
		};
	}

	const winningTeam: TeamId = perTeam[0] < perTeam[1] ? 0 : 1;
	const losingTeam: TeamId = winningTeam === 0 ? 1 : 0;
	const pipPoints =
		rules.trancaScoring === 'all-remaining' ? perTeam[0] + perTeam[1] : perTeam[losingTeam];

	return {
		handNumber,
		outcome: 'tranca',
		winningTeam,
		closingSeat: blockingSeat,
		points: pipPoints,
		pipPoints,
		capicua: false,
		pipsBySeat: perSeat,
		pipsByTeam: [perTeam[0], perTeam[1]],
		nextStarter: trancaStarter(winningTeam, blockingSeat, perSeat, rules),
	};
}

/**
 * Who leads after a tranca.
 *
 * `blocker` — the seat that locked the game leads, which is how most tables play it.
 * `winner-side` — the winning team's lighter hand leads; ties inside the team go to the
 * blocker when they are on that team, otherwise to their partner.
 */
function trancaStarter(
	winningTeam: TeamId,
	blockingSeat: Seat,
	perSeat: readonly [number, number, number, number],
	rules: RuleConfig,
): Seat {
	if (rules.trancaStarter === 'blocker') {
		return blockingSeat;
	}

	const [first, second] = seatsOfTeam(winningTeam);
	if (perSeat[first] !== perSeat[second]) {
		return perSeat[first] < perSeat[second] ? first : second;
	}
	return teamOf(blockingSeat) === winningTeam ? blockingSeat : partnerOf(blockingSeat);
}

/** Applies a hand result to the running score. */
export function applyResultToScores(
	scores: readonly [number, number],
	result: HandResult,
): [number, number] {
	const updated: [number, number] = [scores[0], scores[1]];
	if (result.winningTeam !== null) {
		updated[result.winningTeam] += result.points;
	}
	return updated;
}
