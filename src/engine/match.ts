/**
 * A match ("partida"): hands dealt and played until one team reaches the target score.
 */

import { resolveRules, type RuleConfig, type RuleOverrides } from './config';
import { fail } from './errors';
import { applyHandMove, createHand, dealHands, legalHandMoves } from './hand';
import { createRng, type RngState } from './rng';
import { determineOpening } from './rules';
import { applyResultToScores } from './scoring';
import type { HandResult, MatchState, MatchSummary, Move, Seat, TeamId } from './types';

export interface CreateMatchOptions {
	/** Any number or string; the same seed always deals the same match. */
	readonly seed?: number | string;
	readonly rules?: RuleOverrides;
}

export function createMatch(options: CreateMatchOptions = {}): MatchState {
	const rules = resolveRules(options.rules);
	const rng = createRng(options.seed ?? Date.now());
	const deal = dealHands(rng, rules.handSize);
	const opening = determineOpening(deal.hands, rules);

	return {
		rules,
		rng: deal.rng,
		scores: [0, 0],
		handNumber: 1,
		hand: createHand({
			handNumber: 1,
			hands: deal.hands,
			starter: opening.seat,
			mustOpenWith: opening.mustOpenWith,
		}),
		status: 'playing',
		winner: null,
		results: [],
	};
}

/** Legal moves for the seat on turn. Empty once the hand is settled. */
export function legalMoves(state: MatchState): Move[] {
	if (state.status === 'finished') return [];
	return legalHandMoves(state.hand);
}

export function isMatchOver(state: MatchState): boolean {
	return state.status === 'finished';
}

/** Is the current hand settled and waiting for `startNextHand`? */
export function isHandOver(state: MatchState): boolean {
	return state.hand.status === 'finished';
}

/**
 * Plays one move.
 *
 * When the move ends the hand, the result is folded into the score and the match may
 * finish. The next hand is *not* dealt automatically — call `startNextHand`, or use
 * `DominoEngine`, which does it for you.
 */
export function applyMove(state: MatchState, move: Move): MatchState {
	if (state.status === 'finished') {
		fail('MATCH_FINISHED', 'the match is over');
	}

	const hand = applyHandMove(state.hand, move, state.rules);
	if (hand.status !== 'finished' || hand.result === null) {
		return { ...state, hand };
	}

	const result: HandResult = hand.result;
	const scores = applyResultToScores(state.scores, result);
	const winner = winningTeam(scores, state.rules);

	return {
		...state,
		hand,
		scores,
		results: [...state.results, result],
		status: winner === null ? 'playing' : 'finished',
		winner,
	};
}

function winningTeam(scores: readonly [number, number], rules: RuleConfig): TeamId | null {
	const reached0 = scores[0] >= rules.targetScore;
	const reached1 = scores[1] >= rules.targetScore;

	if (reached0 && reached1) {
		// Only one team scores per hand, so this cannot happen mid-match; it is here for
		// states handed in from outside. The higher score takes it.
		return scores[0] >= scores[1] ? 0 : 1;
	}
	if (reached0) return 0;
	if (reached1) return 1;
	return null;
}

/** Deals the next hand. The previous hand's winner leads, with a free choice of tile. */
export function startNextHand(state: MatchState): MatchState {
	if (state.status === 'finished') {
		fail('MATCH_FINISHED', 'the match is over; no further hands are dealt');
	}
	if (state.hand.status !== 'finished' || state.hand.result === null) {
		fail('HAND_IN_PROGRESS', 'the current hand is still being played');
	}

	const starter: Seat = state.hand.result.nextStarter;
	const deal = dealHands(state.rng, state.rules.handSize);
	const handNumber = state.handNumber + 1;

	return {
		...state,
		rng: deal.rng,
		handNumber,
		hand: createHand({ handNumber, hands: deal.hands, starter, mustOpenWith: null }),
	};
}

/** Starts the next hand when one is due, and is a no-op otherwise. */
export function advance(state: MatchState): MatchState {
	if (state.status === 'finished') return state;
	if (state.hand.status !== 'finished') return state;
	return startNextHand(state);
}

export function summarize(state: MatchState): MatchSummary {
	const loser = state.winner === null ? null : state.winner === 0 ? 1 : 0;
	const loserScore = loser === null ? Math.min(state.scores[0], state.scores[1]) : state.scores[loser];

	return {
		winner: state.winner,
		scores: state.scores,
		hands: state.results.length,
		shutout: state.winner !== null && loserScore === 0,
		zapato: state.winner !== null && loserScore < state.rules.targetScore / 2,
	};
}

/** Re-seeds a match state — useful when replaying a stored match forward. */
export function withRng(state: MatchState, rng: RngState): MatchState {
	return { ...state, rng };
}
