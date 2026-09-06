/**
 * Tiles ("fichas") of the double-six set.
 *
 * A tile is stored normalised, `a >= b`, so `[3|5]` and `[5|3]` are the same value and
 * compare equal through `tileId`. Orientation on the table is a property of the board,
 * not of the tile itself.
 */

import { fail } from './errors';

export type Pip = 0 | 1 | 2 | 3 | 4 | 5 | 6;

export interface Tile {
	readonly a: Pip;
	readonly b: Pip;
}

/** Canonical id of a tile, e.g. `"6|5"`. Two equal tiles always share an id. */
export type TileId = string;

export const PIPS: readonly Pip[] = [0, 1, 2, 3, 4, 5, 6];

export function isPip(value: unknown): value is Pip {
	return typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= 6;
}

/** Builds a normalised tile, rejecting anything outside the double-six set. */
export function tile(x: number, y: number): Tile {
	if (!isPip(x) || !isPip(y)) {
		fail('INVALID_TILE', `not a double-six tile: [${x}|${y}]`);
	}
	return x >= y ? { a: x, b: y } : { a: y, b: x };
}

export function tileId(t: Tile): TileId {
	return `${t.a}|${t.b}`;
}

export function parseTile(id: string): Tile {
	const parts = id.split('|');
	if (parts.length !== 2) {
		fail('INVALID_TILE', `malformed tile id: "${id}"`);
	}
	return tile(Number(parts[0]), Number(parts[1]));
}

/** Accepts either a tile or its id, which keeps the public API forgiving. */
export function coerceTile(value: Tile | TileId): Tile {
	if (typeof value === 'string') {
		return parseTile(value);
	}
	if (value === null || typeof value !== 'object') {
		fail('INVALID_TILE', `not a tile: ${JSON.stringify(value)}`);
	}
	return tile(value.a, value.b);
}

export function isDouble(t: Tile): boolean {
	return t.a === t.b;
}

/** Pip value of a tile — what it is worth when it is caught in someone's hand. */
export function tileValue(t: Tile): number {
	return t.a + t.b;
}

export function tileHasPip(t: Tile, pip: Pip): boolean {
	return t.a === pip || t.b === pip;
}

/** The pip on the far side of `pip`. For a double this is `pip` itself. */
export function otherPip(t: Tile, pip: Pip): Pip {
	if (t.a === pip) return t.b;
	if (t.b === pip) return t.a;
	fail('INVALID_TILE', `tile ${tileId(t)} does not carry a ${pip}`);
}

export function tilesEqual(x: Tile, y: Tile): boolean {
	return x.a === y.a && x.b === y.b;
}

export function containsTile(tiles: readonly Tile[], t: Tile): boolean {
	return tiles.some((candidate) => tilesEqual(candidate, t));
}

export function indexOfTile(tiles: readonly Tile[], t: Tile): number {
	return tiles.findIndex((candidate) => tilesEqual(candidate, t));
}

/** Returns a copy of `tiles` with the first occurrence of `t` removed. */
export function removeTile(tiles: readonly Tile[], t: Tile): Tile[] {
	const index = indexOfTile(tiles, t);
	if (index === -1) {
		fail('TILE_NOT_IN_HAND', `tile ${tileId(t)} is not in the hand`);
	}
	return tiles.slice(0, index).concat(tiles.slice(index + 1));
}

/** Total pip value of a set of tiles. This is the currency of the game. */
export function sumPips(tiles: readonly Tile[]): number {
	return tiles.reduce((total, t) => total + tileValue(t), 0);
}

/** Heaviest first, doubles ahead of non-doubles of equal weight. */
export function compareTiles(x: Tile, y: Tile): number {
	const byValue = tileValue(y) - tileValue(x);
	if (byValue !== 0) return byValue;
	const byDouble = Number(isDouble(y)) - Number(isDouble(x));
	if (byDouble !== 0) return byDouble;
	return y.a - x.a;
}

export function sortTiles(tiles: readonly Tile[]): Tile[] {
	return tiles.slice().sort(compareTiles);
}

/** The full 28-tile double-six set, in a stable order. */
export function fullSet(): Tile[] {
	const tiles: Tile[] = [];
	for (const high of PIPS) {
		for (const low of PIPS) {
			if (low <= high) {
				tiles.push({ a: high, b: low });
			}
		}
	}
	return tiles;
}

export const DOUBLE_SIX: Tile = { a: 6, b: 6 };

/** How many tiles of a given suit (pip) the set contains — a double counts once. */
export function countSuit(tiles: readonly Tile[], pip: Pip): number {
	return tiles.filter((t) => tileHasPip(t, pip)).length;
}

/** Highest double in a hand, or `null` when the hand holds none. */
export function highestDouble(tiles: readonly Tile[]): Tile | null {
	let best: Tile | null = null;
	for (const t of tiles) {
		if (isDouble(t) && (best === null || t.a > best.a)) {
			best = t;
		}
	}
	return best;
}

/** Renders a tile the way it is spoken at the table: `[6|5]`. */
export function formatTile(t: Tile): string {
	return `[${t.a}|${t.b}]`;
}

export function formatTiles(tiles: readonly Tile[]): string {
	return tiles.map(formatTile).join(' ');
}
