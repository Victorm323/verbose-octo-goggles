/**
 * Tests for the n8n node wrapper.
 *
 * The node is driven through a stub of the small slice of `IExecuteFunctions` it actually
 * touches, so these exercise the real `execute` path — parameter reading, state coercion,
 * error handling — without needing an n8n instance.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { IDataObject, IExecuteFunctions, INodeExecutionData } from 'n8n-workflow';

import { DominicanDominoes } from '../nodes/DominicanDominoes/DominicanDominoes.node';
import { createMatch, serializeMatch } from '../src/engine';

type Params = Record<string, unknown>;

interface StubOptions {
	readonly params: Params;
	readonly items?: IDataObject[];
	readonly continueOnFail?: boolean;
}

/** The slice of the n8n execution context this node uses. */
function stub(options: StubOptions): IExecuteFunctions {
	const items: INodeExecutionData[] = (options.items ?? [{}]).map((json) => ({ json }));

	return {
		getInputData: () => items,
		getNodeParameter: (name: string, _itemIndex: number, fallback?: unknown) =>
			name in options.params ? options.params[name] : fallback,
		getNode: () => ({ name: 'Dominican Dominoes', type: 'dominicanDominoes' }),
		continueOnFail: () => options.continueOnFail === true,
	} as unknown as IExecuteFunctions;
}

async function run(options: StubOptions): Promise<IDataObject[]> {
	const node = new DominicanDominoes();
	const output = await node.execute.call(stub(options));
	return output[0].map((entry) => entry.json);
}

const FRESH = serializeMatch(createMatch({ seed: 'nodo', rules: { targetScore: 200 } }));

describe('the node description', () => {
	it('declares every operation the executor implements', () => {
		const node = new DominicanDominoes();
		const operation = node.description.properties.find((property) => property.name === 'operation');
		const values = (operation?.options ?? []).map((option) => (option as { value: string }).value);

		assert.deepEqual(values.slice().sort(), [
			'applyMove',
			'botMove',
			'legalMoves',
			'newMatch',
			'observation',
			'playOut',
		]);
	});
});

describe('newMatch', () => {
	it('deals a match and returns resumable state', async () => {
		const [result] = await run({
			params: { operation: 'newMatch', seed: 'nodo', targetScore: 200 },
		});

		assert.deepEqual(result.scores, [0, 0]);
		assert.equal(result.handNumber, 1);
		assert.equal(result.matchStatus, 'playing');
		assert.equal(result.winner, null);
		assert.deepEqual(result.state, FRESH, 'the same seed deals the same match');
	});

	it('honours the target score', async () => {
		const [result] = await run({
			params: { operation: 'newMatch', seed: '1', targetScore: 75 },
		});
		const state = result.state as unknown as typeof FRESH;
		assert.equal(state.rules.targetScore, 75);
	});
});

describe('reading state', () => {
	it('takes state from the parameter', async () => {
		const [result] = await run({
			params: { operation: 'legalMoves', state: FRESH },
		});
		assert.equal(result.turn, FRESH.hand.turn);
		assert.ok(Array.isArray(result.moves));
	});

	it('falls back to the state property on the item', async () => {
		const [result] = await run({
			params: { operation: 'legalMoves' },
			items: [{ state: FRESH as unknown as IDataObject }],
		});
		assert.equal(result.turn, FRESH.hand.turn);
	});

	it('accepts state as a JSON string', async () => {
		const [result] = await run({
			params: { operation: 'legalMoves', state: JSON.stringify(FRESH) },
		});
		assert.equal(result.turn, FRESH.hand.turn);
	});

	it('reads each item of a batch, not just the first', async () => {
		const other = serializeMatch(createMatch({ seed: 'otra', rules: { targetScore: 200 } }));
		const results = await run({
			params: { operation: 'legalMoves' },
			items: [
				{ state: FRESH as unknown as IDataObject },
				{ state: other as unknown as IDataObject },
			],
		});

		assert.equal(results.length, 2);
		assert.equal(results[0].turn, FRESH.hand.turn);
		assert.equal(results[1].turn, other.hand.turn);
	});

	it('complains when no state was supplied at all', async () => {
		await assert.rejects(
			() => run({ params: { operation: 'legalMoves' } }),
			/No match state supplied/,
		);
	});

	it('complains when the state is malformed', async () => {
		await assert.rejects(() => run({ params: { operation: 'legalMoves', state: { rng: 1 } } }));
	});
});

describe('applyMove', () => {
	it('plays the move and returns the new state', async () => {
		const opening = { type: 'play', seat: FRESH.hand.turn, tile: '6|6', end: 'left' };
		const [result] = await run({
			params: { operation: 'applyMove', state: FRESH, move: opening, autoAdvance: true },
		});

		const state = result.state as unknown as typeof FRESH;
		assert.equal(state.hand.board.length, 1);
		assert.equal(state.hand.board[0].tile, '6|6');
		assert.equal(result.turn, (FRESH.hand.turn + 1) % 4);
	});

	it('accepts the move as a JSON string', async () => {
		const opening = JSON.stringify({
			type: 'play',
			seat: FRESH.hand.turn,
			tile: '6|6',
			end: 'left',
		});
		const [result] = await run({
			params: { operation: 'applyMove', state: FRESH, move: opening },
		});
		const state = result.state as unknown as typeof FRESH;
		assert.equal(state.hand.board.length, 1);
	});

	it('rejects a move from the wrong seat', async () => {
		const wrongSeat = { type: 'play', seat: (FRESH.hand.turn + 1) % 4, tile: '6|6', end: 'left' };
		await assert.rejects(
			() => run({ params: { operation: 'applyMove', state: FRESH, move: wrongSeat } }),
			/turn/i,
		);
	});

	it('rejects an illegal opening under the double-six rule', async () => {
		const notTheDouble = { type: 'play', seat: FRESH.hand.turn, tile: '0|0', end: 'left' };
		await assert.rejects(() =>
			run({ params: { operation: 'applyMove', state: FRESH, move: notTheDouble } }),
		);
	});
});

describe('botMove', () => {
	it('picks a move, plays it and says why', async () => {
		const [result] = await run({
			params: { operation: 'botMove', state: FRESH, bot: 'strategic', autoAdvance: true },
		});

		assert.deepEqual(result.move, {
			type: 'play',
			seat: FRESH.hand.turn,
			tile: '6|6',
			end: 'left',
		});
		assert.equal(typeof result.reason, 'string');
	});

	it('is deterministic for the same state', async () => {
		const params = { operation: 'botMove', state: FRESH, bot: 'strategic' };
		const [first] = await run({ params });
		const [second] = await run({ params });
		assert.deepEqual(first, second);
	});

	it('refuses a bot it does not know', async () => {
		await assert.rejects(
			() => run({ params: { operation: 'botMove', state: FRESH, bot: 'genius' } }),
			/unknown bot/,
		);
	});
});

describe('observation', () => {
	it('shows the asked-for seat its own tiles and nobody else’s', async () => {
		const [result] = await run({
			params: { operation: 'observation', state: FRESH, seat: 1 },
		});

		assert.equal(result.seat, 1);
		assert.equal(result.partner, 3);
		assert.equal(result.team, 1);
		assert.equal((result.hand as string[]).length, 7);
		assert.equal((result.unseen as string[]).length, 21);
		assert.deepEqual(result.tileCounts, [7, 7, 7, 7]);
		assert.equal(JSON.stringify(result).includes('"hands"'), false, 'no other hand leaks out');
	});
});

describe('playOut', () => {
	it('plays a whole match and reports the outcome', async () => {
		const [result] = await run({
			params: {
				operation: 'playOut',
				seed: '12',
				targetScore: 100,
				seating: 'strategic,greedy,strategic,greedy',
			},
		});

		assert.ok(result.winner === 0 || result.winner === 1);
		assert.ok((result.hands as number) >= 1);
		assert.ok((result.moves as number) > 0);
		const scores = result.scores as [number, number];
		assert.ok(Math.max(...scores) >= 100);
	});

	it('refuses a seating that is not four bots', async () => {
		await assert.rejects(
			() => run({ params: { operation: 'playOut', seed: '1', seating: 'greedy,greedy' } }),
			/four bot names/,
		);
	});
});

describe('error handling', () => {
	it('refuses an operation it does not know', async () => {
		await assert.rejects(() => run({ params: { operation: 'shuffle' } }), /unknown operation/);
	});

	it('passes the item through with an error when continueOnFail is set', async () => {
		const results = await run({
			params: { operation: 'legalMoves' },
			items: [{ marker: 'kept' }],
			continueOnFail: true,
		});

		assert.equal(results.length, 1);
		assert.equal(results[0].marker, 'kept');
	});

	it('keeps going through a batch when one item fails', async () => {
		const node = new DominicanDominoes();
		const output = await node.execute.call(
			stub({
				params: { operation: 'legalMoves' },
				items: [{ marker: 'bad' }, { state: FRESH as unknown as IDataObject }],
				continueOnFail: true,
			}),
		);

		assert.equal(output[0].length, 2);
		assert.ok(output[0][0].error !== undefined, 'the bad item carries its error');
		assert.equal(output[0][1].json.turn, FRESH.hand.turn, 'the good item still ran');
	});
});
