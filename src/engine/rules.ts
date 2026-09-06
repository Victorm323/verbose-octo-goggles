/**
 * Move legality and the opening of a hand.
 */

import { boardEnds, canPlace, isBoardEmpty } from './board';
import type { RuleConfig } from './config';
import { fail } from './errors';
import {
	containsTile,
	DOUBLE_SIX,
	highestDouble,
	isDouble,
	tileHasPip,
	tileId,
	tilesEqual,
	type Tile,
} from './tiles';
import type { Board, End, Move, PlayMove, Seat } from './types';

/**
 * Every play available to `seat`.
 *
 * A tile that fits both ends produces two moves, because which end you feed it to is a
 * real decision — often *the* decision of the hand.
 */
export function legalPlays(
	board: Board,
	hand: readonly Tile[],
	seat: Seat,
	mustOpenWith: Tile | null = null,
): PlayMove[] {
	if (isBoardEmpty(board)) {
		const openable = mustOpenWith === null ? hand : hand.filter((t) => tilesEqual(t, mustOpenWith));
		// The opening tile has no end to attach to; 'left' is the arbitrary convention.
		return openable.map((t) => ({ type: 'play', seat, tile: t, end: 'left' }) as PlayMove);
	}

	const ends = boardEnds(board);
	if (ends === null) return [];

	const moves: PlayMove[] = [];
	const endsAreDistinct = ends.left !== ends.right;

	for (const t of hand) {
		if (tileHasPip(t, ends.left)) {
			moves.push({ type: 'play', seat, tile: t, end: 'left' });
		}
		// While both ends show the same number, the two placements are mirror images: they
		// leave the table with exactly the same pair of open ends, so listing both would
		// only inflate the branching factor. `assertMoveLegal` still accepts either side,
		// so a client that wants to build the chain rightwards is free to.
		if (endsAreDistinct && tileHasPip(t, ends.right)) {
			moves.push({ type: 'play', seat, tile: t, end: 'right' });
		}
	}
	return moves;
}

/** Legal moves including the pass, which only exists when nothing can be played. */
export function legalMovesFor(
	board: Board,
	hand: readonly Tile[],
	seat: Seat,
	mustOpenWith: Tile | null = null,
): Move[] {
	const plays = legalPlays(board, hand, seat, mustOpenWith);
	if (plays.length > 0) return plays;
	return [{ type: 'pass', seat }];
}

export function hasLegalPlay(
	board: Board,
	hand: readonly Tile[],
	mustOpenWith: Tile | null = null,
): boolean {
	return legalPlays(board, hand, 0, mustOpenWith).length > 0;
}

/** Validates a move against the board and the hand, throwing an `EngineError` if illegal. */
export function assertMoveLegal(
	board: Board,
	hand: readonly Tile[],
	move: Move,
	mustOpenWith: Tile | null = null,
): void {
	if (move.type === 'pass') {
		if (hasLegalPlay(board, hand, mustOpenWith)) {
			fail('ILLEGAL_PASS', 'a pass is only legal when no tile can be played');
		}
		return;
	}

	if (!containsTile(hand, move.tile)) {
		fail('TILE_NOT_IN_HAND', `tile ${tileId(move.tile)} is not in this hand`);
	}

	if (isBoardEmpty(board)) {
		if (mustOpenWith !== null && !tilesEqual(move.tile, mustOpenWith)) {
			fail('MUST_OPEN_WITH', `the hand must be opened with ${tileId(mustOpenWith)}`);
		}
		return;
	}

	if (!canPlace(board, move.tile, move.end)) {
		const ends = boardEnds(board);
		const target = move.end === 'left' ? ends?.left : ends?.right;
		fail('ILLEGAL_PLACEMENT', `${tileId(move.tile)} does not fit the ${move.end} end (${target})`);
	}
}

export interface Opening {
	readonly seat: Seat;
	/** The tile that seat is obliged to lead, or `null` when they may lead anything. */
	readonly mustOpenWith: Tile | null;
}

/**
 * Decides who opens the first hand of a match, and with what.
 *
 * Later hands are led by the previous hand's winner, with a free choice of tile, so this
 * is only consulted when a match starts.
 */
export function determineOpening(
	hands: readonly (readonly Tile[])[],
	rules: RuleConfig,
): Opening {
	if (rules.opening === 'fixed-seat') {
		return { seat: rules.openingSeat, mustOpenWith: null };
	}

	if (rules.opening === 'double-six') {
		for (let seat = 0; seat < hands.length; seat++) {
			if (containsTile(hands[seat], DOUBLE_SIX)) {
				return { seat: seat as Seat, mustOpenWith: DOUBLE_SIX };
			}
		}
		// Only reachable with a short deal, where [6|6] may sit outside every hand.
		return highestDoubleOpening(hands, rules);
	}

	return highestDoubleOpening(hands, rules);
}

function highestDoubleOpening(
	hands: readonly (readonly Tile[])[],
	rules: RuleConfig,
): Opening {
	let bestSeat: Seat | null = null;
	let best: Tile | null = null;

	for (let seat = 0; seat < hands.length; seat++) {
		const candidate = highestDouble(hands[seat]);
		if (candidate !== null && (best === null || candidate.a > best.a)) {
			best = candidate;
			bestSeat = seat as Seat;
		}
	}

	if (bestSeat === null || best === null) {
		// No double was dealt at all: fall back to the configured seat, free choice.
		return { seat: rules.openingSeat, mustOpenWith: null };
	}
	return { seat: bestSeat, mustOpenWith: best };
}

/**
 * Capicúa: the hand is closed with a tile that would have fitted on *either* end.
 *
 * The strict reading — the default here — also requires the two ends to be different
 * numbers and the tile not to be a double, since a double closing a symmetric chain is
 * just an ordinary win.
 */
export function isCapicua(boardBeforeMove: Board, played: Tile, rules: RuleConfig): boolean {
	if (rules.capicuaBonus <= 0) return false;

	const ends = boardEnds(boardBeforeMove);
	if (ends === null) return false; // winning on the opening tile is not a thing
	if (isDouble(played)) return false;
	if (rules.capicuaRequiresDistinctEnds && ends.left === ends.right) return false;

	return tileHasPip(played, ends.left) && tileHasPip(played, ends.right);
}

/** Convenience for UIs: which ends would accept this tile right now. */
export function playableEnds(board: Board, t: Tile): End[] {
	const ends = boardEnds(board);
	if (ends === null) return ['left'];
	const result: End[] = [];
	if (tileHasPip(t, ends.left)) result.push('left');
	if (tileHasPip(t, ends.right)) result.push('right');
	return result;
}
