# dominord — working notes for Claude

Dominican domino engine (2v2, double-six). Python 3.10+, **zero runtime
dependencies** — keep it that way in `dominord/` core.

## Commands

```bash
pytest                                   # 50 tests, ~2.5s
ruff check dominord tests scripts        # must be clean
python3 -m dominord                      # the console
python3 -m dominord selfplay --matches 2 --greedy-rivals
python3 scripts/benchmark.py --matches 10   # engine pair vs greedy pair
```

## Layout

| Module | Job |
|---|---|
| `tiles.py` `state.py` | tiles, chain, legality, apply/undo |
| `rules.py` | every house rule as a field; `patio` / `patio100` / `formal` |
| `scoring.py` | dominó, tranque, bonuses; works from a state *or* from pip totals |
| `table.py` | `TableView` — what an observer knows (the reconstruction layer) |
| `inference.py` | voids from passes, exact marginals by DP, uniform deal sampling |
| `search.py` | PIMC + exact alpha-beta endgame |
| `evaluation.py` | the bar: EV, win rate, tranque chance/opportunity |
| `render.py` `cli.py` `session.py` `match.py` `selfplay.py` | output, console, persistence, match, self-play |

## Invariants — do not break

1. **Rules stay configurable.** Anything tables argue about is a `RuleSet`
   field, never a constant. Defaults follow patio play (see `docs/RULES.md`).
2. **`TableView` never sees hidden hands.** It holds only observations plus the
   hands explicitly shown to it. All hidden-hand reasoning goes through
   `inference.py`.
3. **Values are signed hand points** from one pair's side (`signed_points`),
   so evaluations are zero-sum between the pairs. There is a test for this.
4. **A pass is permanent information** — voids only ever grow within a hand.
5. `Session.to_dict()` carries `"version"`; bump it and handle the old shape if
   the schema changes.
6. Core stays dependency-free. Optional extras (web server, tuning) may add
   dependencies only behind an extras group in `pyproject.toml`.

## Style

Spanish for the domino vocabulary the game actually uses (salida, paso,
tranque, capicúa, chuchazo, punta) — in output *and* in identifiers where it
reads better. English for code structure. Comments explain *why*, sparingly.
