/**
 * The bot roster, plus the loop that plays whole matches with them.
 */

import {
	advance,
	applyMove,
	createMatch,
	legalMoves,
	summarize,
	type CreateMatchOptions,
	type MatchState,
	type MatchSummary,
	type Move,
	type RngState,
	type Seat,
} from '../engine';
import { observationFor } from '../engine';
import { greedyBot } from './greedy';
import { randomBot } from './random';
import { strategicBot } from './strategic';
import type { Bot, BotDecision, BotName } from './types';

export * from './types';
export * from './heuristics';
export { randomBot } from './random';
export { greedyBot } from './greedy';
export { strategicBot, scoreMove } from './strategic';

export const BOTS: Readonly<Record<BotName, Bot>> = {
	random: randomBot,
	greedy: greedyBot,
	strategic: strategicBot,
};

export function botByName(name: string): Bot {
	const bot = (BOTS as Record<string, Bot | undefined>)[name];
	if (bot === undefined) {
		throw new Error(`unknown bot "${name}"; available: ${Object.keys(BOTS).join(', ')}`);
	}
	return bot;
}

export type Seating = readonly [Bot, Bot, Bot, Bot];

/** Builds a seating from bot names, e.g. `['strategic', 'greedy', 'strategic', 'greedy']`. */
export function seatingFromNames(names: readonly string[]): Seating {
	if (names.length !== 4) {
		throw new Error(`expected four bot names, received ${names.length}`);
	}
	const bots = names.map(botByName);
	return [bots[0], bots[1], bots[2], bots[3]];
}

export interface PlayoutOptions extends CreateMatchOptions {
	readonly seating: Seating;
	/** Safety valve so a broken policy cannot spin forever. */
	readonly maxPlies?: number;
	/** Called after every move, for logging or replay capture. */
	readonly onMove?: (move: Move, decision: BotDecision, state: MatchState) => void;
	/** Called whenever a hand is settled. */
	readonly onHand?: (state: MatchState) => void;
}

export interface PlayoutResult {
	readonly state: MatchState;
	readonly summary: MatchSummary;
	readonly plies: number;
}

/** Asks the seated bot for its move. The RNG is threaded so playouts stay reproducible. */
export function botMove(
	state: MatchState,
	seating: Seating,
	rng: RngState,
	seat: Seat = state.hand.turn,
): BotDecision {
	const bot = seating[seat];
	return bot.decide(observationFor(state, seat), rng);
}

/** Plays a whole match out between four bots. */
export function playMatch(options: PlayoutOptions): PlayoutResult {
	let state = createMatch({ seed: options.seed, rules: options.rules });
	// A private RNG stream for the bots keeps their tie-breaking from disturbing the deal.
	let rng: RngState = { seed: state.rng.seed, cursor: (state.rng.cursor ^ 0x5f3759df) >>> 0 };

	const maxPlies = options.maxPlies ?? 20_000;
	let plies = 0;

	while (state.status === 'playing') {
		if (plies >= maxPlies) {
			throw new Error(`playout exceeded ${maxPlies} plies; a bot is not making progress`);
		}

		const moves = legalMoves(state);
		if (moves.length === 0) {
			// The hand is settled but not yet swept up.
			state = advance(state);
			options.onHand?.(state);
			continue;
		}

		const decision = botMove(state, options.seating, rng);
		rng = decision.rng;
		state = applyMove(state, decision.move);
		plies += 1;
		options.onMove?.(decision.move, decision, state);

		if (state.hand.status === 'finished') {
			options.onHand?.(state);
			state = advance(state);
		}
	}

	return { state, summary: summarize(state), plies };
}

export interface TournamentResult {
	readonly matches: number;
	readonly winsByTeam: readonly [number, number];
	readonly shutouts: readonly [number, number];
	readonly averageHands: number;
	readonly averagePlies: number;
}

/** Runs `matches` playouts from consecutive seeds and tallies the outcome. */
export function runTournament(
	seating: Seating,
	matches: number,
	baseSeed: number | string = 1,
	rules?: CreateMatchOptions['rules'],
): TournamentResult {
	const wins: [number, number] = [0, 0];
	const shutouts: [number, number] = [0, 0];
	let hands = 0;
	let plies = 0;

	for (let i = 0; i < matches; i++) {
		const seed = typeof baseSeed === 'number' ? baseSeed + i : `${baseSeed}:${i}`;
		const result = playMatch({ seating, seed, rules });
		if (result.summary.winner !== null) {
			wins[result.summary.winner] += 1;
			if (result.summary.shutout) shutouts[result.summary.winner] += 1;
		}
		hands += result.summary.hands;
		plies += result.plies;
	}

	return {
		matches,
		winsByTeam: wins,
		shutouts,
		averageHands: matches === 0 ? 0 : hands / matches,
		averagePlies: matches === 0 ? 0 : plies / matches,
	};
}
