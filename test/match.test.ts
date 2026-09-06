import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
	advance,
	applyMove,
	containsTile,
	createMatch,
	DOUBLE_SIX,
	DominoEngine,
	EngineError,
	isHandOver,
	isMatchOver,
	legalMoves,
	startNextHand,
	summarize,
	sumPips,
	tileId,
} from '../src/engine';
import { playMatch, seatingFromNames } from '../src/bots';

const SEATING = seatingFromNames(['strategic', 'greedy', 'strategic', 'greedy']);

describe('creating a match', () => {
	it('deals 28 tiles into four hands of seven', () => {
		const state = createMatch({ seed: 'apertura' });
		const ids = state.hand.hands.flatMap((tiles) => tiles.map(tileId));

		assert.equal(new Set(ids).size, 28);
		assert.equal(sumPips(state.hand.hands.flat()), 168);
		assert.deepEqual(state.scores, [0, 0]);
		assert.equal(state.handNumber, 1);
		assert.equal(state.status, 'playing');
	});

	it('starts the first hand with the holder of the double six', () => {
		for (const seed of ['a', 'b', 'c', 'd', 'e']) {
			const state = createMatch({ seed });
			assert.ok(containsTile(state.hand.hands[state.hand.starter], DOUBLE_SIX));
			assert.deepEqual(state.hand.mustOpenWith, DOUBLE_SIX);
			assert.equal(state.hand.turn, state.hand.starter);
		}
	});

	it('is reproducible from its seed', () => {
		const a = createMatch({ seed: 'domingo' });
		const b = createMatch({ seed: 'domingo' });
		assert.deepEqual(
			a.hand.hands.map((tiles) => tiles.map(tileId)),
			b.hand.hands.map((tiles) => tiles.map(tileId)),
		);
	});

	it('rejects nonsense house rules', () => {
		assert.throws(
			() => createMatch({ rules: { targetScore: 0 } }),
			(error: unknown) => error instanceof EngineError && error.code === 'INVALID_CONFIG',
		);
		assert.throws(
			() => createMatch({ rules: { handSize: 9 } }),
			(error: unknown) => error instanceof EngineError && error.code === 'INVALID_CONFIG',
		);
	});
});

describe('running a match', () => {
	it('scores the hand and deals the next one', () => {
		let state = createMatch({ seed: 41, rules: { targetScore: 1000 } });

		while (!isHandOver(state)) {
			state = applyMove(state, legalMoves(state)[0]);
		}

		const result = state.results[0];
		assert.ok(result !== undefined);
		assert.equal(state.results.length, 1);
		if (result.winningTeam !== null) {
			assert.equal(state.scores[result.winningTeam], result.points);
		}

		const next = startNextHand(state);
		assert.equal(next.handNumber, 2);
		assert.equal(next.hand.starter, result.nextStarter);
		assert.equal(next.hand.mustOpenWith, null, 'only the first hand has a forced lead');
		assert.equal(sumPips(next.hand.hands.flat()), 168, 'the tiles are gathered up and redealt');
	});

	it('will not deal the next hand while one is still being played', () => {
		const state = createMatch({ seed: 41 });
		assert.throws(
			() => startNextHand(state),
			(error: unknown) => error instanceof EngineError && error.code === 'HAND_IN_PROGRESS',
		);
	});

	it('stops once a team reaches the target', () => {
		const { state, summary } = playMatch({
			seating: SEATING,
			seed: 12,
			rules: { targetScore: 100 },
		});

		assert.ok(isMatchOver(state));
		assert.ok(summary.winner !== null);
		assert.ok(state.scores[summary.winner as 0 | 1] >= 100);
		assert.equal(state.results.length, summary.hands);
		assert.throws(
			() => applyMove(state, { type: 'pass', seat: state.hand.turn }),
			(error: unknown) => error instanceof EngineError && error.code === 'MATCH_FINISHED',
		);
	});

	it('adds up: the running score is the sum of the hands won', () => {
		const { state } = playMatch({ seating: SEATING, seed: 99, rules: { targetScore: 150 } });
		const totals: [number, number] = [0, 0];
		for (const result of state.results) {
			if (result.winningTeam !== null) totals[result.winningTeam] += result.points;
		}
		assert.deepEqual([...state.scores], totals);
	});

	it('leaves a finished match alone when asked to advance', () => {
		const { state } = playMatch({ seating: SEATING, seed: 5, rules: { targetScore: 60 } });
		assert.deepEqual(advance(state), state);
	});

	it('calls a shutout a pollona', () => {
		const summary = summarize({
			...createMatch({ seed: 1, rules: { targetScore: 200 } }),
			scores: [200, 0],
			status: 'finished',
			winner: 0,
		});
		assert.equal(summary.shutout, true);
		assert.equal(summary.zapato, true, 'a shutout is under half the target too');
	});

	it('calls a beating under half the target a zapato', () => {
		const summary = summarize({
			...createMatch({ seed: 1, rules: { targetScore: 200 } }),
			scores: [200, 40],
			status: 'finished',
			winner: 0,
		});
		assert.equal(summary.shutout, false);
		assert.equal(summary.zapato, true);
	});

	it('calls a close match neither', () => {
		const summary = summarize({
			...createMatch({ seed: 1, rules: { targetScore: 200 } }),
			scores: [200, 175],
			status: 'finished',
			winner: 0,
		});
		assert.equal(summary.shutout, false);
		assert.equal(summary.zapato, false);
	});
});

describe('the DominoEngine facade', () => {
	it('deals the next hand for you and reports what happened', () => {
		const engine = new DominoEngine({ seed: 21, rules: { targetScore: 60 } });

		while (!engine.isOver) {
			engine.play(engine.legalMoves()[0]);
		}

		const events = engine.drainEvents();
		assert.ok(events.some((event) => event.type === 'hand-finished'));
		assert.ok(events.some((event) => event.type === 'match-finished'));
		assert.equal(events.filter((event) => event.type === 'match-finished').length, 1);
		assert.ok(engine.winner !== null);
	});

	it('waits for you when auto-advance is off', () => {
		const engine = new DominoEngine({ seed: 21, rules: { targetScore: 1000 }, autoAdvance: false });

		while (engine.state.hand.status === 'playing') {
			engine.play(engine.legalMoves()[0]);
		}

		assert.equal(engine.state.hand.handNumber, 1, 'the settled hand is still on the table');
		engine.advance();
		assert.equal(engine.state.hand.handNumber, 2);
	});

	it('only shows a seat its own tiles', () => {
		const engine = new DominoEngine({ seed: 21 });
		const view = engine.observation(1);

		assert.equal(view.hand.length, 7);
		assert.deepEqual([...view.tileCounts], [7, 7, 7, 7]);
		assert.equal(view.unseen.length, 21, 'the other three hands are pooled and unidentified');
		assert.equal(view.partner, 3);
		assert.equal(view.team, 1);
	});
});
