/**
 * House rules.
 *
 * Dominican tables disagree on the details — what a tranca pays, whether capicúa is worth
 * anything, who leads after a blocked hand. Rather than hard-coding one table's habits,
 * the engine reads them from a `RuleConfig` carried inside the match state.
 */

import { fail } from './errors';
import { isSeat, type Seat } from './types';

/** How the first hand of a match is opened. */
export type OpeningRule =
	| 'double-six' // the holder of [6|6] leads it — the usual salida
	| 'highest-double' // the holder of the highest double leads it
	| 'fixed-seat'; // `openingSeat` leads whatever they like

/** What a blocked hand (tranca) pays the winning side. */
export type TrancaScoring =
	| 'all-remaining' // every pip still in hand, both teams' included
	| 'opponents-only'; // only the losing team's pips

/** Who leads the hand after a tranca that had a winner. */
export type TrancaStarterRule =
	| 'blocker' // whoever played the tile that locked the game
	| 'winner-side'; // the winning team's seat holding the fewest pips

export interface RuleConfig {
	/** Points that end the match. */
	readonly targetScore: number;
	readonly opening: OpeningRule;
	/** Used only by the `fixed-seat` opening rule. */
	readonly openingSeat: Seat;
	readonly trancaScoring: TrancaScoring;
	readonly trancaStarter: TrancaStarterRule;
	/** Bonus added when the winning tile is a capicúa. `0` disables it. */
	readonly capicuaBonus: number;
	/**
	 * When true (the standard reading), capicúa requires the two open ends to be
	 * *different* numbers. When false, closing on matching ends also counts.
	 */
	readonly capicuaRequiresDistinctEnds: boolean;
	/** Tiles dealt to each player. */
	readonly handSize: number;
}

export const DEFAULT_RULES: RuleConfig = {
	targetScore: 200,
	opening: 'double-six',
	openingSeat: 0,
	trancaScoring: 'all-remaining',
	trancaStarter: 'blocker',
	capicuaBonus: 25,
	capicuaRequiresDistinctEnds: true,
	handSize: 7,
};

export type RuleOverrides = Partial<RuleConfig>;

/** Merges overrides onto the defaults and validates the result. */
export function resolveRules(overrides: RuleOverrides = {}): RuleConfig {
	const rules: RuleConfig = { ...DEFAULT_RULES, ...overrides };

	if (!Number.isFinite(rules.targetScore) || rules.targetScore <= 0) {
		fail('INVALID_CONFIG', `targetScore must be a positive number, got ${rules.targetScore}`);
	}
	if (!Number.isInteger(rules.handSize) || rules.handSize < 1 || rules.handSize > 7) {
		fail('INVALID_CONFIG', `handSize must be between 1 and 7, got ${rules.handSize}`);
	}
	if (!Number.isFinite(rules.capicuaBonus) || rules.capicuaBonus < 0) {
		fail('INVALID_CONFIG', `capicuaBonus must be zero or positive, got ${rules.capicuaBonus}`);
	}
	if (!isSeat(rules.openingSeat)) {
		fail('INVALID_CONFIG', `openingSeat must be a seat 0-3, got ${rules.openingSeat}`);
	}
	if (!['double-six', 'highest-double', 'fixed-seat'].includes(rules.opening)) {
		fail('INVALID_CONFIG', `unknown opening rule: ${rules.opening}`);
	}
	if (!['all-remaining', 'opponents-only'].includes(rules.trancaScoring)) {
		fail('INVALID_CONFIG', `unknown tranca scoring: ${rules.trancaScoring}`);
	}
	if (!['blocker', 'winner-side'].includes(rules.trancaStarter)) {
		fail('INVALID_CONFIG', `unknown tranca starter rule: ${rules.trancaStarter}`);
	}

	return rules;
}
