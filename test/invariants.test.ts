/**
 * Properties that must hold for every position the engine can reach.
 *
 * These run over hundreds of bot-played matches, which is the cheapest way to reach the
 * awkward positions — long pass chains, trancas, hands that close on the last tile — that
 * a hand-written fixture would have to be built one at a time.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
	advance,
	applyMove,
	createMatch,
	createRng,
	deserializeMatch,
	hasLegalPlay,
	isChainConsistent,
	legalMoves,
	serializeMatch,
	sumPips,
	tileId,
	type MatchState,
} from '../src/engine';
import { botMove, seatingFromNames } from '../src/bots';

const SEATING = seatingFromNames(['strategic', 'greedy', 'random', 'strategic']);

/** Every tile is in exactly one place: a hand or the table. */
function assertTilesConserved(state: MatchState, where: string): void {
	const inHands = state.hand.hands.flatMap((tiles) => tiles.map(tileId));
	const onTable = state.hand.board.map((placed) => tileId(placed.tile));
	const all = [...inHands, ...onTable];

	assert.equal(all.length, 28, `${where}: expected 28 tiles, found ${all.length}`);
	assert.equal(new Set(all).size, 28, `${where}: a tile is in two places at once`);
	assert.equal(
		sumPips(state.hand.hands.flat()) + sumPips(state.hand.board.map((placed) => placed.tile)),
		168,
		`${where}: pips went missing`,
	);
}

function assertPositionSane(state: MatchState, where: string): void {
	assertTilesConserved(state, where);
	assert.ok(isChainConsistent(state.hand.board), `${where}: the chain does not connect`);
	assert.ok(state.hand.consecutivePasses < 4, `${where}: four passes should have ended the hand`);
	assert.deepEqual(
		[...state.scores],
		state.history.reduce(
			(totals, { result }) => {
				if (result.winningTeam !== null) totals[result.winningTeam] += result.points;
				return totals;
			},
			[0, 0] as [number, number],
		),
		`${where}: the scoreboard does not match the hands played`,
	);
}

describe('invariants across many matches', () => {
	it('holds through 120 bot-played matches', () => {
		let longestHand = 0;
		let trancas = 0;
		let capicuas = 0;

		for (let seed = 1; seed <= 120; seed++) {
			let state = createMatch({ seed, rules: { targetScore: 200 } });
			let rng = createRng(seed * 7 + 1);
			let plies = 0;

			while (state.status === 'playing') {
				assert.ok(plies < 5000, `seed ${seed}: the match is not making progress`);

				if (state.hand.status === 'finished') {
					state = advance(state);
					continue;
				}

				const where = `seed ${seed}, hand ${state.hand.handNumber}, ply ${plies}`;
				assertPositionSane(state, where);

				const moves = legalMoves(state);
				assert.ok(moves.length > 0, `${where}: no move available`);

				const seatHand = state.hand.hands[state.hand.turn];
				const constraint =
					state.hand.board.length === 0 && state.hand.turn === state.hand.starter
						? state.hand.mustOpenWith
						: null;
				const canPlay = hasLegalPlay(state.hand.board, seatHand, constraint);
				assert.equal(
					moves.some((move) => move.type === 'pass'),
					!canPlay,
					`${where}: a pass was offered alongside a playable tile`,
				);

				const decision = botMove(state, SEATING, rng);
				rng = decision.rng;
				state = applyMove(state, decision.move);
				plies += 1;

				const result = state.hand.result;
				if (result !== null) {
					longestHand = Math.max(longestHand, state.hand.log.length);
					if (result.outcome !== 'domino') trancas += 1;
					if (result.capicua) capicuas += 1;

					assert.ok(result.points >= 0, 'a hand cannot be worth negative points');
					if (result.outcome === 'domino') {
						assert.equal(
							state.hand.hands[result.closingSeat].length,
							0,
							'a dominó means the closing seat is empty',
						);
					}
					if (result.outcome === 'tie') {
						assert.equal(result.points, 0);
						assert.equal(result.winningTeam, null);
					}
				}
			}

			assert.ok(state.winner !== null, `seed ${seed}: the match ended without a winner`);
			assert.ok(
				state.scores[state.winner] >= 200,
				`seed ${seed}: the winner did not reach the target`,
			);
		}

		// The fuzz is only worth trusting if it actually reached the interesting endings.
		assert.ok(trancas > 0, 'no blocked hand occurred in 120 matches');
		assert.ok(capicuas > 0, 'no capicúa occurred in 120 matches');
		assert.ok(longestHand >= 20, 'no hand ran anywhere near its full length');
	});

	it('survives serialization at every ply of a match', () => {
		let state = createMatch({ seed: 'ida-y-vuelta', rules: { targetScore: 100 } });
		let rng = createRng(11);

		while (state.status === 'playing') {
			if (state.hand.status === 'finished') {
				state = advance(state);
				continue;
			}

			assert.deepEqual(
				deserializeMatch(serializeMatch(state)),
				state,
				`hand ${state.hand.handNumber}, ply ${state.hand.log.length}`,
			);

			const decision = botMove(state, SEATING, rng);
			rng = decision.rng;
			state = applyMove(state, decision.move);
		}

		assert.deepEqual(deserializeMatch(serializeMatch(state)), state);
	});
});
