/**
 * Human-readable rendering, for CLIs, logs and debugging.
 */

import { formatBoard } from './board';
import { formatTile, formatTiles, sumPips } from './tiles';
import {
	teamOf,
	type HandResult,
	type HandState,
	type MatchState,
	type Move,
	type MoveRecord,
	type Seat,
	type TeamId,
} from './types';

export const SEAT_LABELS: readonly string[] = ['South', 'West', 'North', 'East'];
export const TEAM_LABELS: readonly string[] = ['South/North', 'West/East'];

export function seatLabel(seat: Seat): string {
	return `${SEAT_LABELS[seat]} (seat ${seat})`;
}

export function teamLabel(team: TeamId): string {
	return TEAM_LABELS[team];
}

export function describeMove(move: Move): string {
	if (move.type === 'pass') {
		return `${SEAT_LABELS[move.seat]} passes`;
	}
	return `${SEAT_LABELS[move.seat]} plays ${formatTile(move.tile)} on the ${move.end}`;
}

export function describeRecord(record: MoveRecord): string {
	if (record.type === 'pass') {
		const ends = record.endsBefore;
		const on = ends === null ? '' : ` on ${ends[0]}/${ends[1]}`;
		return `${SEAT_LABELS[record.seat]} passes${on}`;
	}
	const tile = record.tile === null ? '?' : formatTile(record.tile);
	if (record.end === 'opening') {
		return `${SEAT_LABELS[record.seat]} opens with ${tile}`;
	}
	return `${SEAT_LABELS[record.seat]} plays ${tile} on the ${record.end}`;
}

export function describeResult(result: HandResult): string {
	const pips = result.pipsByTeam;
	const tally = `${TEAM_LABELS[0]} ${pips[0]} pips, ${TEAM_LABELS[1]} ${pips[1]} pips`;

	if (result.outcome === 'tie') {
		return `Hand ${result.handNumber}: tranca tied (${tally}). No points.`;
	}

	const team = result.winningTeam as TeamId;
	const how =
		result.outcome === 'domino'
			? `${SEAT_LABELS[result.closingSeat]} went out`
			: `tranca closed by ${SEAT_LABELS[result.closingSeat]}`;
	const bonus = result.capicua
		? ` including a capicúa bonus of ${result.points - result.pipPoints}`
		: '';

	return `Hand ${result.handNumber}: ${how} — ${TEAM_LABELS[team]} scores ${result.points}${bonus} (${tally}).`;
}

/** One line per seat: tiles held and their weight. */
export function formatHands(hand: HandState): string {
	return hand.hands
		.map((tiles, seat) => {
			const held = tiles.length === 0 ? '(empty)' : formatTiles(tiles);
			return `  ${SEAT_LABELS[seat].padEnd(6)} ${String(tiles.length).padStart(2)} tiles ${String(
				sumPips(tiles),
			).padStart(3)} pips  ${held}`;
		})
		.join('\n');
}

export function formatScores(state: MatchState): string {
	return `${TEAM_LABELS[0]} ${state.scores[0]} — ${TEAM_LABELS[1]} ${state.scores[1]} (target ${state.rules.targetScore})`;
}

/** A compact snapshot of the table, with every hand visible: for logs, not for players. */
export function formatMatch(state: MatchState): string {
	const hand = state.hand;
	const lines = [
		`Hand ${hand.handNumber} — ${formatScores(state)}`,
		`Table: ${formatBoard(hand.board)}`,
		formatHands(hand),
	];

	if (hand.status === 'playing') {
		lines.push(`To play: ${seatLabel(hand.turn)} of team ${teamOf(hand.turn)}`);
	} else if (hand.result !== null) {
		lines.push(describeResult(hand.result));
	}

	if (state.status === 'finished' && state.winner !== null) {
		lines.push(`Match over — ${TEAM_LABELS[state.winner]} win.`);
	}

	return lines.join('\n');
}

/** The hand replayed move by move. */
export function formatLog(hand: HandState): string {
	return hand.log
		.map((record) => `  ${String(record.ply + 1).padStart(2)}. ${describeRecord(record)}`)
		.join('\n');
}
