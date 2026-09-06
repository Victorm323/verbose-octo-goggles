import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
	assertMoveLegal,
	determineOpening,
	EngineError,
	hasLegalPlay,
	isCapicua,
	legalMovesFor,
	legalPlays,
	playableEnds,
	tileId,
} from '../src/engine';
import { chain, hand, rules, t } from './helpers';

describe('legal moves', () => {
	it('offers every tile on an empty table', () => {
		const moves = legalPlays([], hand('6|6', '5|4', '3|1'), 0);
		assert.equal(moves.length, 3);
		assert.ok(
			moves.every((move) => move.end === 'left'),
			'the opening tile has no end to pick',
		);
	});

	it('offers both ends for a tile that fits both', () => {
		const board = chain(['6|3', '3|5']); // ends 6 and 5
		const moves = legalPlays(board, hand('6|5'), 0);
		assert.deepEqual(
			moves.map((move) => move.end).sort(),
			['left', 'right'],
			'[6|5] can go either way, and which way matters',
		);
	});

	it('offers one move per tile while both ends show the same number', () => {
		const board = chain(['3|3']); // ends 3 and 3 — the two placements are mirror images
		const moves = legalPlays(board, hand('3|5'), 0);
		assert.equal(moves.length, 1);
		// ...but a client that wants the other side is not stopped.
		assertMoveLegal(board, hand('3|5'), { type: 'play', seat: 0, tile: t('3|5'), end: 'right' });
	});

	it('filters out tiles that match neither end', () => {
		const board = chain(['6|3', '3|5']);
		const moves = legalPlays(board, hand('4|2', '6|1', '0|0'), 1);
		assert.deepEqual(
			moves.map((move) => tileId(move.tile)),
			['6|1'],
		);
	});

	it('allows a pass only when nothing can be played', () => {
		const board = chain(['3|3']);
		const withPlay = hand('3|5', '4|2');
		const withoutPlay = hand('4|2', '6|1');

		assert.ok(hasLegalPlay(board, withPlay));
		assert.ok(!hasLegalPlay(board, withoutPlay));

		assert.deepEqual(legalMovesFor(board, withoutPlay, 0), [{ type: 'pass', seat: 0 }]);
		assert.throws(
			() => assertMoveLegal(board, withPlay, { type: 'pass', seat: 0 }),
			(error: unknown) => error instanceof EngineError && error.code === 'ILLEGAL_PASS',
		);
	});

	it('refuses a tile that is not in the hand', () => {
		assert.throws(
			() =>
				assertMoveLegal(chain(['3|3']), hand('3|5'), {
					type: 'play',
					seat: 0,
					tile: t('3|1'),
					end: 'left',
				}),
			(error: unknown) => error instanceof EngineError && error.code === 'TILE_NOT_IN_HAND',
		);
	});

	it('enforces the tile the opener is obliged to lead', () => {
		const held = hand('6|6', '5|4');
		assert.deepEqual(
			legalPlays([], held, 0, t('6|6')).map((move) => tileId(move.tile)),
			['6|6'],
		);
		assert.throws(
			() =>
				assertMoveLegal([], held, { type: 'play', seat: 0, tile: t('5|4'), end: 'left' }, t('6|6')),
			(error: unknown) => error instanceof EngineError && error.code === 'MUST_OPEN_WITH',
		);
	});

	it('reports which ends would accept a tile', () => {
		const board = chain(['6|3', '3|5']);
		assert.deepEqual(playableEnds(board, t('6|5')), ['left', 'right']);
		assert.deepEqual(playableEnds(board, t('5|1')), ['right']);
		assert.deepEqual(playableEnds(board, t('4|2')), []);
		assert.deepEqual(playableEnds([], t('4|2')), ['left']);
	});
});

describe('opening the first hand', () => {
	it('gives the lead to whoever holds the double six', () => {
		const hands = [hand('5|4'), hand('3|1'), hand('6|6', '2|0'), hand('4|4')];
		assert.deepEqual(determineOpening(hands, rules()), {
			seat: 2,
			mustOpenWith: t('6|6'),
		});
	});

	it('falls back to the highest double when configured that way', () => {
		const hands = [hand('5|5'), hand('3|3'), hand('2|1'), hand('4|4')];
		const opening = determineOpening(hands, rules({ opening: 'highest-double' }));
		assert.equal(opening.seat, 0);
		assert.deepEqual(opening.mustOpenWith, t('5|5'));
	});

	it('lets a fixed seat lead whatever it likes', () => {
		const hands = [hand('6|6'), hand('3|3'), hand('2|1'), hand('4|4')];
		assert.deepEqual(determineOpening(hands, rules({ opening: 'fixed-seat', openingSeat: 3 })), {
			seat: 3,
			mustOpenWith: null,
		});
	});

	it('falls back to the highest double when nobody was dealt the double six', () => {
		const hands = [hand('5|4'), hand('3|3'), hand('2|1'), hand('4|4')];
		const opening = determineOpening(hands, rules());
		assert.equal(opening.seat, 3);
		assert.deepEqual(opening.mustOpenWith, t('4|4'));
	});
});

describe('capicúa', () => {
	it('counts a tile that would have fitted on either end', () => {
		const board = chain(['3|1', '1|5']); // ends 3 and 5
		assert.ok(isCapicua(board, t('5|3'), rules()));
	});

	it('does not count a tile that only fits one end', () => {
		const board = chain(['3|1', '1|5']);
		assert.ok(!isCapicua(board, t('5|2'), rules()));
	});

	it('does not count a double', () => {
		const board = chain(['3|3']); // both ends are 3
		assert.ok(!isCapicua(board, t('3|3'), rules({ capicuaRequiresDistinctEnds: false })));
	});

	it('requires distinct ends under the strict reading, and not otherwise', () => {
		const board = chain(['5|3', '3|5']); // ends 5 and 5
		assert.ok(!isCapicua(board, t('5|1'), rules()));
		assert.ok(isCapicua(board, t('5|1'), rules({ capicuaRequiresDistinctEnds: false })));
	});

	it('is off when the bonus is zero', () => {
		const board = chain(['3|1', '1|5']);
		assert.ok(!isCapicua(board, t('5|3'), rules({ capicuaBonus: 0 })));
	});
});
