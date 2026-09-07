import type {
	IDataObject,
	IExecuteFunctions,
	INode,
	INodeExecutionData,
	INodeType,
	INodeTypeDescription,
} from 'n8n-workflow';
import { NodeOperationError } from 'n8n-workflow';

import {
	applyMove,
	advance,
	createMatch,
	deserializeMatch,
	deserializeMove,
	legalMoves,
	observationFor,
	serializeMatch,
	serializeMove,
	summarize,
	tileId,
	type MatchState,
	type RngState,
	type RuleOverrides,
	type Seat,
} from '../../src/engine';
import { botMove, playMatch, seatingFromNames } from '../../src/bots';

/**
 * Workflow access to the dominoes engine.
 *
 * The engine itself lives in `src/` and knows nothing about n8n. Because every match
 * state round-trips through JSON, a workflow can hold a game between executions: feed the
 * `state` back in on the next call and carry on where it left off.
 */
export class DominicanDominoes implements INodeType {
	description: INodeTypeDescription = {
		displayName: 'Dominican Dominoes',
		name: 'dominicanDominoes',
		icon: 'file:dominoes.svg',
		group: ['transform'],
		version: 1,
		subtitle: '={{$parameter["operation"]}}',
		description: 'Deal, play and score games of Dominican dominoes',
		defaults: {
			name: 'Dominican Dominoes',
		},
		inputs: ['main'],
		outputs: ['main'],
		properties: [
			{
				displayName: 'Operation',
				name: 'operation',
				type: 'options',
				noDataExpression: true,
				default: 'newMatch',
				options: [
					{
						name: 'Apply Move',
						value: 'applyMove',
						description: 'Play one move and return the resulting state',
						action: 'Apply a move',
					},
					{
						name: 'Bot Move',
						value: 'botMove',
						description: 'Let a bot choose and play the move for the seat on turn',
						action: 'Let a bot move',
					},
					{
						name: 'Get Legal Moves',
						value: 'legalMoves',
						description: 'List the moves available to the seat on turn',
						action: 'Get legal moves',
					},
					{
						name: 'Get Observation',
						value: 'observation',
						description: "Return one seat's view of the table, without the other hands",
						action: 'Get an observation',
					},
					{
						name: 'New Match',
						value: 'newMatch',
						description: 'Shuffle, deal and return a fresh match state',
						action: 'Start a new match',
					},
					{
						name: 'Play Out',
						value: 'playOut',
						description: 'Play a whole match between four bots and return the result',
						action: 'Play a match out',
					},
				],
			},
			{
				displayName: 'Seed',
				name: 'seed',
				type: 'string',
				default: '',
				placeholder: 'domingo',
				description:
					'Seed for the shuffle. The same seed always deals the same match. Leave empty for a random deal.',
				displayOptions: {
					show: {
						operation: ['newMatch', 'playOut'],
					},
				},
			},
			{
				displayName: 'Target Score',
				name: 'targetScore',
				type: 'number',
				default: 200,
				typeOptions: {
					minValue: 1,
				},
				description: 'Points that win the match',
				displayOptions: {
					show: {
						operation: ['newMatch', 'playOut'],
					},
				},
			},
			{
				displayName: 'Match State',
				name: 'state',
				type: 'json',
				default: '',
				description:
					'A match state as returned by a previous call. Defaults to the "state" property of the incoming item.',
				displayOptions: {
					show: {
						operation: ['applyMove', 'botMove', 'legalMoves', 'observation'],
					},
				},
			},
			{
				displayName: 'Move',
				name: 'move',
				type: 'json',
				default: '={{ { "type": "play", "seat": 0, "tile": "6|6", "end": "left" } }}',
				description:
					'The move to play, as { type, seat, tile, end }. Use "pass" as the type when no tile fits.',
				displayOptions: {
					show: {
						operation: ['applyMove'],
					},
				},
			},
			{
				displayName: 'Seat',
				name: 'seat',
				type: 'options',
				default: 0,
				description: 'Which seat to report on. Seats 0 and 2 are partners, as are 1 and 3.',
				options: [
					{ name: 'Seat 0 (South)', value: 0 },
					{ name: 'Seat 1 (West)', value: 1 },
					{ name: 'Seat 2 (North)', value: 2 },
					{ name: 'Seat 3 (East)', value: 3 },
				],
				displayOptions: {
					show: {
						operation: ['observation'],
					},
				},
			},
			{
				displayName: 'Bot',
				name: 'bot',
				type: 'options',
				default: 'strategic',
				description: 'Policy the bot plays with',
				options: [
					{ name: 'Random', value: 'random' },
					{ name: 'Greedy', value: 'greedy' },
					{ name: 'Strategic', value: 'strategic' },
				],
				displayOptions: {
					show: {
						operation: ['botMove'],
					},
				},
			},
			{
				displayName: 'Seating',
				name: 'seating',
				type: 'string',
				default: 'strategic,strategic,strategic,strategic',
				placeholder: 'strategic,greedy,strategic,greedy',
				description: 'Comma-separated bot per seat, in seat order',
				displayOptions: {
					show: {
						operation: ['playOut'],
					},
				},
			},
			{
				displayName: 'Deal Next Hand',
				name: 'autoAdvance',
				type: 'boolean',
				default: true,
				description:
					'Whether to deal the next hand automatically when a move settles the current one',
				displayOptions: {
					show: {
						operation: ['applyMove', 'botMove'],
					},
				},
			},
		],
	};

	async execute(this: IExecuteFunctions): Promise<INodeExecutionData[][]> {
		const items = this.getInputData();
		const output: INodeExecutionData[] = [];

		for (let itemIndex = 0; itemIndex < items.length; itemIndex++) {
			const item = items[itemIndex];
			try {
				const operation = this.getNodeParameter('operation', itemIndex) as string;
				const json = runOperation(this, operation, itemIndex, item);
				output.push({ json, pairedItem: itemIndex });
			} catch (error) {
				if (this.continueOnFail()) {
					output.push({
						json: item.json,
						error: error as NodeOperationError,
						pairedItem: itemIndex,
					});
					continue;
				}
				throw asNodeError(this.getNode(), error, itemIndex);
			}
		}

		return [output];
	}
}

/**
 * Wraps an engine error so the workflow actually sees what went wrong.
 *
 * n8n replaces the message of anything that is not one of its own error types with
 * "Internal error", which would turn every rules violation — wrong seat, illegal
 * placement, malformed state — into the same useless line. Passing `message` explicitly
 * keeps the engine's own wording, and the machine-readable code goes in the description.
 */
function asNodeError(node: INode, error: unknown, itemIndex: number): NodeOperationError {
	if (error instanceof NodeOperationError) {
		return error;
	}

	const cause = error instanceof Error ? error : new Error(String(error));
	const code = (error as { code?: unknown }).code;

	return new NodeOperationError(node, cause, {
		itemIndex,
		message: cause.message,
		description: typeof code === 'string' ? `Engine error code: ${code}` : undefined,
	});
}

function runOperation(
	context: IExecuteFunctions,
	operation: string,
	itemIndex: number,
	item: INodeExecutionData,
): IDataObject {
	switch (operation) {
		case 'newMatch':
			return newMatch(context, itemIndex);
		case 'legalMoves':
			return listLegalMoves(context, itemIndex, item);
		case 'observation':
			return observation(context, itemIndex, item);
		case 'applyMove':
			return applyOneMove(context, itemIndex, item);
		case 'botMove':
			return applyBotMove(context, itemIndex, item);
		case 'playOut':
			return playOut(context, itemIndex);
		default:
			throw new NodeOperationError(context.getNode(), `unknown operation "${operation}"`, {
				itemIndex,
			});
	}
}

function rulesFrom(context: IExecuteFunctions, itemIndex: number): RuleOverrides {
	return { targetScore: context.getNodeParameter('targetScore', itemIndex, 200) as number };
}

function seedFrom(context: IExecuteFunctions, itemIndex: number): number | string {
	const raw = (context.getNodeParameter('seed', itemIndex, '') as string).trim();
	if (raw === '') return Date.now();
	const numeric = Number(raw);
	return Number.isFinite(numeric) ? numeric : raw;
}

/**
 * Reads the match state from the parameter, falling back to the incoming item.
 *
 * The item is passed in rather than fetched: `getInputData(n)` selects an input *branch*,
 * not the nth item, so using it here would read the wrong thing the moment a batch of more
 * than one item arrives.
 */
function stateFrom(
	context: IExecuteFunctions,
	itemIndex: number,
	item: INodeExecutionData,
): MatchState {
	const parameter = context.getNodeParameter('state', itemIndex, '') as unknown;
	const candidate =
		parameter === '' || parameter === undefined || parameter === null
			? (item.json as IDataObject).state
			: parameter;

	if (candidate === undefined || candidate === null) {
		throw new NodeOperationError(
			context.getNode(),
			'No match state supplied; set the "Match State" field or pass a "state" property on the item',
			{ itemIndex },
		);
	}

	return deserializeMatch(typeof candidate === 'string' ? JSON.parse(candidate) : candidate);
}

function describeState(state: MatchState): IDataObject {
	return {
		state: serializeMatch(state) as unknown as IDataObject,
		turn: state.hand.turn,
		handNumber: state.hand.handNumber,
		scores: [state.scores[0], state.scores[1]],
		handStatus: state.hand.status,
		matchStatus: state.status,
		winner: state.winner,
		result: (state.hand.result ?? null) as unknown as IDataObject | null,
	};
}

function newMatch(context: IExecuteFunctions, itemIndex: number): IDataObject {
	const state = createMatch({
		seed: seedFrom(context, itemIndex),
		rules: rulesFrom(context, itemIndex),
	});
	return describeState(state);
}

function listLegalMoves(
	context: IExecuteFunctions,
	itemIndex: number,
	item: INodeExecutionData,
): IDataObject {
	const state = stateFrom(context, itemIndex, item);
	return {
		turn: state.hand.turn,
		handNumber: state.hand.handNumber,
		moves: legalMoves(state).map(serializeMove) as unknown as IDataObject[],
	};
}

function observation(
	context: IExecuteFunctions,
	itemIndex: number,
	item: INodeExecutionData,
): IDataObject {
	const state = stateFrom(context, itemIndex, item);
	const seat = context.getNodeParameter('seat', itemIndex, 0) as Seat;
	const view = observationFor(state, seat);

	return {
		seat: view.seat,
		partner: view.partner,
		team: view.team,
		isMyTurn: view.isMyTurn,
		hand: view.hand.map(tileId),
		tileCounts: [...view.tileCounts],
		ends: view.ends === null ? null : { left: view.ends.left, right: view.ends.right },
		board: view.board.map((placed) => tileId(placed.tile)),
		unseen: view.unseen.map(tileId),
		knownVoids: view.knownVoids.map((row) => [...row]),
		scores: [...view.scores],
		legalMoves: view.legalMoves.map(serializeMove) as unknown as IDataObject[],
	};
}

function applyOneMove(
	context: IExecuteFunctions,
	itemIndex: number,
	item: INodeExecutionData,
): IDataObject {
	const state = stateFrom(context, itemIndex, item);
	const raw = context.getNodeParameter('move', itemIndex) as unknown;
	const move = deserializeMove(typeof raw === 'string' ? JSON.parse(raw) : raw);
	const autoAdvance = context.getNodeParameter('autoAdvance', itemIndex, true) as boolean;

	const played = applyMove(state, move);
	return describeState(autoAdvance ? advance(played) : played);
}

function applyBotMove(
	context: IExecuteFunctions,
	itemIndex: number,
	item: INodeExecutionData,
): IDataObject {
	const state = stateFrom(context, itemIndex, item);
	const name = context.getNodeParameter('bot', itemIndex, 'strategic') as string;
	const autoAdvance = context.getNodeParameter('autoAdvance', itemIndex, true) as boolean;

	const seating = seatingFromNames([name, name, name, name]);
	// Derive the bot's tie-breaking stream from the match RNG so the call stays pure: the
	// same state and the same bot always produce the same move.
	const rng: RngState = { seed: state.rng.seed, cursor: (state.rng.cursor ^ 0x5f3759df) >>> 0 };
	const decision = botMove(state, seating, rng);

	const played = applyMove(state, decision.move);
	return {
		...describeState(autoAdvance ? advance(played) : played),
		move: serializeMove(decision.move) as unknown as IDataObject,
		reason: decision.reason ?? null,
	};
}

function playOut(context: IExecuteFunctions, itemIndex: number): IDataObject {
	const names = (context.getNodeParameter('seating', itemIndex, '') as string)
		.split(',')
		.map((name) => name.trim());

	const result = playMatch({
		seating: seatingFromNames(names),
		seed: seedFrom(context, itemIndex),
		rules: rulesFrom(context, itemIndex),
	});

	const summary = summarize(result.state);
	return {
		winner: summary.winner,
		scores: [...summary.scores],
		hands: summary.hands,
		shutout: summary.shutout,
		zapato: summary.zapato,
		moves: result.plies,
		state: serializeMatch(result.state) as unknown as IDataObject,
	};
}
