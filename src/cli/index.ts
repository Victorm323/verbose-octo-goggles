#!/usr/bin/env node
/**
 * Command line front end for the engine.
 *
 *   dominoes simulate --matches 500 --bots strategic,greedy,strategic,greedy
 *   dominoes replay   --seed domingo --hands
 *   dominoes play     --seat 0 --bots strategic,strategic,strategic
 */

import { createInterface } from 'node:readline';

import {
	advance,
	applyMove,
	createMatch,
	describeMove,
	describeResult,
	formatBoard,
	formatScores,
	formatTiles,
	observationFor,
	seatLabel,
	SEAT_LABELS,
	summarize,
	sumPips,
	TEAM_LABELS,
	type MatchState,
	type Move,
	type RngState,
	type RuleOverrides,
	type Seat,
} from '../engine';
import { botMove, runTournament, seatingFromNames, type Seating } from '../bots';
import { flagBoolean, flagNumber, flagSeed, flagString, parseArgs, type ParsedArgs } from './args';

const DEFAULT_BOTS = 'strategic,greedy,strategic,greedy';

const USAGE = `Dominican dominoes engine

Usage:
  dominoes <command> [options]

Commands:
  simulate    Play many matches between bots and report how the seats did
  replay      Play a single match and narrate every move
  play        Take a seat yourself against three bots

Options:
  --seed <value>      Seed; numbers and words both work (default 1)
  --bots <a,b,c,d>    Bot per seat: random | greedy | strategic
                      (default ${DEFAULT_BOTS})
  --target <n>        Points that win the match (default 200)
  --matches <n>       simulate: how many matches to play (default 200)
  --hands             replay: show every hand after each move
  --seat <0-3>        play: which seat is yours (default 0)
  --help              Show this message

Seats run counter-clockwise. Seats 0 and 2 are partners, as are 1 and 3.
`;

async function main(argv: readonly string[]): Promise<number> {
	const args = parseArgs(argv);

	if (args.flags.help === true || args.command === '' || args.command === 'help') {
		process.stdout.write(USAGE);
		return 0;
	}

	switch (args.command) {
		case 'simulate':
			return simulate(args);
		case 'replay':
			return replay(args);
		case 'play':
			return play(args);
		default:
			process.stderr.write(`unknown command "${args.command}"\n\n${USAGE}`);
			return 1;
	}
}

function rulesFrom(args: ParsedArgs): RuleOverrides {
	const target = flagNumber(args, 'target', 200);
	return { targetScore: target };
}

function seatingFrom(args: ParsedArgs, exclude?: Seat): Seating {
	const names = flagString(args, 'bots', DEFAULT_BOTS)
		.split(',')
		.map((name) => name.trim());

	// `play` only needs three bots; the human's seat is filled with a placeholder that is
	// never asked for a move.
	if (exclude !== undefined && names.length === 3) {
		const filled = names.slice();
		filled.splice(exclude, 0, names[0]);
		return seatingFromNames(filled);
	}

	return seatingFromNames(names);
}

function simulate(args: ParsedArgs): number {
	const matches = Math.max(1, Math.floor(flagNumber(args, 'matches', 200)));
	const seating = seatingFrom(args);
	const seed = flagSeed(args, 'seed', 1);

	const started = Date.now();
	const result = runTournament(seating, matches, seed, rulesFrom(args));
	const elapsed = Date.now() - started;

	const lines = [
		`${matches} matches, seed ${seed}`,
		`Seating: ${seating.map((bot, seat) => `${SEAT_LABELS[seat]}=${bot.name}`).join('  ')}`,
		'',
	];

	for (const team of [0, 1] as const) {
		const wins = result.winsByTeam[team];
		const share = ((wins / matches) * 100).toFixed(1);
		lines.push(
			`${TEAM_LABELS[team].padEnd(12)} ${String(wins).padStart(5)} wins  ${share.padStart(5)}%  ` +
				`${result.shutouts[team]} pollonas`,
		);
	}

	lines.push(
		'',
		`Average ${result.averageHands.toFixed(1)} hands and ${result.averagePlies.toFixed(0)} moves per match`,
		`Finished in ${elapsed} ms`,
	);

	process.stdout.write(`${lines.join('\n')}\n`);
	return 0;
}

function replay(args: ParsedArgs): number {
	const seating = seatingFrom(args);
	const seed = flagSeed(args, 'seed', 1);
	const showHands = flagBoolean(args, 'hands');

	let state = createMatch({ seed, rules: rulesFrom(args) });
	let rng: RngState = { seed: state.rng.seed, cursor: (state.rng.cursor ^ 0x5f3759df) >>> 0 };

	const out = (line: string) => process.stdout.write(`${line}\n`);

	out(`Seed ${seed} — ${formatScores(state)}`);
	out(`Seating: ${seating.map((bot, seat) => `${SEAT_LABELS[seat]}=${bot.name}`).join('  ')}`);

	while (state.status === 'playing') {
		if (state.hand.status === 'finished') {
			state = advance(state);
			continue;
		}

		if (state.hand.log.length === 0) {
			out('');
			out(`--- Hand ${state.hand.handNumber} — ${seatLabel(state.hand.starter)} leads`);
			if (showHands) out(handsBlock(state));
		}

		const decision = botMove(state, seating, rng);
		rng = decision.rng;
		state = applyMove(state, decision.move);

		out(`  ${describeMove(decision.move).padEnd(38)} ${formatBoard(state.hand.board)}`);
		if (decision.reason !== undefined) out(`      ${decision.reason}`);

		const result = state.hand.result;
		if (result !== null) {
			if (showHands) out(handsBlock(state));
			out(`  ${describeResult(result)}`);
			out(`  ${formatScores(state)}`);
			state = advance(state);
		}
	}

	const summary = summarize(state);
	out('');
	out(
		summary.winner === null
			? 'Match ended without a winner.'
			: `${TEAM_LABELS[summary.winner]} win ${summary.scores[0]}—${summary.scores[1]} in ${summary.hands} hands` +
					`${summary.shutout ? ' (pollona!)' : summary.zapato ? ' (zapato)' : ''}.`,
	);
	return 0;
}

function handsBlock(state: MatchState): string {
	return state.hand.hands
		.map(
			(tiles, seat) =>
				`      ${SEAT_LABELS[seat].padEnd(6)} ${formatTiles(tiles) || '(empty)'} = ${sumPips(tiles)}`,
		)
		.join('\n');
}

async function play(args: ParsedArgs): Promise<number> {
	const mySeat = Math.min(3, Math.max(0, Math.floor(flagNumber(args, 'seat', 0)))) as Seat;
	const seating = seatingFrom(args, mySeat);
	const seed = flagSeed(args, 'seed', Date.now());

	let state = createMatch({ seed, rules: rulesFrom(args) });
	let rng: RngState = { seed: state.rng.seed, cursor: (state.rng.cursor ^ 0x5f3759df) >>> 0 };

	const rl = createInterface({ input: process.stdin, output: process.stdout });
	const ask = (question: string) =>
		new Promise<string>((resolve) => rl.question(question, resolve));
	const out = (line: string) => process.stdout.write(`${line}\n`);

	out(`You are ${seatLabel(mySeat)}. Your partner is ${SEAT_LABELS[(mySeat + 2) % 4]}.`);
	out(`Playing to ${state.rules.targetScore}. Seed ${seed}.`);

	try {
		while (state.status === 'playing') {
			if (state.hand.status === 'finished') {
				state = advance(state);
				continue;
			}

			if (state.hand.turn !== mySeat) {
				const decision = botMove(state, seating, rng);
				rng = decision.rng;
				state = applyMove(state, decision.move);
				out(`  ${describeMove(decision.move)}`);
			} else {
				const observation = observationFor(state, mySeat);
				out('');
				out(`Table: ${formatBoard(state.hand.board)}`);
				out(`Others hold: ${describeCounts(state)}`);
				out(`Your tiles: ${formatTiles(observation.hand)} (${sumPips(observation.hand)} pips)`);

				const moves = observation.legalMoves;
				const chosen = await chooseMove(moves, ask, out);
				state = applyMove(state, chosen);
				out(`  ${describeMove(chosen)}`);
			}

			const result = state.hand.result;
			if (result !== null) {
				out('');
				out(describeResult(result));
				out(formatScores(state));
				state = advance(state);
			}
		}
	} finally {
		rl.close();
	}

	const summary = summarize(state);
	out('');
	if (summary.winner === null) {
		out('Match ended without a winner.');
	} else {
		const mine = summary.winner === mySeat % 2;
		out(
			`${TEAM_LABELS[summary.winner]} win ${summary.scores[0]}—${summary.scores[1]}. ${mine ? 'That is you.' : 'Better luck next time.'}`,
		);
	}
	return 0;
}

function describeCounts(state: MatchState): string {
	return state.hand.hands.map((tiles, seat) => `${SEAT_LABELS[seat]} ${tiles.length}`).join(', ');
}

async function chooseMove(
	moves: readonly Move[],
	ask: (question: string) => Promise<string>,
	out: (line: string) => void,
): Promise<Move> {
	if (moves.length === 1) {
		out(`Only one move available: ${describeMove(moves[0])}`);
		return moves[0];
	}

	moves.forEach((move, index) => out(`  ${index + 1}) ${describeMove(move)}`));

	for (;;) {
		const answer = (await ask('Your move (number): ')).trim();
		const index = Number(answer) - 1;
		if (Number.isInteger(index) && index >= 0 && index < moves.length) {
			return moves[index];
		}
		out(`Pick a number between 1 and ${moves.length}.`);
	}
}

main(process.argv.slice(2))
	.then((code) => {
		process.exitCode = code;
	})
	.catch((error: unknown) => {
		process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
		process.exitCode = 1;
	});
