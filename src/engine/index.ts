/**
 * Public surface of the Dominican dominoes engine.
 *
 * Two ways in:
 *
 * ```ts
 * // functional — every transition returns a new state
 * let state = createMatch({ seed: 'domingo' });
 * state = applyMove(state, legalMoves(state)[0]);
 *
 * // or the stateful facade, which also deals the next hand for you
 * const engine = new DominoEngine({ seed: 'domingo' });
 * engine.play(engine.legalMoves()[0]);
 * ```
 */

export * from './errors';
export * from './rng';
export * from './tiles';
export * from './types';
export * from './config';
export * from './board';
export * from './rules';
export * from './scoring';
export * from './hand';
export * from './match';
export * from './observation';
export * from './serialize';
export * from './format';
export * from './engine';
