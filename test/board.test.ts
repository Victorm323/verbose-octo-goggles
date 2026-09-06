import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
	boardEnds,
	boardTiles,
	canPlace,
	EngineError,
	formatBoard,
	isBoardEmpty,
	isChainConsistent,
	place,
	tileId,
} from '../src/engine';
import { chain, t } from './helpers';

describe('board', () => {
	it('starts empty with no ends', () => {
		assert.ok(isBoardEmpty([]));
		assert.equal(boardEnds([]), null);
		assert.equal(formatBoard([]), '(empty table)');
	});

	it('takes any tile as the opening one and shows both its numbers as ends', () => {
		const board = place([], t('6|3'), 'left', 2);
		assert.deepEqual(boardEnds(board), { left: 6, right: 3 });
		assert.equal(board[0].end, 'opening');
		assert.equal(board[0].seat, 2);
	});

	it('orients a tile so the matching pip faces the chain', () => {
		const board = place(place([], t('6|3'), 'left', 0), t('5|3'), 'right', 1);
		assert.deepEqual(boardEnds(board), { left: 6, right: 5 });
		assert.equal(formatBoard(board), '[6|3][3|5]');
	});

	it('grows leftwards as well', () => {
		const board = place(place([], t('6|3'), 'left', 0), t('6|1'), 'left', 1);
		assert.deepEqual(boardEnds(board), { left: 1, right: 3 });
		assert.equal(formatBoard(board), '[1|6][6|3]');
	});

	it('lets a double sit on either end of a symmetric chain', () => {
		const board = chain(['3|3']);
		assert.deepEqual(boardEnds(board), { left: 3, right: 3 });
		assert.ok(canPlace(board, t('3|5'), 'left'));
		assert.ok(canPlace(board, t('3|5'), 'right'));
	});

	it('refuses a tile that does not fit', () => {
		const board = chain(['6|3', '3|5']);
		assert.ok(!canPlace(board, t('4|2'), 'left'));
		assert.throws(
			() => place(board, t('4|2'), 'left', 0),
			(error: unknown) => error instanceof EngineError && error.code === 'ILLEGAL_PLACEMENT',
		);
	});

	it('keeps the chain connected however it is built', () => {
		const board = chain(['6|3', '3|3', '3|1', '1|0']);
		assert.ok(isChainConsistent(board));
		assert.deepEqual(boardEnds(board), { left: 6, right: 0 });
		assert.deepEqual(boardTiles(board).map(tileId), ['6|3', '3|3', '3|1', '1|0']);
	});

	it('spots a chain that does not connect', () => {
		const broken = [
			{
				tile: t('6|3'),
				left: 6 as const,
				right: 3 as const,
				seat: 0 as const,
				end: 'opening' as const,
			},
			{
				tile: t('5|4'),
				left: 5 as const,
				right: 4 as const,
				seat: 1 as const,
				end: 'right' as const,
			},
		];
		assert.ok(!isChainConsistent(broken));
	});

	it('spots a placed tile whose orientation does not match its own pips', () => {
		const wrong = [
			{
				tile: t('6|3'),
				left: 6 as const,
				right: 5 as const,
				seat: 0 as const,
				end: 'opening' as const,
			},
		];
		assert.ok(!isChainConsistent(wrong));
	});

	it('never mutates the board it is given', () => {
		const before = chain(['6|3']);
		place(before, t('3|1'), 'right', 1);
		assert.equal(before.length, 1);
	});
});
