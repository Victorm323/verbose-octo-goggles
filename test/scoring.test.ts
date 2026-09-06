import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
	applyResultToScores,
	pipsByTeam,
	pipsBySeat,
	settleDomino,
	settleTranca,
} from '../src/engine';
import type { Hands } from '../src/engine';
import { hand, rules } from './helpers';

const HANDS: Hands = [hand(), hand('6|6', '2|1'), hand('4|4'), hand('3|0')];

describe('settling a dominó', () => {
	it('pays the winning team every pip left in the other three hands', () => {
		const result = settleDomino({
			handNumber: 1,
			hands: HANDS,
			closingSeat: 0,
			capicua: false,
			rules: rules(),
		});

		assert.equal(result.outcome, 'domino');
		assert.equal(result.winningTeam, 0);
		assert.equal(result.pipPoints, 15 + 8 + 3);
		assert.equal(result.points, 26);
		assert.equal(result.capicua, false);
		assert.deepEqual(result.pipsBySeat, [0, 15, 8, 3]);
		assert.deepEqual(result.pipsByTeam, [8, 18]);
	});

	it('adds the capicúa bonus on top of the pips', () => {
		const result = settleDomino({
			handNumber: 2,
			hands: HANDS,
			closingSeat: 0,
			capicua: true,
			rules: rules(),
		});

		assert.equal(result.pipPoints, 26);
		assert.equal(result.points, 51);
		assert.equal(result.capicua, true);
	});

	it('honours a house that pays a different bonus', () => {
		const result = settleDomino({
			handNumber: 3,
			hands: HANDS,
			closingSeat: 0,
			capicua: true,
			rules: rules({ capicuaBonus: 30 }),
		});
		assert.equal(result.points, 56);
	});

	it('hands the lead to whoever went out', () => {
		const result = settleDomino({
			handNumber: 4,
			hands: [hand('6|6'), hand(), hand('4|4'), hand('3|0')],
			closingSeat: 1,
			capicua: false,
			rules: rules(),
		});
		assert.equal(result.winningTeam, 1);
		assert.equal(result.nextStarter, 1);
	});
});

describe('settling a tranca', () => {
	const blocked: Hands = [hand('6|6'), hand('2|1'), hand('1|0'), hand('3|2')];
	// Team 0 holds 13 pips, team 1 holds 8.

	it('pays the lighter side every pip on the table by default', () => {
		const result = settleTranca({
			handNumber: 1,
			hands: blocked,
			blockingSeat: 2,
			starter: 0,
			rules: rules(),
		});

		assert.equal(result.outcome, 'tranca');
		assert.deepEqual(result.pipsByTeam, [13, 8]);
		assert.equal(result.winningTeam, 1);
		assert.equal(result.points, 21);
	});

	it('pays only the losing side when the house plays it that way', () => {
		const result = settleTranca({
			handNumber: 1,
			hands: blocked,
			blockingSeat: 2,
			starter: 0,
			rules: rules({ trancaScoring: 'opponents-only' }),
		});
		assert.equal(result.points, 13);
	});

	it('gives the lead to the seat that locked the game', () => {
		const result = settleTranca({
			handNumber: 1,
			hands: blocked,
			blockingSeat: 2,
			starter: 0,
			rules: rules(),
		});
		assert.equal(result.nextStarter, 2);
	});

	it('gives the lead to the winning side’s lighter hand under the other rule', () => {
		const result = settleTranca({
			handNumber: 1,
			hands: blocked,
			blockingSeat: 2,
			starter: 0,
			rules: rules({ trancaStarter: 'winner-side' }),
		});
		// Team 1 won; East holds 5 pips against West's 3, so West leads.
		assert.equal(result.nextStarter, 1);
	});

	it('never awards a capicúa on a blocked hand', () => {
		const result = settleTranca({
			handNumber: 1,
			hands: blocked,
			blockingSeat: 2,
			starter: 0,
			rules: rules(),
		});
		assert.equal(result.capicua, false);
	});

	it('scores a tie at nothing and returns the lead to the opener', () => {
		const level: Hands = [hand('6|6'), hand('6|4'), hand('1|0'), hand('2|1')];
		const result = settleTranca({
			handNumber: 1,
			hands: level,
			blockingSeat: 2,
			starter: 3,
			rules: rules(),
		});

		assert.equal(result.outcome, 'tie');
		assert.equal(result.winningTeam, null);
		assert.equal(result.points, 0);
		assert.equal(result.nextStarter, 3);
	});
});

describe('pip arithmetic', () => {
	it('totals by seat and folds partners together', () => {
		const perSeat = pipsBySeat(HANDS);
		assert.deepEqual(perSeat, [0, 15, 8, 3]);
		assert.deepEqual(pipsByTeam(perSeat), [8, 18]);
	});

	it('adds a result only to the team that won it', () => {
		const result = settleDomino({
			handNumber: 1,
			hands: HANDS,
			closingSeat: 0,
			capicua: false,
			rules: rules(),
		});
		assert.deepEqual(applyResultToScores([10, 20], result), [36, 20]);
	});

	it('leaves both scores alone after a tie', () => {
		const level: Hands = [hand('6|6'), hand('6|4'), hand('1|0'), hand('2|1')];
		const tie = settleTranca({
			handNumber: 1,
			hands: level,
			blockingSeat: 2,
			starter: 0,
			rules: rules(),
		});
		assert.deepEqual(applyResultToScores([10, 20], tie), [10, 20]);
	});
});
