/**
 * JSON round-tripping.
 *
 * A match can be suspended, stored and resumed. Tiles travel as their canonical ids, and
 * everything coming back in is validated before it is trusted — deserialisation is the
 * one place the engine accepts state it did not build itself.
 */

import { isChainConsistent } from './board';
import { resolveRules, type RuleConfig } from './config';
import { fail } from './errors';
import type { RngState } from './rng';
import { coerceTile, isPip, tileId, type Pip, type Tile, type TileId } from './tiles';
import {
	isSeat,
	type Board,
	type End,
	type HandResult,
	type HandState,
	type MatchState,
	type Move,
	type MoveRecord,
	type PlacedTile,
	type Seat,
} from './types';

export const SERIALIZATION_VERSION = 1;

export interface SerializedPlacedTile {
	readonly tile: TileId;
	readonly left: Pip;
	readonly right: Pip;
	readonly seat: Seat;
	readonly end: End | 'opening';
}

export interface SerializedMoveRecord {
	readonly ply: number;
	readonly seat: Seat;
	readonly type: Move['type'];
	readonly tile: TileId | null;
	readonly end: End | 'opening' | null;
	readonly endsBefore: readonly [Pip, Pip] | null;
	readonly endsAfter: readonly [Pip, Pip] | null;
}

export interface SerializedHand {
	readonly handNumber: number;
	readonly starter: Seat;
	readonly turn: Seat;
	readonly hands: readonly TileId[][];
	readonly board: readonly SerializedPlacedTile[];
	readonly log: readonly SerializedMoveRecord[];
	readonly consecutivePasses: number;
	readonly status: HandState['status'];
	readonly result: HandResult | null;
	readonly mustOpenWith: TileId | null;
}

export interface SerializedMatch {
	readonly version: number;
	readonly rules: RuleConfig;
	readonly rng: RngState;
	readonly scores: readonly [number, number];
	readonly handNumber: number;
	readonly hand: SerializedHand;
	readonly status: MatchState['status'];
	readonly winner: MatchState['winner'];
	readonly results: readonly HandResult[];
}

export function serializeMove(move: Move): Record<string, unknown> {
	return move.type === 'pass'
		? { type: 'pass', seat: move.seat }
		: { type: 'play', seat: move.seat, tile: tileId(move.tile), end: move.end };
}

export function deserializeMove(input: unknown): Move {
	const raw = asObject(input, 'move');
	const seat = asSeat(raw.seat, 'move.seat');

	if (raw.type === 'pass') {
		return { type: 'pass', seat };
	}
	if (raw.type !== 'play') {
		fail('MALFORMED_STATE', `unknown move type: ${JSON.stringify(raw.type)}`);
	}

	const end = raw.end === 'right' ? 'right' : 'left';
	return { type: 'play', seat, tile: coerceTile(raw.tile as Tile | TileId), end };
}

export function serializeMatch(state: MatchState): SerializedMatch {
	return {
		version: SERIALIZATION_VERSION,
		rules: state.rules,
		rng: state.rng,
		scores: [state.scores[0], state.scores[1]],
		handNumber: state.handNumber,
		hand: serializeHand(state.hand),
		status: state.status,
		winner: state.winner,
		results: state.results,
	};
}

function serializeHand(hand: HandState): SerializedHand {
	return {
		handNumber: hand.handNumber,
		starter: hand.starter,
		turn: hand.turn,
		hands: hand.hands.map((tiles) => tiles.map(tileId)),
		board: hand.board.map((placed) => ({
			tile: tileId(placed.tile),
			left: placed.left,
			right: placed.right,
			seat: placed.seat,
			end: placed.end,
		})),
		log: hand.log.map((record) => ({
			ply: record.ply,
			seat: record.seat,
			type: record.type,
			tile: record.tile === null ? null : tileId(record.tile),
			end: record.end,
			endsBefore: record.endsBefore,
			endsAfter: record.endsAfter,
		})),
		consecutivePasses: hand.consecutivePasses,
		status: hand.status,
		result: hand.result,
		mustOpenWith: hand.mustOpenWith === null ? null : tileId(hand.mustOpenWith),
	};
}

export function deserializeMatch(input: unknown): MatchState {
	const raw = asObject(input, 'match');

	if (typeof raw.version === 'number' && raw.version > SERIALIZATION_VERSION) {
		fail(
			'MALFORMED_STATE',
			`state version ${raw.version} is newer than this engine understands (${SERIALIZATION_VERSION})`,
		);
	}

	const rules = resolveRules((raw.rules ?? {}) as Partial<RuleConfig>);
	const rng = asRng(raw.rng);
	const scores = asScores(raw.scores);
	const hand = deserializeHand(raw.hand, rules);

	const status = raw.status === 'finished' ? 'finished' : 'playing';
	const winner = raw.winner === 0 || raw.winner === 1 ? raw.winner : null;

	return {
		rules,
		rng,
		scores,
		handNumber: asPositiveInt(raw.handNumber, 'match.handNumber'),
		hand,
		status,
		winner,
		results: Array.isArray(raw.results) ? (raw.results as HandResult[]) : [],
	};
}

function deserializeHand(input: unknown, rules: RuleConfig): HandState {
	const raw = asObject(input, 'hand');
	const handsRaw = raw.hands;

	if (!Array.isArray(handsRaw) || handsRaw.length !== 4) {
		fail('MALFORMED_STATE', 'hand.hands must be an array of four hands');
	}

	const hands = handsRaw.map((tiles, index) => {
		if (!Array.isArray(tiles)) {
			fail('MALFORMED_STATE', `hand.hands[${index}] must be an array`);
		}
		return tiles.map((t) => coerceTile(t as Tile | TileId));
	}) as [Tile[], Tile[], Tile[], Tile[]];

	const board = deserializeBoard(raw.board);
	if (!isChainConsistent(board)) {
		fail('MALFORMED_STATE', 'hand.board is not a connected chain');
	}

	assertTileConservation(hands, board, rules);

	const status = raw.status === 'finished' ? 'finished' : 'playing';

	return {
		handNumber: asPositiveInt(raw.handNumber, 'hand.handNumber'),
		starter: asSeat(raw.starter, 'hand.starter'),
		turn: asSeat(raw.turn, 'hand.turn'),
		hands,
		board,
		log: deserializeLog(raw.log),
		consecutivePasses: asCount(raw.consecutivePasses, 'hand.consecutivePasses'),
		status,
		result: (raw.result ?? null) as HandResult | null,
		mustOpenWith:
			raw.mustOpenWith === null || raw.mustOpenWith === undefined
				? null
				: coerceTile(raw.mustOpenWith as Tile | TileId),
	};
}

function deserializeBoard(input: unknown): Board {
	if (input === undefined || input === null) return [];
	if (!Array.isArray(input)) {
		fail('MALFORMED_STATE', 'hand.board must be an array');
	}

	return input.map((entry, index) => {
		const raw = asObject(entry, `hand.board[${index}]`);
		const end = raw.end === 'opening' ? 'opening' : raw.end === 'right' ? 'right' : 'left';
		const placed: PlacedTile = {
			tile: coerceTile(raw.tile as Tile | TileId),
			left: asPip(raw.left, `hand.board[${index}].left`),
			right: asPip(raw.right, `hand.board[${index}].right`),
			seat: asSeat(raw.seat, `hand.board[${index}].seat`),
			end,
		};
		return placed;
	});
}

function deserializeLog(input: unknown): MoveRecord[] {
	if (input === undefined || input === null) return [];
	if (!Array.isArray(input)) {
		fail('MALFORMED_STATE', 'hand.log must be an array');
	}

	return input.map((entry, index) => {
		const raw = asObject(entry, `hand.log[${index}]`);
		const type = raw.type === 'pass' ? 'pass' : 'play';
		const record: MoveRecord = {
			ply: asCount(raw.ply ?? index, `hand.log[${index}].ply`),
			seat: asSeat(raw.seat, `hand.log[${index}].seat`),
			type,
			tile:
				raw.tile === null || raw.tile === undefined ? null : coerceTile(raw.tile as Tile | TileId),
			end: (raw.end ?? null) as MoveRecord['end'],
			endsBefore: asEnds(raw.endsBefore, `hand.log[${index}].endsBefore`),
			endsAfter: asEnds(raw.endsAfter, `hand.log[${index}].endsAfter`),
		};
		return record;
	});
}

/**
 * Every tile is either in a hand or on the table, and never in two places at once.
 *
 * This is the invariant that catches hand-edited or truncated state before it can corrupt
 * a match, so it runs on every deserialisation.
 */
function assertTileConservation(
	hands: readonly (readonly Tile[])[],
	board: Board,
	rules: RuleConfig,
): void {
	const seen = new Set<string>();
	const claim = (t: Tile, where: string) => {
		const id = tileId(t);
		if (seen.has(id)) {
			fail('MALFORMED_STATE', `tile ${id} appears more than once (${where})`);
		}
		seen.add(id);
	};

	hands.forEach((tiles, seat) => tiles.forEach((t) => claim(t, `hand of seat ${seat}`)));
	board.forEach((placed) => claim(placed.tile, 'board'));

	const dealt = rules.handSize * 4;
	if (seen.size > dealt) {
		fail('MALFORMED_STATE', `state holds ${seen.size} tiles but only ${dealt} were dealt`);
	}
}

function asObject(value: unknown, where: string): Record<string, unknown> {
	if (value === null || typeof value !== 'object' || Array.isArray(value)) {
		fail('MALFORMED_STATE', `${where} must be an object`);
	}
	return value as Record<string, unknown>;
}

function asSeat(value: unknown, where: string): Seat {
	if (!isSeat(value)) {
		fail('MALFORMED_STATE', `${where} must be a seat 0-3, got ${JSON.stringify(value)}`);
	}
	return value;
}

function asPip(value: unknown, where: string): Pip {
	if (!isPip(value)) {
		fail('MALFORMED_STATE', `${where} must be a pip 0-6, got ${JSON.stringify(value)}`);
	}
	return value;
}

function asEnds(value: unknown, where: string): readonly [Pip, Pip] | null {
	if (value === null || value === undefined) return null;
	if (!Array.isArray(value) || value.length !== 2) {
		fail('MALFORMED_STATE', `${where} must be a pair of pips`);
	}
	return [asPip(value[0], `${where}[0]`), asPip(value[1], `${where}[1]`)];
}

function asCount(value: unknown, where: string): number {
	if (!Number.isInteger(value) || (value as number) < 0) {
		fail('MALFORMED_STATE', `${where} must be a non-negative integer`);
	}
	return value as number;
}

function asPositiveInt(value: unknown, where: string): number {
	if (!Number.isInteger(value) || (value as number) < 1) {
		fail('MALFORMED_STATE', `${where} must be a positive integer`);
	}
	return value as number;
}

function asScores(value: unknown): [number, number] {
	if (!Array.isArray(value) || value.length !== 2) {
		fail('MALFORMED_STATE', 'match.scores must be a pair of numbers');
	}
	const [a, b] = value;
	if (!Number.isFinite(a) || !Number.isFinite(b)) {
		fail('MALFORMED_STATE', 'match.scores must be a pair of numbers');
	}
	return [a as number, b as number];
}

function asRng(value: unknown): RngState {
	const raw = asObject(value, 'match.rng');
	if (!Number.isFinite(raw.seed) || !Number.isFinite(raw.cursor)) {
		fail('MALFORMED_STATE', 'match.rng must carry numeric seed and cursor');
	}
	return { seed: raw.seed as number, cursor: raw.cursor as number };
}

/** Convenience wrappers for callers that want to move state around as a string. */
export function toJson(state: MatchState): string {
	return JSON.stringify(serializeMatch(state));
}

export function fromJson(json: string): MatchState {
	return deserializeMatch(JSON.parse(json));
}
