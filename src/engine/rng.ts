/**
 * Deterministic pseudo-random number generator.
 *
 * The engine never touches `Math.random`: the generator state lives inside the match
 * state, so a match is fully reproducible from its seed and its move list. The algorithm
 * is mulberry32 — small, fast, and good enough for shuffling a domino set.
 */

export interface RngState {
	/** The seed the match was created with, kept for display and reproduction. */
	readonly seed: number;
	/** The current internal state; advances on every draw. */
	readonly cursor: number;
}

const UINT32 = 0x100000000;

/** Turns any string or number into a 32-bit seed. */
export function toSeed(input: number | string): number {
	if (typeof input === 'number') {
		return Math.abs(Math.floor(input)) % UINT32;
	}

	// FNV-1a, so that human-friendly seeds like "domingo" are usable.
	let hash = 0x811c9dc5;
	for (let i = 0; i < input.length; i++) {
		hash ^= input.charCodeAt(i);
		hash = Math.imul(hash, 0x01000193) >>> 0;
	}
	return hash >>> 0;
}

export function createRng(seed: number | string): RngState {
	const numericSeed = toSeed(seed);
	return { seed: numericSeed, cursor: numericSeed };
}

/** Draws the next float in `[0, 1)` and returns the advanced state alongside it. */
export function nextFloat(state: RngState): { value: number; state: RngState } {
	let t = (state.cursor + 0x6d2b79f5) >>> 0;
	let x = Math.imul(t ^ (t >>> 15), 1 | t);
	x = (x + Math.imul(x ^ (x >>> 7), 61 | x)) ^ x;
	const value = ((x ^ (x >>> 14)) >>> 0) / UINT32;
	return { value, state: { seed: state.seed, cursor: t } };
}

/** Draws an integer in `[0, bound)`. */
export function nextInt(state: RngState, bound: number): { value: number; state: RngState } {
	if (bound <= 0) {
		throw new RangeError(`bound must be positive, received ${bound}`);
	}
	const drawn = nextFloat(state);
	return { value: Math.floor(drawn.value * bound), state: drawn.state };
}

/** Fisher–Yates shuffle. Returns a new array; the input is left untouched. */
export function shuffle<T>(items: readonly T[], state: RngState): { value: T[]; state: RngState } {
	const result = items.slice();
	let cursor = state;

	for (let i = result.length - 1; i > 0; i--) {
		const drawn = nextInt(cursor, i + 1);
		cursor = drawn.state;
		const j = drawn.value;
		const swap = result[i];
		result[i] = result[j];
		result[j] = swap;
	}

	return { value: result, state: cursor };
}

/** Picks one element uniformly. Throws on an empty array. */
export function pick<T>(items: readonly T[], state: RngState): { value: T; state: RngState } {
	if (items.length === 0) {
		throw new RangeError('cannot pick from an empty array');
	}
	const drawn = nextInt(state, items.length);
	return { value: items[drawn.value], state: drawn.state };
}
