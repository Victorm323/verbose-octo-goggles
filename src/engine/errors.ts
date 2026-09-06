/**
 * Errors raised by the engine.
 *
 * Every rejection carries a machine-readable `code` so that callers (the CLI, the n8n
 * node, a UI) can react without matching on message strings.
 */

export type EngineErrorCode =
	| 'INVALID_TILE'
	| 'INVALID_SEAT'
	| 'INVALID_CONFIG'
	| 'NOT_YOUR_TURN'
	| 'HAND_FINISHED'
	| 'MATCH_FINISHED'
	| 'HAND_IN_PROGRESS'
	| 'TILE_NOT_IN_HAND'
	| 'ILLEGAL_PLACEMENT'
	| 'ILLEGAL_PASS'
	| 'MUST_OPEN_WITH'
	| 'MALFORMED_STATE';

export class EngineError extends Error {
	readonly code: EngineErrorCode;

	constructor(code: EngineErrorCode, message: string) {
		super(message);
		this.name = 'EngineError';
		this.code = code;

		// Keep `instanceof` working when the library is compiled down to ES5-era output.
		Object.setPrototypeOf(this, EngineError.prototype);
	}
}

export function fail(code: EngineErrorCode, message: string): never {
	throw new EngineError(code, message);
}
