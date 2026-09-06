# Dominican Dominoes Engine

A deterministic rules engine for **dominó dominicano** — the double-six set, four players
in two fixed partnerships, hands played to 200 points. It ships as three things:

- a dependency-free TypeScript library (`src/engine`),
- three bots and a playout runner (`src/bots`),
- a CLI and an n8n node that both sit on top of the same engine.

Every state transition is a pure function returning new state, and every shuffle runs
through a seeded PRNG carried inside the match, so a `(seed, moves)` pair replays exactly.

## Quick start

```bash
pnpm install
pnpm build
pnpm test

# 500 matches, strategic partnership against greedy
node dist/src/cli/index.js simulate --matches 500 --bots strategic,greedy,strategic,greedy

# watch one match move by move
node dist/src/cli/index.js replay --seed domingo --hands

# take a seat yourself
node dist/src/cli/index.js play --seat 0
```

## Using the library

```ts
import { createMatch, applyMove, legalMoves, formatBoard } from './src/engine';

let state = createMatch({ seed: 'domingo' });

while (state.status === 'playing') {
  const moves = legalMoves(state);
  if (moves.length === 0) break;
  state = applyMove(state, moves[0]);
}

console.log(formatBoard(state.hand.board));
```

`applyMove` settles the hand when a move ends it, but does not deal the next one — call
`startNextHand(state)`, or `advance(state)`, which is a no-op when no hand is due. If you
would rather hold one match and push moves at it, `DominoEngine` does the bookkeeping and
records events:

```ts
import { DominoEngine } from './src/engine';

const engine = new DominoEngine({ seed: 'domingo', rules: { targetScore: 100 } });
while (!engine.isOver) engine.play(engine.legalMoves()[0]);

console.log(engine.summary());   // { winner, scores, hands, shutout, zapato }
console.log(engine.drainEvents());
```

### Hidden information

`MatchState` is the referee's view and holds all four hands. Anything that plays the game
— a bot, a UI, a workflow — should go through `observationFor(state, seat)` instead, which
exposes one seat's tiles plus the public record: the chain, the tile counts, the unseen
pool, and `knownVoids`, which is derived from the passes. A pass is a statement that the
player held nothing matching either end at that moment, and since hands only shrink, it
stays true for the rest of the hand. That read is most of what separates the strategic bot
from the greedy one.

### Persistence

`serializeMatch` / `deserializeMatch` (and the `toJson` / `fromJson` wrappers) round-trip a
match through plain JSON with tiles as ids like `"6|5"`. Deserialization validates what it
is handed — connected chain, pips in range, no tile in two places — so hand-edited state is
rejected rather than quietly corrupting a match.

## The rules it plays

| Rule | Default | Alternatives |
| --- | --- | --- |
| Tile set | Double-six (28 tiles), 7 per player | — |
| Players | 4, partnerships `{0,2}` and `{1,3}` | — |
| Opening (first hand) | Holder of `6\|6` must lead it | `highest-double`, `fixed-seat` |
| Opening (later hands) | Previous hand's winner leads, any tile | — |
| Passing | Only when no legal play exists | — |
| Dominó score | Pips left in the other three hands | — |
| Tranca score | All remaining pips to the lower-total team | `opponents-only` |
| Tied tranca | No points; the same seat leads again | — |
| Capicúa bonus | 25, requires distinct ends and a non-double | any bonus, or `0` to disable |
| Match target | 200 points | any positive target |
| Starter after a tranca | The seat that blocked the game | `winner-side` |

House rules differ, so all of it is configurable per match rather than baked in:

```ts
createMatch({
  seed: 42,
  rules: { targetScore: 150, trancaScoring: 'opponents-only', capicuaBonus: 30 },
});
```

Seats are numbered 0–3 in playing order (counter-clockwise, as at the table), so seat
`n + 1` sits to the right of seat `n` and partners face each other.

## The bots

| Bot | Plays |
| --- | --- |
| `random` | Uniformly among legal moves. The baseline. |
| `greedy` | Sheds the heaviest tile, doubles first. Blind to the table. |
| `strategic` | Counts suits, tracks opponent voids, controls the ends, protects its partner, and closes when it can. |

Over 200 matches from seed 1 the ordering holds up: greedy takes 81% against random,
strategic takes 82.5% against greedy and 93.5% against random. Mirror matchups land near
50/50, which is the check that no seat has a structural edge. `pnpm simulate` runs your
own:

```bash
pnpm simulate --matches 200 --seed 1 --bots strategic,greedy,strategic,greedy
```

## The n8n node

`Dominican Dominoes` exposes the engine to workflows: `New Match`, `Get Legal Moves`,
`Get Observation`, `Apply Move`, `Bot Move` and `Play Out`. Because match state
round-trips through JSON, a workflow can hold a game across executions — pass the `state`
from one call into the next and play resumes where it stopped.

The node is a thin wrapper: it parses parameters, calls the engine, and serializes the
result. All the rules live in `src/`.

## Layout

```
src/engine/     the rules: tiles, board, hand, scoring, match, serialization
src/bots/       policies and the playout/tournament runner
src/cli/        simulate, replay and play
nodes/          n8n nodes, including the Dominican Dominoes wrapper
test/           node:test suite, including invariant fuzzing over 120 matches
ROADMAP.md      what was built and which variants are supported
```

## Scripts

| Script | Does |
| --- | --- |
| `pnpm build` | Compile to `dist/` and copy node icons |
| `pnpm test` | Compile the suite and run it under `node --test` |
| `pnpm lint` | Lint the n8n nodes, credentials and `package.json` |
| `pnpm cli` | Build, then run the CLI (`pnpm cli replay --seed 3`) |
| `pnpm simulate` | Build, then run a bot tournament |

## Testing

The suite covers tiles, RNG determinism, board mechanics, legal moves, every ending
(dominó, tranca, tie, capicúa), match flow, serialization and the bots. On top of the unit
tests, an invariant pass plays 120 bot matches and asserts on every position that all 28
tiles are accounted for, the chain connects, a pass is never offered beside a playable
tile, and the scoreboard equals the sum of the hands won — and then checks the run actually
reached the awkward endings it claims to cover.

## License

[MIT](LICENSE.md)
