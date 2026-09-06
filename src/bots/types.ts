/**
 * Bot interface.
 *
 * A bot sees only an `Observation` — its own tiles and the public record — and threads the
 * RNG state through, so a match played by bots is as reproducible as the deal itself.
 */

import type { Move, Observation, RngState } from '../engine';

export interface BotDecision {
	readonly move: Move;
	readonly rng: RngState;
	/** Optional short explanation, surfaced by the CLI in verbose mode. */
	readonly reason?: string;
}

export interface Bot {
	readonly name: string;
	decide(observation: Observation, rng: RngState): BotDecision;
}

export type BotName = 'random' | 'greedy' | 'strategic';
