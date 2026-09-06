import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
	advance,
	applyMove,
	createRng,
	createMatch,
	legalMoves,
	observationFor,
	serializeMove,
	type Move,
} from '../src/engine';
import {
	BOTS,
	botByName,
	botMove,
	playMatch,
	runTournament,
	seatingFromNames,
	strategicBot,
} from '../src/bots';
import { table } from './helpers';

const NAMES = ['random', 'greedy', 'strategic'] as const;

function isAmong(move: Move, moves: readonly Move[]): boolean {
	const wanted = JSON.stringify(serializeMove(move));
	return moves.some((candidate) => JSON.stringify(serializeMove(candidate)) === wanted);
}

describe('every bot', () => {
	for (const name of NAMES) {
		it(`${name} only ever returns a legal move, over a whole match`, () => {
			const seating = seatingFromNames([name, name, name, name]);
			let state = createMatch({ seed: `legal-${name}`, rules: { targetScore: 150 } });
			let rng = createRng(7);
			let plies = 0;

			while (state.status === 'playing' && plies < 5000) {
				if (state.hand.status === 'finished') {
					state = advance(state);
					continue;
				}

				const moves = legalMoves(state);
				const decision = botMove(state, seating, rng);
				assert.ok(isAmong(decision.move, moves), `${name} produced an illegal move`);
				assert.equal(decision.move.seat, state.hand.turn);

				rng = decision.rng;
				state = applyMove(state, decision.move);
				plies += 1;
			}

			assert.equal(state.status, 'finished', `${name} never finished the match`);
		});

		it(`${name} is deterministic for the same observation and rng`, () => {
			const state = createMatch({ seed: `determinism-${name}` });
			const observation = observationFor(state, state.hand.turn);
			const bot = botByName(name);

			const first = bot.decide(observation, createRng(3));
			const second = bot.decide(observation, createRng(3));
			assert.deepEqual(serializeMove(first.move), serializeMove(second.move));
			assert.deepEqual(first.rng, second.rng);
		});
	}

	it('is registered under its own name', () => {
		for (const name of NAMES) {
			assert.equal(BOTS[name].name, name);
		}
		assert.throws(() => botByName('genius'));
		assert.throws(() => seatingFromNames(['random', 'random']));
	});
});

describe('the strategic bot', () => {
	it('takes the tile that ends the hand', () => {
		// [6|1] closes; [6|4] would leave the hand alive but is heavier.
		const state = createMatch({ seed: 1 });
		const closing = {
			...state,
			hand: table({
				hands: [['6|1'], ['5|5', '2|2'], ['4|4'], ['3|3']],
				board: ['6|6'],
				turn: 0,
			}),
		};

		const decision = strategicBot.decide(observationFor(closing, 0), createRng(1));
		assert.equal(decision.move.type, 'play');
		assert.deepEqual(serializeMove(decision.move), {
			type: 'play',
			seat: 0,
			tile: '6|1',
			end: 'left',
		});
	});

	it('picks the end that leaves the next opponent unable to answer', () => {
		// The table shows 4 and 5. South can play [4|1] on the left, leaving 1 and 5, or
		// [5|1] on the right, leaving 4 and 1. West has already passed on 5 and 1, so only
		// the first of those forces another pass out of them.
		const base = createMatch({ seed: 1 });
		const state = {
			...base,
			hand: {
				...table({
					hands: [['4|1', '5|1', '6|6'], ['0|0', '2|2'], ['6|3'], ['3|1']],
					board: ['4|5'],
					turn: 0,
				}),
				log: [
					{
						ply: 0,
						seat: 1 as const,
						type: 'pass' as const,
						tile: null,
						end: null,
						endsBefore: [5, 1] as const,
						endsAfter: [5, 1] as const,
					},
				],
			},
		};

		const observation = observationFor(state, 0);
		assert.equal(observation.knownVoids[1][5], true);
		assert.equal(observation.knownVoids[1][1], true);
		assert.equal(observation.legalMoves.length, 2, 'there really is a choice to make');

		const decision = strategicBot.decide(observation, createRng(1));
		assert.deepEqual(serializeMove(decision.move), {
			type: 'play',
			seat: 0,
			tile: '4|1',
			end: 'left',
		});
	});
});

describe('bot strength', () => {
	it('beats random with greedy, and greedy with strategic', () => {
		const greedyVsRandom = runTournament(
			seatingFromNames(['greedy', 'random', 'greedy', 'random']),
			60,
			101,
			{ targetScore: 200 },
		);
		assert.ok(
			greedyVsRandom.winsByTeam[0] > greedyVsRandom.winsByTeam[1],
			`greedy should beat random, got ${greedyVsRandom.winsByTeam.join('-')}`,
		);

		const strategicVsGreedy = runTournament(
			seatingFromNames(['strategic', 'greedy', 'strategic', 'greedy']),
			60,
			202,
			{ targetScore: 200 },
		);
		assert.ok(
			strategicVsGreedy.winsByTeam[0] > strategicVsGreedy.winsByTeam[1],
			`strategic should beat greedy, got ${strategicVsGreedy.winsByTeam.join('-')}`,
		);
	});

	it('shows no seat bias when both sides play the same way', () => {
		const mirror = runTournament(
			seatingFromNames(['strategic', 'strategic', 'strategic', 'strategic']),
			120,
			303,
			{ targetScore: 200 },
		);
		const share = mirror.winsByTeam[0] / mirror.matches;
		assert.ok(share > 0.35 && share < 0.65, `expected a roughly even split, got ${share}`);
	});
});

describe('playouts', () => {
	it('always reaches a winner', () => {
		for (let seed = 1; seed <= 10; seed++) {
			const { state, summary } = playMatch({
				seating: seatingFromNames(['strategic', 'greedy', 'random', 'greedy']),
				seed,
				rules: { targetScore: 150 },
			});
			assert.equal(state.status, 'finished');
			assert.ok(summary.winner !== null);
			assert.ok(summary.hands >= 1);
		}
	});

	it('replays identically from the same seed', () => {
		const seating = seatingFromNames(['strategic', 'greedy', 'strategic', 'random']);
		const options = { seating, seed: 77, rules: { targetScore: 150 } };
		const a = playMatch(options);
		const b = playMatch(options);

		assert.deepEqual(a.state.scores, b.state.scores);
		assert.equal(a.plies, b.plies);
		assert.deepEqual(a.summary, b.summary);
	});
});
