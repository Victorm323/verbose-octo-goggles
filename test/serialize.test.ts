import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
	applyMove,
	createMatch,
	deserializeMatch,
	deserializeMove,
	EngineError,
	fromJson,
	legalMoves,
	serializeMatch,
	serializeMove,
	toJson,
	type MatchState,
} from '../src/engine';
import { playMatch, seatingFromNames } from '../src/bots';

const SEATING = seatingFromNames(['strategic', 'greedy', 'strategic', 'greedy']);

function midMatch(seed: number): MatchState {
	let state = createMatch({ seed, rules: { targetScore: 1000 } });
	for (let i = 0; i < 12; i++) {
		const moves = legalMoves(state);
		if (moves.length === 0) break;
		state = applyMove(state, moves[0]);
	}
	return state;
}

describe('serialization', () => {
	it('round-trips a fresh match unchanged', () => {
		const state = createMatch({ seed: 'guardar' });
		assert.deepEqual(deserializeMatch(serializeMatch(state)), state);
	});

	it('round-trips a match in progress unchanged', () => {
		const state = midMatch(17);
		assert.deepEqual(deserializeMatch(serializeMatch(state)), state);
	});

	it('round-trips a finished match unchanged', () => {
		const { state } = playMatch({ seating: SEATING, seed: 4, rules: { targetScore: 60 } });
		assert.deepEqual(deserializeMatch(serializeMatch(state)), state);
	});

	it('survives a trip through JSON text', () => {
		const state = midMatch(23);
		assert.deepEqual(fromJson(toJson(state)), state);
	});

	it('carries tiles as ids, so the payload stays readable', () => {
		const wire = serializeMatch(createMatch({ seed: 1 }));
		assert.equal(wire.version, 1);
		assert.ok(wire.hand.hands[0].every((id) => /^[0-6]\|[0-6]$/.test(id)));
	});

	it('resumes play exactly where it left off', () => {
		const before = midMatch(31);
		const resumed = deserializeMatch(serializeMatch(before));

		const move = legalMoves(resumed)[0];
		assert.deepEqual(applyMove(resumed, move), applyMove(before, move));
	});

	it('reads tiles written either as ids or as objects', () => {
		const wire = serializeMatch(createMatch({ seed: 1 })) as unknown as Record<string, unknown>;
		const asObjects = JSON.parse(JSON.stringify(wire)) as ReturnType<typeof serializeMatch>;
		const loose = {
			...asObjects,
			hand: {
				...asObjects.hand,
				hands: asObjects.hand.hands.map((tiles) =>
					tiles.map((id) => {
						const [a, b] = id.split('|').map(Number);
						return { a, b };
					}),
				),
			},
		};
		assert.doesNotThrow(() => deserializeMatch(loose));
	});
});

describe('serialization rejects bad state', () => {
	it('refuses a hand holding the same tile twice', () => {
		const wire = serializeMatch(createMatch({ seed: 1 }));
		const doubled = JSON.parse(JSON.stringify(wire));
		doubled.hand.hands[1][0] = doubled.hand.hands[0][0];

		assert.throws(
			() => deserializeMatch(doubled),
			(error: unknown) => error instanceof EngineError && error.code === 'MALFORMED_STATE',
		);
	});

	it('refuses a board whose chain does not connect', () => {
		const wire = serializeMatch(midMatch(9));
		const broken = JSON.parse(JSON.stringify(wire));
		broken.hand.board[0].left = broken.hand.board[0].left === 6 ? 5 : 6;

		assert.throws(
			() => deserializeMatch(broken),
			(error: unknown) => error instanceof EngineError && error.code === 'MALFORMED_STATE',
		);
	});

	it('refuses a pip outside the set', () => {
		const wire = serializeMatch(createMatch({ seed: 1 }));
		const broken = JSON.parse(JSON.stringify(wire));
		broken.hand.hands[0][0] = '9|1';

		assert.throws(
			() => deserializeMatch(broken),
			(error: unknown) => error instanceof EngineError,
		);
	});

	it('refuses a seat that does not exist', () => {
		const wire = serializeMatch(createMatch({ seed: 1 }));
		const broken = JSON.parse(JSON.stringify(wire));
		broken.hand.turn = 7;

		assert.throws(
			() => deserializeMatch(broken),
			(error: unknown) => error instanceof EngineError && error.code === 'MALFORMED_STATE',
		);
	});

	it('refuses state written by a newer engine', () => {
		const wire = serializeMatch(createMatch({ seed: 1 }));
		assert.throws(
			() => deserializeMatch({ ...wire, version: 99 }),
			(error: unknown) => error instanceof EngineError && error.code === 'MALFORMED_STATE',
		);
	});

	it('refuses something that is not a match at all', () => {
		assert.throws(
			() => deserializeMatch(null),
			(error: unknown) => error instanceof EngineError,
		);
		assert.throws(
			() => deserializeMatch('nope'),
			(error: unknown) => error instanceof EngineError,
		);
		assert.throws(
			() => deserializeMatch({}),
			(error: unknown) => error instanceof EngineError,
		);
	});
});

describe('moves on the wire', () => {
	it('round-trips a play', () => {
		const move = { type: 'play', seat: 2, tile: { a: 6, b: 5 }, end: 'right' } as const;
		assert.deepEqual(serializeMove(move), { type: 'play', seat: 2, tile: '6|5', end: 'right' });
		assert.deepEqual(deserializeMove(serializeMove(move)), move);
	});

	it('round-trips a pass', () => {
		const move = { type: 'pass', seat: 1 } as const;
		assert.deepEqual(serializeMove(move), { type: 'pass', seat: 1 });
		assert.deepEqual(deserializeMove(serializeMove(move)), move);
	});

	it('accepts a tile written either way round', () => {
		const asId = deserializeMove({ type: 'play', seat: 0, tile: '5|6', end: 'left' });
		assert.deepEqual(asId, { type: 'play', seat: 0, tile: { a: 6, b: 5 }, end: 'left' });
	});

	it('refuses a move it cannot read', () => {
		assert.throws(
			() => deserializeMove({ type: 'shuffle', seat: 0 }),
			(error: unknown) => error instanceof EngineError && error.code === 'MALFORMED_STATE',
		);
		assert.throws(
			() => deserializeMove({ type: 'pass', seat: 9 }),
			(error: unknown) => error instanceof EngineError && error.code === 'MALFORMED_STATE',
		);
	});
});
