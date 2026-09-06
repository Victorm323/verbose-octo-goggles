import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
	compareTiles,
	countSuit,
	EngineError,
	formatTile,
	fullSet,
	highestDouble,
	isDouble,
	otherPip,
	parseTile,
	removeTile,
	sumPips,
	tile,
	tileId,
	tileValue,
	tilesEqual,
} from '../src/engine';
import { hand, t } from './helpers';

describe('tiles', () => {
	it('holds 28 distinct tiles in the double-six set', () => {
		const set = fullSet();
		assert.equal(set.length, 28);
		assert.equal(new Set(set.map(tileId)).size, 28);
	});

	it('carries 168 pips in total, 7 of each number', () => {
		const set = fullSet();
		assert.equal(sumPips(set), 168);
		for (let pip = 0; pip <= 6; pip++) {
			assert.equal(countSuit(set, pip as 0), 7, `suit ${pip}`);
		}
	});

	it('normalises orientation, so [3|5] and [5|3] are the same tile', () => {
		assert.deepEqual(tile(3, 5), tile(5, 3));
		assert.equal(tileId(tile(3, 5)), '5|3');
		assert.ok(tilesEqual(t('3|5'), t('5|3')));
	});

	it('rejects tiles outside the set', () => {
		assert.throws(
			() => tile(7, 0),
			(error: unknown) => error instanceof EngineError,
		);
		assert.throws(
			() => tile(-1, 2),
			(error: unknown) => error instanceof EngineError,
		);
		assert.throws(
			() => parseTile('6'),
			(error: unknown) => error instanceof EngineError,
		);
	});

	it('round-trips through its id', () => {
		for (const original of fullSet()) {
			assert.ok(tilesEqual(parseTile(tileId(original)), original));
		}
	});

	it('reads the pip on the far side', () => {
		assert.equal(otherPip(t('6|2'), 6), 2);
		assert.equal(otherPip(t('6|2'), 2), 6);
		assert.equal(otherPip(t('4|4'), 4), 4, 'a double faces the same number both ways');
		assert.throws(() => otherPip(t('6|2'), 5));
	});

	it('values a tile by its pips', () => {
		assert.equal(tileValue(t('6|6')), 12);
		assert.equal(tileValue(t('0|0')), 0);
		assert.equal(sumPips(hand('6|6', '5|4', '0|0')), 21);
	});

	it('removes one copy and leaves the rest alone', () => {
		const before = hand('6|6', '5|4', '3|1');
		const after = removeTile(before, t('5|4'));
		assert.equal(after.length, 2);
		assert.equal(before.length, 3, 'the input is not mutated');
		assert.throws(() => removeTile(after, t('5|4')));
	});

	it('finds the highest double', () => {
		assert.deepEqual(highestDouble(hand('3|3', '6|6', '1|1')), t('6|6'));
		assert.equal(highestDouble(hand('6|5', '4|3')), null);
	});

	it('sorts heaviest first, doubles ahead of equals', () => {
		const sorted = hand('1|0', '6|6', '5|4', '3|3').sort(compareTiles).map(tileId);
		assert.deepEqual(sorted, ['6|6', '5|4', '3|3', '1|0']);
	});

	it('formats the way the tile is spoken', () => {
		assert.equal(formatTile(t('6|4')), '[6|4]');
		assert.ok(isDouble(t('2|2')));
		assert.ok(!isDouble(t('2|1')));
	});
});
