/**
 * "Suelta lo pesado" — shed the heaviest tile you can, and get rid of doubles early.
 *
 * No reading of the table beyond its own hand. It is a genuine step above random because
 * pips left in hand are exactly what a lost hand costs, but it is blind to blocking.
 */

import {
	formatTile,
	isDouble,
	pick,
	tileValue,
	type Move,
	type Observation,
	type PlayMove,
	type RngState,
} from '../engine';
import type { Bot, BotDecision } from './types';
import { bestScoring, endsAfter, matchesInHand } from './heuristics';

export const greedyBot: Bot = {
	name: 'greedy',
	decide(observation: Observation, rng: RngState): BotDecision {
		const moves = observation.legalMoves;
		if (moves.length === 1) {
			return { move: moves[0], rng, reason: 'only legal move' };
		}

		const scored = bestScoring(moves, (move) => score(move, observation));
		const drawn = pick(scored, rng);
		const move = drawn.value;

		return {
			move,
			rng: drawn.state,
			reason:
				move.type === 'play'
					? `sheds ${formatTile(move.tile)} (${tileValue(move.tile)} pips)`
					: 'no tile fits',
		};
	},
};

function score(move: Move, observation: Observation): number {
	if (move.type === 'pass') return 0;

	const play = move as PlayMove;
	let value = tileValue(play.tile);
	if (isDouble(play.tile)) value += 2;

	// Between two ways of playing the same tile, keep the end that suits the rest of the
	// hand — free information, no table reading required.
	const ends = endsAfter(observation.board, play);
	value += 0.25 * matchesInHand(observation, play.tile, ends);

	return value;
}
