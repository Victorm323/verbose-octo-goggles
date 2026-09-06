/**
 * What one player can actually see.
 *
 * `MatchState` is the referee's view and holds every hand. Bots and user interfaces must
 * go through `observationFor`, which exposes a seat's own tiles plus the public record —
 * the chain, the tile counts, the passes and what those passes give away.
 */

import { boardEnds, type BoardEnds } from './board';
import type { RuleConfig } from './config';
import { legalMovesFor } from './rules';
import { containsTile, countSuit, fullSet, PIPS, sumPips, type Pip, type Tile } from './tiles';
import {
	partnerOf,
	SEATS,
	teamOf,
	type Board,
	type HandResult,
	type MatchState,
	type Move,
	type MoveRecord,
	type Seat,
	type TeamId,
} from './types';

export interface Observation {
	readonly seat: Seat;
	readonly partner: Seat;
	readonly team: TeamId;
	readonly opponents: readonly [Seat, Seat];
	readonly rules: RuleConfig;

	readonly handNumber: number;
	readonly turn: Seat;
	readonly isMyTurn: boolean;
	readonly scores: readonly [number, number];

	readonly board: Board;
	readonly ends: BoardEnds | null;
	/** The observer's own tiles. */
	readonly hand: readonly Tile[];
	/** How many tiles each seat still holds, this seat included. */
	readonly tileCounts: readonly [number, number, number, number];
	/** Tiles neither in this hand nor on the table: the other three hands, pooled. */
	readonly unseen: readonly Tile[];
	/** How many tiles of each suit the observer holds. Index by pip. */
	readonly suitsInHand: readonly number[];
	/** How many tiles of each suit are still unaccounted for. Index by pip. */
	readonly suitsUnseen: readonly number[];
	/**
	 * `knownVoids[seat][pip]` is true once `seat` has passed while `pip` was on an end,
	 * which proves they hold nothing of that suit. This is the core read of the game.
	 */
	readonly knownVoids: readonly (readonly boolean[])[];
	readonly passCounts: readonly [number, number, number, number];
	readonly log: readonly MoveRecord[];
	/** Moves available to the observer, empty when it is not their turn. */
	readonly legalMoves: readonly Move[];
	/** Set once the hand has been settled. */
	readonly result: HandResult | null;
}

function emptyVoidTable(): boolean[][] {
	return SEATS.map(() => PIPS.map(() => false));
}

/**
 * Derives, from the public log, which suits each seat is known to be out of.
 *
 * A pass is a statement: the player held nothing matching either open end at that moment,
 * and since hands only shrink, that stays true for the rest of the hand.
 */
export function deriveKnownVoids(log: readonly MoveRecord[]): boolean[][] {
	const voids = emptyVoidTable();
	for (const record of log) {
		if (record.type !== 'pass' || record.endsBefore === null) continue;
		voids[record.seat][record.endsBefore[0]] = true;
		voids[record.seat][record.endsBefore[1]] = true;
	}
	return voids;
}

function countPasses(log: readonly MoveRecord[]): [number, number, number, number] {
	const counts: [number, number, number, number] = [0, 0, 0, 0];
	for (const record of log) {
		if (record.type === 'pass') counts[record.seat] += 1;
	}
	return counts;
}

/** Tiles the observer cannot see: the full set minus their hand minus the table. */
export function unseenTiles(board: Board, hand: readonly Tile[]): Tile[] {
	const onTable = board.map((placed) => placed.tile);
	return fullSet().filter((t) => !containsTile(hand, t) && !containsTile(onTable, t));
}

export function observationFor(state: MatchState, seat: Seat): Observation {
	const hand = state.hand;
	const own = hand.hands[seat];
	const unseen = unseenTiles(hand.board, own);
	const isMyTurn = hand.status === 'playing' && hand.turn === seat;

	const mustOpenWith = hand.board.length === 0 && seat === hand.starter ? hand.mustOpenWith : null;

	return {
		seat,
		partner: partnerOf(seat),
		team: teamOf(seat),
		opponents: [((seat + 1) % 4) as Seat, ((seat + 3) % 4) as Seat],
		rules: state.rules,

		handNumber: hand.handNumber,
		turn: hand.turn,
		isMyTurn,
		scores: state.scores,

		board: hand.board,
		ends: boardEnds(hand.board),
		hand: own,
		tileCounts: [
			hand.hands[0].length,
			hand.hands[1].length,
			hand.hands[2].length,
			hand.hands[3].length,
		],
		unseen,
		suitsInHand: PIPS.map((pip) => countSuit(own, pip)),
		suitsUnseen: PIPS.map((pip) => countSuit(unseen, pip)),
		knownVoids: deriveKnownVoids(hand.log),
		passCounts: countPasses(hand.log),
		log: hand.log,
		legalMoves: isMyTurn ? legalMovesFor(hand.board, own, seat, mustOpenWith) : [],
		result: hand.result,
	};
}

/** Pips still in the observer's own hand — what they stand to hand over if they lose. */
export function ownPips(observation: Observation): number {
	return sumPips(observation.hand);
}

/** Is `seat` known to hold nothing of `pip`? */
export function isKnownVoid(observation: Observation, seat: Seat, pip: Pip): boolean {
	return observation.knownVoids[seat][pip];
}
