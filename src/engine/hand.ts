/**
 * The life of a single hand ("mano"): deal, play, settle.
 */

import { endsTuple, place } from './board';
import type { RuleConfig } from './config';
import { fail } from './errors';
import { shuffle, type RngState } from './rng';
import { assertMoveLegal, isCapicua, legalMovesFor, legalPlays } from './rules';
import { settleDomino, settleTranca, type Hands } from './scoring';
import { fullSet, removeTile, type Pip, type Tile } from './tiles';
import {
	nextSeat,
	type HandState,
	type Move,
	type MoveRecord,
	type PlayMove,
	type Seat,
} from './types';

/** Shuffles the double-six set and deals `handSize` tiles to each of the four seats. */
export function dealHands(rng: RngState, handSize: number): { hands: Hands; rng: RngState } {
	const shuffled = shuffle(fullSet(), rng);
	const tiles = shuffled.value;

	const dealt: Tile[][] = [[], [], [], []];
	for (let i = 0; i < handSize * 4; i++) {
		dealt[i % 4].push(tiles[i]);
	}

	return {
		hands: [dealt[0], dealt[1], dealt[2], dealt[3]],
		rng: shuffled.state,
	};
}

export interface CreateHandParams {
	readonly handNumber: number;
	readonly hands: Hands;
	readonly starter: Seat;
	/** Tile the starter is obliged to lead with, if the opening rule imposes one. */
	readonly mustOpenWith?: Tile | null;
}

export function createHand(params: CreateHandParams): HandState {
	return {
		handNumber: params.handNumber,
		starter: params.starter,
		turn: params.starter,
		hands: params.hands,
		board: [],
		log: [],
		consecutivePasses: 0,
		status: 'playing',
		result: null,
		mustOpenWith: params.mustOpenWith ?? null,
	};
}

/** The obligation to lead a particular tile only binds the starter on an empty table. */
function openingConstraint(hand: HandState, seat: Seat): Tile | null {
	if (hand.board.length > 0) return null;
	if (seat !== hand.starter) return null;
	return hand.mustOpenWith;
}

export function legalHandMoves(hand: HandState): Move[] {
	if (hand.status === 'finished') return [];
	return legalMovesFor(
		hand.board,
		hand.hands[hand.turn],
		hand.turn,
		openingConstraint(hand, hand.turn),
	);
}

/** Whether the seat to play has anything to put down; a pass is legal only when it does not. */
export function turnMustPass(hand: HandState): boolean {
	if (hand.status === 'finished') return false;
	return (
		legalPlays(hand.board, hand.hands[hand.turn], hand.turn, openingConstraint(hand, hand.turn))
			.length === 0
	);
}

/** Seat that last put a tile on the table — the one that locks a blocked game. */
function lastPlayingSeat(log: readonly MoveRecord[], fallback: Seat): Seat {
	for (let i = log.length - 1; i >= 0; i--) {
		if (log[i].type === 'play') return log[i].seat;
	}
	return fallback;
}

/**
 * Applies one move and returns the resulting hand state. The input is never mutated.
 *
 * Throws an `EngineError` when the move is out of turn, illegal, or the hand is over.
 */
export function applyHandMove(hand: HandState, move: Move, rules: RuleConfig): HandState {
	if (hand.status === 'finished') {
		fail('HAND_FINISHED', 'this hand has already been settled');
	}
	if (move.seat !== hand.turn) {
		fail('NOT_YOUR_TURN', `it is seat ${hand.turn}'s turn, not seat ${move.seat}'s`);
	}

	const constraint = openingConstraint(hand, move.seat);
	assertMoveLegal(hand.board, hand.hands[move.seat], move, constraint);

	const endsBefore = endsTuple(hand.board);

	if (move.type === 'pass') {
		const consecutivePasses = hand.consecutivePasses + 1;
		const record: MoveRecord = {
			ply: hand.log.length,
			seat: move.seat,
			type: 'pass',
			tile: null,
			end: null,
			endsBefore,
			endsAfter: endsBefore,
		};
		const log = [...hand.log, record];

		if (consecutivePasses >= 4) {
			const blockingSeat = lastPlayingSeat(log, hand.starter);
			return {
				...hand,
				log,
				consecutivePasses,
				status: 'finished',
				result: settleTranca({
					handNumber: hand.handNumber,
					hands: hand.hands,
					blockingSeat,
					starter: hand.starter,
					rules,
				}),
			};
		}

		return { ...hand, log, consecutivePasses, turn: nextSeat(hand.turn) };
	}

	return applyPlay(hand, move, rules, endsBefore);
}

function applyPlay(
	hand: HandState,
	move: PlayMove,
	rules: RuleConfig,
	endsBefore: readonly [Pip, Pip] | null,
): HandState {
	const seat = move.seat;
	const remaining = removeTile(hand.hands[seat], move.tile);
	const board = place(hand.board, move.tile, move.end, seat);

	const hands: Hands = [
		seat === 0 ? remaining : hand.hands[0],
		seat === 1 ? remaining : hand.hands[1],
		seat === 2 ? remaining : hand.hands[2],
		seat === 3 ? remaining : hand.hands[3],
	];

	const record: MoveRecord = {
		ply: hand.log.length,
		seat,
		type: 'play',
		tile: move.tile,
		end: hand.board.length === 0 ? 'opening' : move.end,
		endsBefore,
		endsAfter: endsTuple(board),
	};
	const log = [...hand.log, record];

	if (remaining.length === 0) {
		const capicua = isCapicua(hand.board, move.tile, rules);
		return {
			...hand,
			hands,
			board,
			log,
			consecutivePasses: 0,
			status: 'finished',
			result: settleDomino({
				handNumber: hand.handNumber,
				hands,
				closingSeat: seat,
				capicua,
				rules,
			}),
		};
	}

	return {
		...hand,
		hands,
		board,
		log,
		consecutivePasses: 0,
		turn: nextSeat(seat),
	};
}
