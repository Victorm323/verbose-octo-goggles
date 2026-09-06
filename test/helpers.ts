/**
 * Shared fixtures. Hands and boards are built by hand here so that each test can put the
 * table in exactly the position it wants to check.
 */

import {
	createHand,
	place,
	resolveRules,
	tile,
	type Board,
	type HandState,
	type Pip,
	type RuleConfig,
	type RuleOverrides,
	type Seat,
	type Tile,
} from '../src/engine';
import type { Hands } from '../src/engine';

/** `t('6|5')` — terser than `tile(6, 5)` inside test tables. */
export function t(id: string): Tile {
	const [a, b] = id.split('|').map(Number);
	return tile(a, b);
}

export function hand(...ids: string[]): Tile[] {
	return ids.map(t);
}

export function rules(overrides: RuleOverrides = {}): RuleConfig {
	return resolveRules(overrides);
}

/**
 * Builds a chain from tile ids laid left to right, e.g. `chain(['3|1', '1|5'])`.
 *
 * The opening tile is oriented exactly as written rather than normalised, so `chain(['4|5'])`
 * really does leave a 4 on the left and a 5 on the right. Without that, a fixture reads one
 * way and the table faces the other.
 */
export function chain(ids: readonly string[], seat: Seat = 0): Board {
	if (ids.length === 0) return [];

	const [first, ...rest] = ids;
	const [left, right] = first.split('|').map(Number);
	let board: Board = [
		{ tile: t(first), left: left as Pip, right: right as Pip, seat, end: 'opening' },
	];

	for (const id of rest) {
		board = place(board, t(id), 'right', seat);
	}
	return board;
}

export interface TableOptions {
	readonly hands: readonly [string[], string[], string[], string[]];
	readonly board?: readonly string[];
	readonly turn?: Seat;
	readonly starter?: Seat;
	readonly handNumber?: number;
	readonly mustOpenWith?: string | null;
	readonly consecutivePasses?: number;
}

/** A `HandState` in an arbitrary position, for testing endings without playing 28 moves. */
export function table(options: TableOptions): HandState {
	const dealt: Hands = [
		hand(...options.hands[0]),
		hand(...options.hands[1]),
		hand(...options.hands[2]),
		hand(...options.hands[3]),
	];

	const base = createHand({
		handNumber: options.handNumber ?? 1,
		hands: dealt,
		starter: options.starter ?? 0,
		mustOpenWith:
			options.mustOpenWith === undefined || options.mustOpenWith === null
				? null
				: t(options.mustOpenWith),
	});

	return {
		...base,
		board: chain(options.board ?? []),
		turn: options.turn ?? options.starter ?? 0,
		consecutivePasses: options.consecutivePasses ?? 0,
	};
}
