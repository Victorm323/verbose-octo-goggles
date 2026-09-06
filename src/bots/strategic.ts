/**
 * A bot that plays something close to how the game is actually played.
 *
 * It reads the table rather than just its own hand:
 *
 * - **Close when you can.** A tile that empties the hand ends the discussion, and a
 *   capicúa is worth taking over an ordinary close.
 * - **Control the ends.** Steer the table towards the numbers you are long in, so the
 *   hand keeps coming back to you playable.
 * - **Starve the opponents.** Every pass is public: once a seat has passed on a number
 *   they are out of it for the rest of the hand. Leaving both ends on numbers an opponent
 *   is void in forces another pass and walks the hand towards a tranca you are winning.
 * - **Do not bury your partner.** The same trick applied to the wrong seat costs the hand.
 * - **Shed weight.** Pips in hand are what a loss costs, so all else equal, play heavy.
 *
 * Everything is a weighted sum of features; ties are broken with the match RNG, so the
 * bot stays deterministic for a given seed.
 */

import {
	formatTile,
	isCapicua,
	isDouble,
	pick,
	sumPips,
	tileValue,
	teamOf,
	type BoardEnds,
	type Move,
	type Observation,
	type PlayMove,
	type RngState,
} from '../engine';
import {
	bestScoring,
	couldStillPlay,
	endsAfter,
	isStuck,
	matchesInHand,
	unseenMatching,
} from './heuristics';
import type { Bot, BotDecision } from './types';

/** Feature weights. Tuned by self-play; see `pnpm simulate`. */
const WEIGHTS = {
	winsHand: 10_000,
	capicua: 500,
	/** Per opponent forced to pass by the ends this move leaves. */
	stuckOpponent: 60,
	/** Per own tile that still matches an end afterwards. */
	control: 6,
	/** Applied when the move would leave the bot unable to play on its next turn. */
	selfBlocked: -35,
	/** Applied when the move provably locks the partner out. */
	partnerBlocked: -45,
	/** Per unseen tile that matches the ends — fewer means a tighter table. */
	openness: -1.5,
	/** Per pip shed. */
	weight: 1.2,
	/** Doubles are the hardest tiles to place; get them down while a slot exists. */
	double: 8,
	/** Extra pressure once an opponent is one tile from going out. */
	endgameUrgency: 40,
} as const;

export const strategicBot: Bot = {
	name: 'strategic',
	decide(observation: Observation, rng: RngState): BotDecision {
		const moves = observation.legalMoves;
		if (moves.length === 1) {
			return {
				move: moves[0],
				rng,
				reason: moves[0].type === 'pass' ? 'no tile fits' : 'only legal move',
			};
		}

		const scored = bestScoring(moves, (move) => scoreMove(move, observation));
		const drawn = pick(scored, rng);
		return { move: drawn.value, rng: drawn.state, reason: explain(drawn.value, observation) };
	},
};

export function scoreMove(move: Move, observation: Observation): number {
	if (move.type === 'pass') return 0;

	const play = move as PlayMove;
	const ends = endsAfter(observation.board, play);
	const isLastTile = observation.hand.length === 1;

	let score = 0;

	if (isLastTile) {
		score += WEIGHTS.winsHand;
		if (isCapicua(observation.board, play.tile, observation.rules)) {
			score += WEIGHTS.capicua;
		}
		return score;
	}

	score += WEIGHTS.weight * tileValue(play.tile);
	if (isDouble(play.tile)) score += WEIGHTS.double;
	score += WEIGHTS.control * matchesInHand(observation, play.tile, ends);
	score += WEIGHTS.openness * unseenMatching(observation, ends);

	if (!couldStillPlay(observation, play.tile, ends)) {
		score += WEIGHTS.selfBlocked;
	}

	score += pressureOnOpponents(observation, ends);
	if (isStuck(observation, observation.partner, ends)) {
		score += WEIGHTS.partnerBlocked;
	}

	score += trancaPosture(observation, play, ends);

	return score;
}

/** Reward ends that provably lock an opponent out, more so when they are about to go out. */
function pressureOnOpponents(observation: Observation, ends: BoardEnds): number {
	let score = 0;
	for (const opponent of observation.opponents) {
		if (isStuck(observation, opponent, ends)) {
			score += WEIGHTS.stuckOpponent;
			if (observation.tileCounts[opponent] <= 2) {
				score += WEIGHTS.endgameUrgency;
			}
		}
	}
	return score;
}

/**
 * A tranca pays the *lighter* side, so how much a bot should want to close the table
 * depends on whether it is currently ahead on pips.
 *
 * The partner's hand is hidden, so the read uses what is knowable: the bot's own weight
 * against the average weight of an unseen hand.
 */
function trancaPosture(observation: Observation, play: PlayMove, ends: BoardEnds): number {
	const remaining = sumPips(observation.hand) - tileValue(play.tile);
	const unseenPips = sumPips(observation.unseen);
	const unseenHands = 3;
	const averageOpposingHand = unseenPips / unseenHands;

	// How close the table is to locking up: 0 when wide open, 1 when nothing can follow.
	const openness = unseenMatching(observation, ends);
	const tightness = openness === 0 ? 1 : 1 / (1 + openness);

	const advantage = averageOpposingHand - remaining;
	return tightness * advantage * 1.5;
}

function explain(move: Move, observation: Observation): string {
	if (move.type === 'pass') return 'no tile fits';

	const play = move as PlayMove;
	const ends = endsAfter(observation.board, play);
	const stuck = observation.opponents.filter((seat) => isStuck(observation, seat, ends));

	if (observation.hand.length === 1) return `closes the hand with ${formatTile(play.tile)}`;
	if (stuck.length > 0) {
		return `${formatTile(play.tile)} leaves ${ends.left}/${ends.right}, which seat ${stuck.join(' and ')} cannot answer`;
	}
	return `${formatTile(play.tile)} keeps ${ends.left}/${ends.right} for team ${teamOf(observation.seat)}`;
}
