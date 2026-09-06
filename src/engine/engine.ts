/**
 * `DominoEngine` — a small stateful wrapper over the pure functions.
 *
 * The functional API in `match.ts` is the real engine; this class exists because most
 * callers (a CLI loop, a bot arena, an n8n node) just want to hold one match, push moves
 * into it and read events out.
 */

import type { RuleOverrides } from './config';
import { createMatch, advance, applyMove, legalMoves, summarize } from './match';
import { observationFor, type Observation } from './observation';
import { deserializeMatch, serializeMatch, type SerializedMatch } from './serialize';
import type {
	HandResult,
	MatchState,
	MatchSummary,
	Move,
	Seat,
	TeamId,
} from './types';

export type EngineEvent =
	| { readonly type: 'move'; readonly move: Move; readonly handNumber: number }
	| { readonly type: 'hand-finished'; readonly result: HandResult }
	| { readonly type: 'hand-started'; readonly handNumber: number; readonly starter: Seat }
	| { readonly type: 'match-finished'; readonly summary: MatchSummary };

export interface EngineOptions {
	readonly seed?: number | string;
	readonly rules?: RuleOverrides;
	/**
	 * Deal the next hand automatically once one is settled. On by default; turn it off to
	 * inspect the finished hand before the tiles are swept up.
	 */
	readonly autoAdvance?: boolean;
}

export class DominoEngine {
	private current: MatchState;
	private autoAdvance: boolean;
	private readonly events: EngineEvent[] = [];

	constructor(options: EngineOptions = {}) {
		this.current = createMatch({ seed: options.seed, rules: options.rules });
		this.autoAdvance = options.autoAdvance !== false;
	}

	/** Resumes a match from a live state or from anything `deserializeMatch` accepts. */
	static from(state: unknown, autoAdvance = true): DominoEngine {
		const engine = new DominoEngine({ seed: 0 });
		engine.current = isMatchState(state) ? state : deserializeMatch(state);
		engine.autoAdvance = autoAdvance;
		return engine;
	}

	get state(): MatchState {
		return this.current;
	}

	get turn(): Seat {
		return this.current.hand.turn;
	}

	get isOver(): boolean {
		return this.current.status === 'finished';
	}

	get winner(): TeamId | null {
		return this.current.winner;
	}

	legalMoves(): Move[] {
		return legalMoves(this.current);
	}

	observation(seat: Seat = this.current.hand.turn): Observation {
		return observationFor(this.current, seat);
	}

	/** Plays a move, settles the hand if it ended, and deals the next one when configured to. */
	play(move: Move): MatchState {
		const handNumber = this.current.hand.handNumber;
		this.current = applyMove(this.current, move);
		this.events.push({ type: 'move', move, handNumber });

		const result = this.current.hand.result;
		if (this.current.hand.status === 'finished' && result !== null) {
			this.events.push({ type: 'hand-finished', result });

			if (this.current.status === 'finished') {
				this.events.push({ type: 'match-finished', summary: summarize(this.current) });
			} else if (this.autoAdvance) {
				this.current = advance(this.current);
				this.events.push({
					type: 'hand-started',
					handNumber: this.current.hand.handNumber,
					starter: this.current.hand.starter,
				});
			}
		}

		return this.current;
	}

	/** Deals the next hand when one is due. Only useful with `autoAdvance: false`. */
	advance(): MatchState {
		const before = this.current.hand.handNumber;
		this.current = advance(this.current);
		if (this.current.hand.handNumber !== before) {
			this.events.push({
				type: 'hand-started',
				handNumber: this.current.hand.handNumber,
				starter: this.current.hand.starter,
			});
		}
		return this.current;
	}

	summary(): MatchSummary {
		return summarize(this.current);
	}

	/** Events since the last drain, oldest first. */
	drainEvents(): EngineEvent[] {
		return this.events.splice(0, this.events.length);
	}

	serialize(): SerializedMatch {
		return serializeMatch(this.current);
	}
}

function isMatchState(value: unknown): value is MatchState {
	return (
		value !== null &&
		typeof value === 'object' &&
		'hand' in value &&
		'rules' in value &&
		'rng' in value &&
		Array.isArray((value as MatchState).hand?.board)
	);
}
