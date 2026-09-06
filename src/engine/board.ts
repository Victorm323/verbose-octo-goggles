/**
 * The chain of tiles on the table.
 *
 * The board is an array in physical left-to-right order. Each entry is oriented so that
 * `board[i].right === board[i + 1].left`; the playable numbers are therefore the `left` of
 * the first tile and the `right` of the last one.
 */

import { fail } from './errors';
import { otherPip, tileHasPip, tileId, type Pip, type Tile } from './tiles';
import type { Board, End, PlacedTile, Seat } from './types';

export interface BoardEnds {
	readonly left: Pip;
	readonly right: Pip;
}

export function isBoardEmpty(board: Board): boolean {
	return board.length === 0;
}

/** The two playable numbers, or `null` while the board is empty. */
export function boardEnds(board: Board): BoardEnds | null {
	if (board.length === 0) return null;
	return { left: board[0].left, right: board[board.length - 1].right };
}

/** The ends as a plain tuple, handy for logs and observations. */
export function endsTuple(board: Board): readonly [Pip, Pip] | null {
	const ends = boardEnds(board);
	return ends === null ? null : [ends.left, ends.right];
}

/** Can `t` legally go on `end`? An empty board accepts anything. */
export function canPlace(board: Board, t: Tile, end: End): boolean {
	const ends = boardEnds(board);
	if (ends === null) return true;
	return tileHasPip(t, end === 'left' ? ends.left : ends.right);
}

/**
 * Places a tile and returns the new board. The caller is responsible for having checked
 * that it is this seat's turn; this function only enforces the physical fit.
 */
export function place(board: Board, t: Tile, end: End, seat: Seat): Board {
	if (board.length === 0) {
		const opening: PlacedTile = { tile: t, left: t.a, right: t.b, seat, end: 'opening' };
		return [opening];
	}

	const ends = boardEnds(board) as BoardEnds;

	if (end === 'left') {
		if (!tileHasPip(t, ends.left)) {
			fail('ILLEGAL_PLACEMENT', `${tileId(t)} does not fit the left end (${ends.left})`);
		}
		const placed: PlacedTile = {
			tile: t,
			left: otherPip(t, ends.left),
			right: ends.left,
			seat,
			end,
		};
		return [placed, ...board];
	}

	if (!tileHasPip(t, ends.right)) {
		fail('ILLEGAL_PLACEMENT', `${tileId(t)} does not fit the right end (${ends.right})`);
	}
	const placed: PlacedTile = {
		tile: t,
		left: ends.right,
		right: otherPip(t, ends.right),
		seat,
		end,
	};
	return [...board, placed];
}

/** Tiles on the table, in board order, without orientation. */
export function boardTiles(board: Board): Tile[] {
	return board.map((placed) => placed.tile);
}

/** How many tiles of each suit are already face up. Index by pip. */
export function suitCountsOnBoard(board: Board): number[] {
	const counts = [0, 0, 0, 0, 0, 0, 0];
	for (const placed of board) {
		counts[placed.tile.a] += 1;
		if (placed.tile.a !== placed.tile.b) {
			counts[placed.tile.b] += 1;
		}
	}
	return counts;
}

/** `[3|6][6|6][6|1]` — the chain as it reads on the table. */
export function formatBoard(board: Board): string {
	if (board.length === 0) return '(empty table)';
	return board.map((placed) => `[${placed.left}|${placed.right}]`).join('');
}

/**
 * Sanity check used by the tests and by deserialization: the chain must actually connect.
 */
export function isChainConsistent(board: Board): boolean {
	for (let i = 0; i < board.length; i++) {
		const placed = board[i];
		const pips = [placed.left, placed.right].sort();
		const tilePips = [placed.tile.a, placed.tile.b].sort();
		if (pips[0] !== tilePips[0] || pips[1] !== tilePips[1]) return false;
		if (i > 0 && board[i - 1].right !== placed.left) return false;
	}
	return true;
}
