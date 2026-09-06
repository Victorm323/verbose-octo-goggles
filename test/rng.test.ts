import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
	createRng,
	fullSet,
	nextFloat,
	nextInt,
	pick,
	shuffle,
	tileId,
	toSeed,
} from '../src/engine';

describe('rng', () => {
	it('produces the same stream for the same seed', () => {
		const draw = (seed: number | string) => {
			let state = createRng(seed);
			const values: number[] = [];
			for (let i = 0; i < 20; i++) {
				const next = nextFloat(state);
				values.push(next.value);
				state = next.state;
			}
			return values;
		};

		assert.deepEqual(draw(42), draw(42));
		assert.notDeepEqual(draw(42), draw(43));
		assert.deepEqual(draw('domingo'), draw('domingo'));
	});

	it('accepts words as seeds', () => {
		assert.equal(toSeed('domingo'), toSeed('domingo'));
		assert.notEqual(toSeed('domingo'), toSeed('lunes'));
		assert.ok(Number.isInteger(toSeed('domingo')));
	});

	it('stays inside [0, 1) and inside the integer bound', () => {
		let state = createRng(7);
		for (let i = 0; i < 500; i++) {
			const float = nextFloat(state);
			assert.ok(float.value >= 0 && float.value < 1);
			const integer = nextInt(float.state, 6);
			assert.ok(Number.isInteger(integer.value));
			assert.ok(integer.value >= 0 && integer.value < 6);
			state = integer.state;
		}
		assert.throws(() => nextInt(state, 0));
	});

	it('shuffles into a permutation without touching the input', () => {
		const original = fullSet();
		const result = shuffle(original, createRng('barajar'));

		assert.equal(result.value.length, 28);
		assert.deepEqual(
			result.value.map(tileId).sort(),
			original.map(tileId).sort(),
			'every tile survives the shuffle',
		);
		assert.deepEqual(original.map(tileId), fullSet().map(tileId), 'the input is untouched');
		assert.notDeepEqual(result.value.map(tileId), original.map(tileId), 'and the order changed');
	});

	it('advances the state on every draw, so repeated calls differ', () => {
		const state = createRng(1);
		const first = nextFloat(state);
		const second = nextFloat(first.state);
		assert.notEqual(first.value, second.value);
		assert.notEqual(first.state.cursor, second.state.cursor);
		assert.equal(first.state.seed, state.seed, 'the seed is carried along unchanged');
	});

	it('picks from an array and refuses an empty one', () => {
		const drawn = pick(['a', 'b', 'c'], createRng(3));
		assert.ok(['a', 'b', 'c'].includes(drawn.value));
		assert.throws(() => pick([], createRng(3)));
	});
});
