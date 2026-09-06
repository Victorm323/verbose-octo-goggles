/**
 * A minimal `--flag value` parser, so the CLI stays dependency-free.
 */

export interface ParsedArgs {
	readonly command: string;
	readonly flags: Readonly<Record<string, string | boolean>>;
	readonly positionals: readonly string[];
}

export function parseArgs(argv: readonly string[]): ParsedArgs {
	const flags: Record<string, string | boolean> = {};
	const positionals: string[] = [];

	for (let i = 0; i < argv.length; i++) {
		const token = argv[i];

		if (!token.startsWith('--')) {
			positionals.push(token);
			continue;
		}

		const body = token.slice(2);
		const equals = body.indexOf('=');
		if (equals !== -1) {
			flags[body.slice(0, equals)] = body.slice(equals + 1);
			continue;
		}

		const next = argv[i + 1];
		if (next === undefined || next.startsWith('--')) {
			flags[body] = true;
		} else {
			flags[body] = next;
			i += 1;
		}
	}

	return { command: positionals[0] ?? '', flags, positionals: positionals.slice(1) };
}

export function flagString(args: ParsedArgs, name: string, fallback: string): string {
	const value = args.flags[name];
	return typeof value === 'string' ? value : fallback;
}

export function flagNumber(args: ParsedArgs, name: string, fallback: number): number {
	const value = args.flags[name];
	if (typeof value !== 'string') return fallback;
	const parsed = Number(value);
	if (!Number.isFinite(parsed)) {
		throw new Error(`--${name} expects a number, received "${value}"`);
	}
	return parsed;
}

export function flagBoolean(args: ParsedArgs, name: string): boolean {
	const value = args.flags[name];
	return value === true || value === 'true';
}

/** Seeds may be numeric or a word; keep numbers numeric so `--seed 7` is reproducible. */
export function flagSeed(
	args: ParsedArgs,
	name: string,
	fallback: number | string,
): number | string {
	const value = args.flags[name];
	if (typeof value !== 'string') return fallback;
	const numeric = Number(value);
	return Number.isFinite(numeric) && value.trim() !== '' ? numeric : value;
}
