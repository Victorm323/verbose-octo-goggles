/**
 * Seats, partnerships, moves and the shapes of hand/match state.
 *
 * Seats are numbered 0–3 **in playing order**. At a Dominican table play runs
 * counter-clockwise, so seat `n + 1` is the player to the right of seat `n`. Partners sit
 * across from each other, which makes the teams `{0, 2}` and `{1, 3}`.
 */

import type { Pip, Tile } from './tiles';
import type { RngState } from './rng';

export type Seat = 0 | 1 | 2 | 3;
export type TeamId = 0 | 1;

/** The two open ends of the chain. */
export type End = 'left' | 'right';

export const SEATS: readonly Seat[] = [0, 1, 2, 3];
export const ENDS: readonly End[] = ['left', 'right'];

export function isSeat(value: unknown): value is Seat {
	return value === 0 || value === 1 || value === 2 || value === 3;
}

/** Next seat in playing order. */
export function nextSeat(seat: Seat): Seat {
	return ((seat + 1) % 4) as Seat;
}

/** Team of a seat: seats 0 and 2 form team 0, seats 1 and 3 form team 1. */
export function teamOf(seat: Seat): TeamId {
	return (seat % 2) as TeamId;
}

export function partnerOf(seat: Seat): Seat {
	return ((seat + 2) % 4) as Seat;
}

export function opponentsOf(seat: Seat): [Seat, Seat] {
	return [nextSeat(seat), nextSeat(nextSeat(nextSeat(seat)))];
}

export function seatsOfTeam(team: TeamId): [Seat, Seat] {
	return team === 0 ? [0, 2] : [1, 3];
}

export function otherTeam(team: TeamId): TeamId {
	return team === 0 ? 1 : 0;
}

/** A tile as it sits on the table, oriented so that `right` touches the next tile. */
export interface PlacedTile {
	readonly tile: Tile;
	/** Pip facing the left end of the chain. */
	readonly left: Pip;
	/** Pip facing the right end of the chain. */
	readonly right: Pip;
	/** Who put it down. */
	readonly seat: Seat;
	/** Which end it was played on; the opening tile is `'opening'`. */
	readonly end: End | 'opening';
}

export type Board = readonly PlacedTile[];

export interface PlayMove {
	readonly type: 'play';
	readonly seat: Seat;
	readonly tile: Tile;
	/** Ignored for the opening tile, where the board has no ends yet. */
	readonly end: End;
}

export interface PassMove {
	readonly type: 'pass';
	readonly seat: Seat;
}

export type Move = PlayMove | PassMove;

/** One entry of the hand log — enough to replay or narrate the hand. */
export interface MoveRecord {
	readonly ply: number;
	readonly seat: Seat;
	readonly type: Move['type'];
	readonly tile: Tile | null;
	readonly end: End | 'opening' | null;
	/** The open ends *before* the move, which is what a pass tells you about a hand. */
	readonly endsBefore: readonly [Pip, Pip] | null;
	readonly endsAfter: readonly [Pip, Pip] | null;
}

export type HandOutcome = 'domino' | 'tranca' | 'tie';

export interface HandResult {
	readonly handNumber: number;
	readonly outcome: HandOutcome;
	/** `null` only for a tied tranca. */
	readonly winningTeam: TeamId | null;
	/** Seat that ended the hand: the one that went out, or the one that blocked it. */
	readonly closingSeat: Seat;
	/** Points awarded to `winningTeam`, capicúa bonus included. */
	readonly points: number;
	/** Points before the capicúa bonus was applied. */
	readonly pipPoints: number;
	readonly capicua: boolean;
	/** Pips left in each seat's hand when the hand ended. */
	readonly pipsBySeat: readonly [number, number, number, number];
	/** Pips left per team. */
	readonly pipsByTeam: readonly [number, number];
	/** Seat that leads the next hand. */
	readonly nextStarter: Seat;
}

export type HandStatus = 'playing' | 'finished';

export interface HandState {
	readonly handNumber: number;
	/** Seat that opened this hand. */
	readonly starter: Seat;
	readonly turn: Seat;
	readonly hands: readonly [readonly Tile[], readonly Tile[], readonly Tile[], readonly Tile[]];
	readonly board: Board;
	readonly log: readonly MoveRecord[];
	readonly consecutivePasses: number;
	readonly status: HandStatus;
	readonly result: HandResult | null;
	/** Tile the starter is obliged to open with, when the opening rule demands one. */
	readonly mustOpenWith: Tile | null;
}

/**
 * A hand that has been played out and swept up.
 *
 * The tiles are gathered and redealt between hands, so without this the move log of every
 * hand but the current one would be lost and a finished match would be unreviewable. Keeping
 * it means a whole match can be replayed, narrated or audited after the fact.
 */
export interface HandRecord {
	readonly handNumber: number;
	/** Seat that opened the hand. */
	readonly starter: Seat;
	readonly result: HandResult;
	/** Every move of the hand, in order. */
	readonly log: readonly MoveRecord[];
	/** Tiles each seat was still holding when the hand ended. */
	readonly finalHands: readonly [
		readonly Tile[],
		readonly Tile[],
		readonly Tile[],
		readonly Tile[],
	];
}

export type MatchStatus = 'playing' | 'finished';

export interface MatchState {
	readonly rules: import('./config').RuleConfig;
	readonly rng: RngState;
	readonly scores: readonly [number, number];
	readonly handNumber: number;
	readonly hand: HandState;
	readonly status: MatchStatus;
	readonly winner: TeamId | null;
	/** Every hand played so far, oldest first, with its moves. */
	readonly history: readonly HandRecord[];
}

export interface MatchSummary {
	readonly winner: TeamId | null;
	readonly scores: readonly [number, number];
	readonly hands: number;
	/** The losing team never scored — a *pollona*. */
	readonly shutout: boolean;
	/** The losing team stayed below half the target — a *zapato*. */
	readonly zapato: boolean;
}
