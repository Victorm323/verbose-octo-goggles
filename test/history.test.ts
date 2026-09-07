/**
 * The match keeps every hand it has played, moves included.
 *
 * The tiles are gathered up and redealt between hands, so `hand.log` only ever describes
 * the hand currently on the table. Without `state.history` a finished match would be a
 * scoreboard with no record of how it got there.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
	advance,
	applyMove,
	createMatch,
	deserializeMatch,
	handResults,
	legalMoves,
	serializeMatch,
	sumPips,
	tileId,
	type MatchState,
} from '../src/engine';
import { playMatch, seatingFromNames } from '../src/bots';

const SEATING = seatingFromNames(['strategic', 'greedy', 'strategic', 'greedy']);

function playOneHand(state: MatchState): MatchState {
	let current = state;
	while (current.hand.status === 'playing') {
		current = applyMove(current, legalMoves(current)[0]);
	}
	return current;
}

describe('match history', () => {
	it('starts empty', () => {
		assert.deepEqual(createMatch({ seed: 1 }).history, []);
	});

	it('records the hand as it is settled, moves and all', () => {
		const settled = playOneHand(createMatch({ seed: 3, rules: { targetScore: 1000 } }));
		const [record] = settled.history;

		assert.equal(settled.history.length, 1);
		assert.equal(record.handNumber, 1);
		assert.equal(record.starter, settled.hand.starter);
		assert.deepEqual(record.result, settled.hand.result);
		assert.deepEqual(record.log, settled.hand.log);
		assert.ok(record.log.length > 0);
	});

	it('keeps the moves after the tiles have been swept up', () => {
		const settled = playOneHand(createMatch({ seed: 3, rules: { targetScore: 1000 } }));
		const plies = settled.hand.log.length;
		const next = advance(settled);

		assert.equal(next.hand.log.length, 0, 'the new hand starts with a clean table');
		assert.equal(next.history.length, 1, 'but the old one is still on the books');
		assert.equal(next.history[0].log.length, plies);
	});

	it('records what each seat was left holding', () => {
		const settled = playOneHand(createMatch({ seed: 8, rules: { targetScore: 1000 } }));
		const record = settled.history[0];

		assert.deepEqual(
			record.finalHands.map((tiles) => tiles.map(tileId)),
			settled.hand.hands.map((tiles) => tiles.map(tileId)),
		);
		assert.deepEqual(
			record.finalHands.map((tiles) => sumPips(tiles)),
			[...record.result.pipsBySeat],
			'the tiles left over are worth exactly what the hand was scored on',
		);
	});

	it('grows by one hand per hand, in order', () => {
		const { state } = playMatch({ seating: SEATING, seed: 12, rules: { targetScore: 200 } });

		assert.ok(state.history.length > 1);
		state.history.forEach((record, index) => {
			assert.equal(record.handNumber, index + 1);
		});
	});

	it('lets a finished match be replayed move by move', () => {
		const { state } = playMatch({ seating: SEATING, seed: 12, rules: { targetScore: 200 } });

		for (const record of state.history) {
			const seats = record.log.map((entry) => entry.seat);
			assert.equal(seats[0], record.starter, 'the log opens with the seat that led');

			// Turns run in seat order, and every ply is either a play or a pass.
			for (let i = 1; i < seats.length; i++) {
				assert.equal(seats[i], (seats[i - 1] + 1) % 4, `hand ${record.handNumber}, ply ${i}`);
			}
			assert.ok(record.log.every((entry) => entry.type === 'play' || entry.type === 'pass'));
		}
	});

	it('agrees with the scoreboard', () => {
		const { state, summary } = playMatch({
			seating: SEATING,
			seed: 40,
			rules: { targetScore: 150 },
		});
		const results = handResults(state);

		assert.equal(results.length, state.history.length);
		assert.equal(summary.hands, state.history.length);
		assert.deepEqual(
			results,
			state.history.map((record) => record.result),
		);
	});

	it('survives serialization', () => {
		const { state } = playMatch({ seating: SEATING, seed: 40, rules: { targetScore: 150 } });
		const resumed = deserializeMatch(serializeMatch(state));

		assert.deepEqual(resumed.history, state.history);
		assert.deepEqual(resumed, state);
	});

	it('reads state written before history existed as an empty history', () => {
		const wire = JSON.parse(JSON.stringify(serializeMatch(createMatch({ seed: 1 })))) as Record<
			string,
			unknown
		>;
		delete wire.history;

		assert.deepEqual(deserializeMatch(wire).history, []);
	});

	it('refuses a history that is not an array', () => {
		const wire = JSON.parse(JSON.stringify(serializeMatch(createMatch({ seed: 1 })))) as Record<
			string,
			unknown
		>;
		assert.throws(() => deserializeMatch({ ...wire, history: 'nope' }));
	});
});
