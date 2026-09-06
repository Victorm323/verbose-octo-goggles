/**
 * The baseline: uniform over legal moves. Every other bot has to beat this.
 */

import { pick, type Observation, type RngState } from '../engine';
import type { Bot, BotDecision } from './types';

export const randomBot: Bot = {
	name: 'random',
	decide(observation: Observation, rng: RngState): BotDecision {
		const drawn = pick(observation.legalMoves, rng);
		return { move: drawn.value, rng: drawn.state, reason: 'uniform choice' };
	},
};
