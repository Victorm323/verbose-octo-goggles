/**
 * Shared building blocks for the bots.
 */

import {
	boardEnds,
	countSuit,
	place,
	tileHasPip,
	tilesEqual,
	type Board,
	type BoardEnds,
	type Observation,
	type Pip,
	type PlayMove,
	type Seat,
	type Tile,
} from '../engine';

/** The open ends the table would show after `move` is played. */
export function endsAfter(board: Board, move: PlayMove): BoardEnds {
	return boardEnds(place(board, move.tile, move.end, move.seat)) as BoardEnds;
}

/** How many of the observer's *remaining* tiles would match the given ends. */
export function matchesInHand(observation: Observation, played: Tile, ends: BoardEnds): number {
	let count = 0;
	for (const t of observation.hand) {
		if (tilesEqual(t, played)) continue;
		if (tileHasPip(t, ends.left)) count += 1;
		if (ends.left !== ends.right && tileHasPip(t, ends.right)) count += 1;
	}
	return count;
}

/** Would the observer still have a play if the table came back showing these ends? */
export function couldStillPlay(observation: Observation, played: Tile, ends: BoardEnds): boolean {
	return observation.hand.some(
		(t) => !tilesEqual(t, played) && (tileHasPip(t, ends.left) || tileHasPip(t, ends.right)),
	);
}

/** Is `seat` provably unable to play against these ends, from the passes so far? */
export function isStuck(observation: Observation, seat: Seat, ends: BoardEnds): boolean {
	return observation.knownVoids[seat][ends.left] && observation.knownVoids[seat][ends.right];
}

/**
 * Tiles still unseen that would match these ends.
 *
 * The lower this is, the closer the table is to a tranca, and the more likely the next
 * player has to pass.
 */
export function unseenMatching(observation: Observation, ends: BoardEnds): number {
	// `unseen` already excludes the observer's own tiles, so the tile about to be played
	// is not in this pool.
	const pool = observation.unseen;
	const left = countSuit(pool, ends.left);
	if (ends.left === ends.right) return left;
	const both = pool.filter((t) => tileHasPip(t, ends.left) && tileHasPip(t, ends.right)).length;
	return left + countSuit(pool, ends.right) - both;
}

/** Suit the observer is longest in, which is the suit worth steering the table towards. */
export function longestSuit(observation: Observation): Pip {
	let best: Pip = 0;
	for (let pip = 1; pip <= 6; pip++) {
		if (observation.suitsInHand[pip] > observation.suitsInHand[best]) {
			best = pip as Pip;
		}
	}
	return best;
}

/** All items tied for the highest score. Ties are broken by the caller, with the RNG. */
export function bestScoring<T>(items: readonly T[], score: (item: T) => number): T[] {
	let best = -Infinity;
	let winners: T[] = [];

	for (const item of items) {
		const value = score(item);
		if (value > best + 1e-9) {
			best = value;
			winners = [item];
		} else if (Math.abs(value - best) <= 1e-9) {
			winners.push(item);
		}
	}

	return winners;
}
