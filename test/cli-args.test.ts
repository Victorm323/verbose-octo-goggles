import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { flagBoolean, flagNumber, flagSeed, flagString, parseArgs } from '../src/cli/args';

describe('parsing arguments', () => {
	it('reads the command from the first positional', () => {
		assert.equal(parseArgs(['simulate']).command, 'simulate');
		assert.equal(parseArgs([]).command, '');
		assert.deepEqual(parseArgs(['replay', 'extra', 'more']).positionals, ['extra', 'more']);
	});

	it('reads a flag and its value', () => {
		const args = parseArgs(['simulate', '--matches', '50']);
		assert.equal(args.flags.matches, '50');
	});

	it('reads the --flag=value form too', () => {
		const args = parseArgs(['simulate', '--matches=50', '--bots=greedy,random,greedy,random']);
		assert.equal(args.flags.matches, '50');
		assert.equal(args.flags.bots, 'greedy,random,greedy,random');
	});

	it('treats a flag with no value as a switch', () => {
		const args = parseArgs(['replay', '--hands', '--seed', '3']);
		assert.equal(args.flags.hands, true);
		assert.equal(args.flags.seed, '3');
	});

	it('treats a trailing flag as a switch', () => {
		assert.equal(parseArgs(['replay', '--hands']).flags.hands, true);
	});

	it('keeps a value that contains an equals sign', () => {
		assert.equal(parseArgs(['x', '--note=a=b']).flags.note, 'a=b');
	});

	it('lets a later flag win', () => {
		assert.equal(parseArgs(['x', '--seed', '1', '--seed', '2']).flags.seed, '2');
	});
});

describe('reading typed flags', () => {
	it('falls back when a flag is absent', () => {
		const args = parseArgs(['simulate']);
		assert.equal(flagString(args, 'bots', 'strategic'), 'strategic');
		assert.equal(flagNumber(args, 'matches', 200), 200);
		assert.equal(flagBoolean(args, 'hands'), false);
	});

	it('falls back when a flag was given as a bare switch', () => {
		const args = parseArgs(['simulate', '--bots']);
		assert.equal(flagString(args, 'bots', 'strategic'), 'strategic');
	});

	it('parses numbers and rejects what is not one', () => {
		assert.equal(flagNumber(parseArgs(['x', '--matches', '50']), 'matches', 1), 50);
		assert.equal(flagNumber(parseArgs(['x', '--target', '-3']), 'target', 1), -3);
		assert.throws(
			() => flagNumber(parseArgs(['x', '--matches', 'many']), 'matches', 1),
			/--matches expects a number/,
		);
	});

	it('reads a boolean from the switch or the word', () => {
		assert.equal(flagBoolean(parseArgs(['x', '--hands']), 'hands'), true);
		assert.equal(flagBoolean(parseArgs(['x', '--hands', 'true']), 'hands'), true);
		assert.equal(flagBoolean(parseArgs(['x', '--hands', 'false']), 'hands'), false);
	});

	it('keeps a numeric seed numeric and a worded seed a word', () => {
		assert.equal(flagSeed(parseArgs(['x', '--seed', '42']), 'seed', 1), 42);
		assert.equal(flagSeed(parseArgs(['x', '--seed', 'domingo']), 'seed', 1), 'domingo');
		assert.equal(flagSeed(parseArgs(['x']), 'seed', 7), 7);
	});

	it('does not mistake an empty or blank seed for the number zero', () => {
		// `Number('') === 0`, which would silently turn `--seed ''` into seed 0.
		assert.equal(flagSeed(parseArgs(['x', '--seed=']), 'seed', 9), '');
		assert.equal(flagSeed(parseArgs(['x', '--seed= ']), 'seed', 9), ' ');
	});
});
