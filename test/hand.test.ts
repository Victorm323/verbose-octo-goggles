import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
	applyHandMove,
	createRng,
	dealHands,
	EngineError,
	formatBoard,
	legalHandMoves,
	sumPips,
	tileId,
	turnMustPass,
	type HandState,
	type Move,
} from '../src/engine';
import { rules, t, table } from './helpers';

const HOUSE = rules();

function play(state: HandState, moves: readonly Move[]): HandState {
	return moves.reduce((current, move) => applyHandMove(current, move, HOUSE), state);
}

describe('dealing', () => {
	it('gives four hands of seven from one 28-tile set', () => {
		const deal = dealHands(createRng('reparto'), 7);
		const ids = deal.hands.flatMap((tiles) => tiles.map(tileId));

		assert.deepEqual(
			deal.hands.map((tiles) => tiles.length),
			[7, 7, 7, 7],
		);
		assert.equal(new Set(ids).size, 28, 'no tile is dealt twice');
		assert.equal(sumPips(deal.hands.flat()), 168, 'every pip is dealt');
	});

	it('deals the same tiles for the same seed and different ones otherwise', () => {
		const a = dealHands(createRng(5), 7).hands.map((tiles) => tiles.map(tileId));
		const b = dealHands(createRng(5), 7).hands.map((tiles) => tiles.map(tileId));
		const c = dealHands(createRng(6), 7).hands.map((tiles) => tiles.map(tileId));

		assert.deepEqual(a, b);
		assert.notDeepEqual(a, c);
	});

	it('advances the generator, so the next hand is a different deal', () => {
		const first = dealHands(createRng(5), 7);
		const second = dealHands(first.rng, 7);
		assert.notDeepEqual(
			first.hands.map((tiles) => tiles.map(tileId)),
			second.hands.map((tiles) => tiles.map(tileId)),
		);
	});
});

describe('playing a hand', () => {
	it('rejects a move from the wrong seat', () => {
		const state = table({ hands: [['6|6'], ['5|5'], ['4|4'], ['3|3']], turn: 0 });
		assert.throws(
			() => applyHandMove(state, { type: 'play', seat: 1, tile: t('5|5'), end: 'left' }, HOUSE),
			(error: unknown) => error instanceof EngineError && error.code === 'NOT_YOUR_TURN',
		);
	});

	it('passes the turn on in seat order', () => {
		const state = table({ hands: [['6|6', '5|4'], ['6|5'], ['4|4'], ['3|3']], turn: 0 });
		const after = applyHandMove(
			state,
			{ type: 'play', seat: 0, tile: t('6|6'), end: 'left' },
			HOUSE,
		);
		assert.equal(after.turn, 1);
		assert.equal(formatBoard(after.board), '[6|6]');
	});

	it('leaves the state it was given untouched', () => {
		const state = table({ hands: [['6|6'], ['6|5'], ['4|4'], ['3|3']], turn: 0 });
		applyHandMove(state, { type: 'play', seat: 0, tile: t('6|6'), end: 'left' }, HOUSE);
		assert.equal(state.hands[0].length, 1);
		assert.equal(state.board.length, 0);
		assert.equal(state.turn, 0);
	});

	it('will not let a player pass while holding a playable tile', () => {
		const state = table({ hands: [['6|5'], ['5|5'], ['4|4'], ['3|3']], board: ['6|6'], turn: 0 });
		assert.ok(!turnMustPass(state));
		assert.throws(
			() => applyHandMove(state, { type: 'pass', seat: 0 }, HOUSE),
			(error: unknown) => error instanceof EngineError && error.code === 'ILLEGAL_PASS',
		);
	});

	it('offers the pass, and only the pass, when nothing fits', () => {
		const state = table({ hands: [['4|2'], ['5|5'], ['4|4'], ['3|3']], board: ['6|6'], turn: 0 });
		assert.ok(turnMustPass(state));
		assert.deepEqual(legalHandMoves(state), [{ type: 'pass', seat: 0 }]);
	});

	it('holds the opener to the tile the rules demand', () => {
		const state = table({
			hands: [['6|6', '5|4'], ['5|5'], ['4|4'], ['3|3']],
			turn: 0,
			starter: 0,
			mustOpenWith: '6|6',
		});
		const openings = legalHandMoves(state).flatMap((move) =>
			move.type === 'play' ? [tileId(move.tile)] : [],
		);
		assert.deepEqual(openings, ['6|6']);
	});

	it('stops constraining the opener once the table has a tile on it', () => {
		const opened = table({
			hands: [['6|6', '5|4'], ['5|5'], ['4|4'], ['3|3']],
			turn: 0,
			starter: 0,
			mustOpenWith: '6|6',
		});
		const after = applyHandMove(
			opened,
			{ type: 'play', seat: 0, tile: t('6|6'), end: 'left' },
			HOUSE,
		);
		assert.equal(after.mustOpenWith !== null, true, 'the obligation is remembered');
		assert.equal(after.board.length, 1, 'but it no longer applies');
	});

	it('refuses any further move once the hand is settled', () => {
		const state = table({ hands: [['6|6'], ['5|5'], ['4|4'], ['3|3']], board: ['6|5'], turn: 0 });
		const finished = applyHandMove(
			state,
			{ type: 'play', seat: 0, tile: t('6|6'), end: 'left' },
			HOUSE,
		);
		assert.equal(finished.status, 'finished');
		assert.throws(
			() => applyHandMove(finished, { type: 'pass', seat: 1 }, HOUSE),
			(error: unknown) => error instanceof EngineError && error.code === 'HAND_FINISHED',
		);
	});
});

describe('ending a hand', () => {
	it('settles as a dominó when a player empties their hand', () => {
		const state = table({
			hands: [['6|1'], ['5|5'], ['4|4', '2|0'], ['3|3']],
			board: ['6|6'],
			turn: 0,
		});
		const after = applyHandMove(
			state,
			{ type: 'play', seat: 0, tile: t('6|1'), end: 'left' },
			HOUSE,
		);

		assert.equal(after.status, 'finished');
		assert.equal(after.result?.outcome, 'domino');
		assert.equal(after.result?.winningTeam, 0);
		assert.equal(after.result?.closingSeat, 0);
		// 10 held by West, 10 by North, 6 by East.
		assert.equal(after.result?.points, 26);
		assert.equal(after.result?.nextStarter, 0, 'the winner leads the next hand');
	});

	it('adds the capicúa bonus when the closing tile fitted both ends', () => {
		const state = table({
			hands: [['5|3'], ['6|6'], ['1|1'], ['2|2']],
			board: ['3|1', '1|5'],
			turn: 0,
		});
		const after = applyHandMove(
			state,
			{ type: 'play', seat: 0, tile: t('5|3'), end: 'left' },
			HOUSE,
		);

		assert.equal(after.result?.capicua, true);
		assert.equal(after.result?.pipPoints, 18);
		assert.equal(after.result?.points, 43, '18 pips plus the 25-point bonus');
	});

	it('settles as a tranca after four passes in a row', () => {
		// Both ends show 3, and nobody holds a 3.
		const start = table({
			hands: [['6|6'], ['4|2'], ['1|0'], ['2|1']],
			board: ['3|3'],
			turn: 0,
			starter: 3,
		});
		const after = play(start, [
			{ type: 'pass', seat: 0 },
			{ type: 'pass', seat: 1 },
			{ type: 'pass', seat: 2 },
			{ type: 'pass', seat: 3 },
		]);

		assert.equal(after.status, 'finished');
		assert.equal(after.result?.outcome, 'tranca');
		assert.deepEqual(after.result?.pipsByTeam, [13, 9]);
		assert.equal(after.result?.winningTeam, 1, 'the lighter side takes a blocked hand');
		assert.equal(after.result?.points, 22, 'and by default takes every pip on the table');
	});

	it('settles a blocked hand with equal pips as a tie worth nothing', () => {
		const start = table({
			hands: [['6|6'], ['6|4'], ['1|0'], ['2|1']],
			board: ['3|3'],
			turn: 0,
			starter: 3,
		});
		const after = play(start, [
			{ type: 'pass', seat: 0 },
			{ type: 'pass', seat: 1 },
			{ type: 'pass', seat: 2 },
			{ type: 'pass', seat: 3 },
		]);

		assert.equal(after.result?.outcome, 'tie');
		assert.equal(after.result?.winningTeam, null);
		assert.equal(after.result?.points, 0);
		assert.deepEqual(after.result?.pipsByTeam, [13, 13]);
		assert.equal(after.result?.nextStarter, 3, 'the same seat leads again');
	});

	it('does not settle when the passes are interrupted by a play', () => {
		const start = table({
			hands: [['4|2'], ['3|1', '6|6'], ['4|0'], ['2|2']],
			board: ['3|3'],
			turn: 0,
		});
		const after = play(start, [
			{ type: 'pass', seat: 0 },
			{ type: 'play', seat: 1, tile: t('3|1'), end: 'left' },
			{ type: 'pass', seat: 2 },
			{ type: 'pass', seat: 3 },
			{ type: 'pass', seat: 0 },
		]);

		assert.equal(after.status, 'playing');
		assert.equal(after.consecutivePasses, 3);
	});
});
