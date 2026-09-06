# Dominican Dominoes Engine — Roadmap

A deterministic, dependency-free rules engine for **dominó dominicano**: the double-six
set, four players in two fixed partnerships, hands played to a match target of 200 points.

The engine is a plain TypeScript library under `src/`. It has no runtime dependencies, is
fully immutable (every state transition returns a new state), and is reproducible from a
seed. The n8n node under `nodes/DominicanDominoes/` is a thin wrapper that exposes the
same operations to workflows, which is why the engine lives in this repository.

## Design constraints

1. **Pure and immutable.** `applyMove(state, move) -> state`. No hidden globals, no I/O in
   the engine layer.
2. **Deterministic.** All randomness flows through a seeded PRNG carried inside the match
   state, so a `(seed, moves)` pair replays exactly.
3. **Rules are data.** House rules differ across DR tables, so variants live in a
   `RuleConfig` object rather than in branching code paths scattered around the engine.
4. **Hidden information is explicit.** Bots and UIs consume `observationFor(state, seat)`,
   which cannot see other players' tiles. The full `MatchState` is the referee's view.
5. **Serializable.** Any state round-trips through JSON, so a match can be suspended,
   stored, and resumed (this is what makes the n8n node possible).

## Deliverables

### Phase 1 — Core domain
- [x] `Pip`/`Tile` types, canonical tile ids (`"6|5"`), parsing and formatting
- [x] The 28-tile double-six set, pip sums, doubles, suit membership
- [x] Seeded PRNG (mulberry32) with serializable state, Fisher–Yates shuffle, dealing
- [x] Board as an oriented chain with two open ends; placement legality and orientation

### Phase 2 — Rules and hand play
- [x] Legal-move generation (a tile matching both ends yields two distinct moves)
- [x] Opening rules: `double-six` (default first hand), `highest-double`, `fixed-seat`
- [x] Forced play — a pass is illegal while a legal play exists
- [x] Turn rotation in seat order, partnerships `{0,2}` vs `{1,3}`
- [x] Hand end by *dominó* (a player empties their hand)
- [x] Hand end by *tranca* (four consecutive passes), including the tied tranca
- [x] Next-hand starter rules for wins, trancas and ties

### Phase 3 — Scoring
- [x] Dominó: winning team scores the pips left in the other three hands
- [x] Tranca: lower team pip total wins; `all-remaining` (default) or `opponents-only`
- [x] *Capicúa* bonus (last tile playable on both, distinct, ends and not a double)
- [x] Match to a target score (default 200), team scores, hand-by-hand history
- [x] *Pollona* (shutout) and *zapato* detection on the final result

### Phase 4 — Match lifecycle and API
- [x] `createMatch`, `applyMove`, `startNextHand`, `legalMoves`, `isMatchOver`
- [x] `DominoEngine` facade with auto-advance and an event log
- [x] `observationFor(state, seat)`: own hand, tile counts, unseen tiles, known voids
- [x] `serializeMatch` / `deserializeMatch` with validation on the way back in
- [x] Text rendering of board, hands and results for CLIs and logs

### Phase 5 — Bots
- [x] `randomBot` — uniform over legal moves (baseline)
- [x] `greedyBot` — sheds the heaviest tile, mild preference for doubles
- [x] `strategicBot` — suit counting, opponent void tracking, partner protection,
      end control, and endgame closing

### Phase 6 — Tooling
- [x] CLI: `simulate` (batch playouts + win rates), `replay` (verbose single match),
      `play` (interactive seat against bots)
- [x] n8n node `Dominican Dominoes` with `newMatch`, `legalMoves`, `observation`,
      `applyMove`, `botMove` and `playOut` operations over serialized state

### Phase 7 — Verification
- [x] Unit tests: tiles, RNG determinism, board, legal moves, scoring, capicúa, tranca
- [x] Integration tests: full matches, serialization round-trips, replay determinism
- [x] Invariant fuzzing: 28 tiles conserved, no illegal passes, hands always terminate
- [x] `pnpm test`, `pnpm build`, `pnpm lint` all green

## Status

Every phase above is implemented. `pnpm build`, `pnpm lint` and `pnpm test` all pass; the
suite is 120 tests, including an invariant pass over 120 bot-played matches. See the
README for the API and the CLI.

## Rule reference (defaults)

| Rule | Default | Alternatives |
| --- | --- | --- |
| Tile set | Double-six (28 tiles), 7 per player | — |
| Players | 4, partnerships `{0,2}` and `{1,3}` | — |
| Opening (first hand) | Holder of `6|6` must lead it | `highest-double`, `fixed-seat` |
| Opening (later hands) | Previous hand's winner leads, any tile | — |
| Passing | Only when no legal play exists | — |
| Dominó score | Pips left in the other three hands | — |
| Tranca score | All remaining pips to the lower-total team | `opponents-only` |
| Tied tranca | No points; the same seat leads again | — |
| Capicúa bonus | 25, requires distinct ends and a non-double | any bonus, or `0` to disable |
| Match target | 200 points | any positive target |
| Starter after a tranca | The seat that blocked the game | `winner-side` |

Anything in that table can be changed per match through `RuleConfig`; the engine reads it
rather than assuming a single house's conventions.
