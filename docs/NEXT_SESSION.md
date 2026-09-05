# Instructions for the next session

Two goals, in this order of value:

1. **Close the known weaknesses of the engine** (§B) — the search's blind spots,
   the noise in the bar, and the gaps in inference.
2. **Make it viewable in a browser** (§C) — a visual board with the evaluation
   bar and the belief heatmap, plus a shareable replay page.

Read `CLAUDE.md` (conventions and invariants) and `docs/RULES.md` (the rules and
which of them are configurable) before touching anything.

## How to start the session

Paste this:

> Read `CLAUDE.md`, `docs/RULES.md` and `docs/NEXT_SESSION.md`. Work the
> packages in `docs/NEXT_SESSION.md` in order, starting at WP1. For each: build
> it, prove the acceptance criteria with a command whose output you show me,
> commit, and move on. Stop and ask only if a package's acceptance criteria turn
> out to be wrong or unreachable — otherwise keep going and tell me at the end
> what you did and what you skipped.

Work on branch `claude/dominican-dominoes-engine-92w9va` (or a new
`claude/…` branch off it), commit per work package, push at the end.

---

## A. Where things stand

Measured on this position (hero P0 holds `6-4 5-5 3-1 0-0 2-6 4-4 5-0`, after
`P1 [6|6]`, `P2 [6|3]`, `P3 [3|3]`), on the container's CPU:

| | |
|---|---|
| Full report (`evaluate_position`, all four seats), `DEFAULT` | **0.72 s** |
| Single-seat read, `LIVE` | **0.16 s** |
| Noise in `ev_points` across 8 sampling seeds, `DEFAULT` (80 deals) | **σ ≈ 5.8 points, range 15.8** |
| Stability of the *chosen* move across those 8 seeds | 7/8 identical |
| Strength: engine pair vs "heaviest legal tile" pair, 6 matches | 5–1, 1319–717 points |

So: the **ranking** is fairly stable, the **number on the bar is not**. That is
WP4, and it matters more once a browser shows the bar moving.

---

## B. Engine work packages

### WP1 — Weight determinizations by how plausible the play was
**Weakness.** `inference.py` treats every deal consistent with the *hard*
constraints as equally likely. It reads passes and hand sizes exactly, but
throws away the soft signal in **which tile a player chose** when they had
options. A player who had `[6|4]` and `[6|1]` and dropped the `[6|4]` is telling
you something; the engine hears nothing.

**Build.** Importance weighting on top of the existing exact sampler — do not
replace it.

- New `dominord/opponent.py`: a cheap, explicit policy
  `choice_likelihood(state, seat, move) -> float` giving a distribution over that
  seat's legal moves (softmax over `static_eval`-style features with a
  temperature; heavier tiles favoured, doubles held back slightly).
- In `inference.py`, add `Beliefs.deal_weight(deal)` = ∏ over every recorded
  play by an unknown seat of `P(observed move | that deal)`, computed by
  replaying the hand once per deal (`TableView.to_hand_state` already does the
  replay).
- `search.evaluate_moves` / `evaluation._outlook`: aggregate **weighted** means
  instead of plain means. Keep an unweighted path behind
  `SearchConfig.use_choice_likelihood = False`.
- Guard against degeneracy: normalise weights, clip at e.g. `[0.02, 50]`, and
  report the effective sample size `ESS = (Σw)² / Σw²`.

**Acceptance.**
- New test: construct a hand where one seat could have played either of two
  tiles and did play the heavy one; assert the weighted marginal for a specific
  held tile moves in the right direction versus unweighted.
- `scripts/benchmark.py --matches 20`: weighted engine ≥ unweighted engine in
  match wins, and ESS stays above ~30% of `samples` in a logged self-play hand.
- No regression: `pytest` green, single-seat `LIVE` read stays under 0.35 s.

### WP2 — Kill strategy fusion (the real PIMC flaw)
**Weakness.** Each determinization is solved as if everyone could see all hands,
so the engine never plays to *conceal*, never keeps a tile ambiguous, and can
pick a move that only works because "in this imagined world I knew where the
`[5|5]` was". This is the textbook strategy-fusion failure of PIMC.

**Build.** `dominord/ismcts.py` — Information-Set MCTS (single-observer,
multiple-observer if it stays simple):

- One tree keyed by **information set** (the public history + the searching
  seat's hand), not by full state; a fresh determinization sampled at the root of
  each iteration (reusing `Beliefs.sample_deal`, weighted per WP1).
- UCB1 over moves *available in that iteration*, with availability counts
  (standard ISMCTS correction), rollouts by the WP1 policy, backup in signed
  hand points.
- Wire it as `SearchConfig.algorithm = "pimc" | "ismcts"`; PIMC stays the
  default until ISMCTS beats it.

**Acceptance.**
- A regression position where PIMC demonstrably errs (build one: a choice
  between a move that only wins when the rivals' holding is known and a move that
  wins regardless) — assert ISMCTS prefers the robust move.
- `scripts/benchmark.py`: ISMCTS pair vs PIMC pair over ≥ 20 matches, report the
  result honestly even if PIMC wins; make the default follow the evidence.
- Same time budget for both sides in that comparison (WP7's node/time budget).

### WP3 — Tune the policy and the static eval
**Weakness.** `static_eval`'s weights (`0.45` pip diff, `3.0` tempo, `1.5`
control, `search.py:63`) were picked by hand and never fitted. The rollout policy
is one-ply greedy for every seat and knows no Dominican convention — it never
"da juego al compañero", never saves a double to close, never plays the
`repite, mata y tranca` plan.

**Build.**
- `scripts/tune.py`: cross-entropy method or simple coordinate search over the
  eval weights, scored by match win-rate in self-play (fixed seeds, ≥ 200 hands
  per candidate, paired comparisons).
- Add partner-aware features: tiles the partner is known to lack, suits the
  partner has repeated, whether a move opens an end the partner is void in.
- Optionally fit the leaf eval by regression on positions solved exactly by
  `solve()` (cheap ground truth at ≤ 14 tiles).

**Acceptance.** Tuned weights beat the current ones by a statistically
meaningful margin (≥ 55% match win rate over ≥ 40 paired matches, or a clear
points-per-hand gap), committed as the new defaults with the tuning run's output
recorded in the commit message.

### WP4 — Make the bar trustworthy (variance control)
**Weakness.** σ ≈ 5.8 points on `ev_points` at 80 deals. A browser that redraws
the bar after every move will show it jitter for no reason.

**Build.**
- **Common random numbers** across candidate moves (already partly true — make it
  explicit and tested) and across the "before/after a move" comparison.
- **Antithetic / stratified sampling** over the deals (stratify on, say, which
  seat holds the heaviest unseen double).
- **Sequential stopping**: keep sampling until the top two moves separate with
  ~95% confidence or a time budget expires.
- Report a **confidence interval** on `PositionEval.ev_points` and
  `MoveEval.ev_points` (`ev_ci: tuple[float, float]`), and render it — the bar
  should show a band, not a false-precision line.

**Acceptance.** A test that runs the same position under ≥ 8 sampling seeds and
asserts σ of `ev_points` is **below 2.5 points** at the `DEFAULT` budget, and
that the reported CI covers the seed-to-seed spread ≥ 90% of the time.

### WP5 — Optimise for the match, not for the hand
**Weakness.** The engine maximises hand points. At 190–150 in a game to 200,
banking 12 points now is worth more than an EV of +20 that hands the rivals a
50-point tranque. `_match_note` mentions the score; nothing *optimises* for it.

**Build.**
- `dominord/matchvalue.py`: `win_probability(scores, team, rules)` from a table
  built by value iteration over score states, using the empirical distribution of
  hand outcomes (harvest it from self-play; cache to a JSON in `data/`).
- New terminal scorer `signed_match_value(result, team, match)` and
  `SearchConfig.objective = "points" | "match"`.
- The bar gains a second reading: **advantage in the hand** and **probability of
  winning the partida**.

**Acceptance.** A constructed endgame near the target where the points-objective
and the match-objective pick different moves, with a test asserting each picks
its own; plus a self-play match between the two objectives over ≥ 20 matches.

### WP6 — Finish the inference
**Weaknesses, concretely.**
- `Beliefs.suit_probability` (`inference.py:234`) is **400 Monte Carlo samples**
  with a fixed seed, while everything around it is exact. Replace with a second
  DP: count deals in which the seat holds no tile of that suit.
- No **forced-holding** propagation: if six of the seven fives are accounted for
  and only one seat can hold the seventh, that is certainty, not a probability —
  derive it and show it as `SÍ` in the belief table.
- No **joint** queries: "P(P1 and P3 are both void in 4)" — needed to reason
  about tranque chances properly rather than sampling them.
- `InconsistentObservations` currently just raises. The console should say
  *which* recorded move makes the position impossible (people mistype at a live
  table) and offer to undo it.

**Acceptance.** Exact `suit_probability` verified against the brute-force
enumerator already in `tests/test_inference.py`; a test showing a forced holding
comes back as probability 1.0; a console test where a bad entry produces a
message naming the offending move rather than a traceback.

### WP7 — Time budgets and speed
**Weakness.** `exact_tiles` is a fixed tile count (14) regardless of how bushy
the position is; no node or time budget; the transposition table is thrown away
between determinizations; everything is single-process.

**Build.** `SearchConfig.time_budget_ms`; iterative deepening with a node cap in
`solve`; keep one TT per evaluation instead of per determinization; represent
hands as `int` bitmasks over the 28 tiles (a big constant-factor win in
`legal_plays`/`static_eval`); optional `multiprocessing` fan-out over deals
behind a flag.

**Acceptance.** Full four-seat report **under 250 ms** at a quality no worse than
today's `DEFAULT` (compare move rankings on a fixed set of 50 positions), and a
`--time-budget` flag honoured within ±20%.

### WP8 — Verify the rules against a real table
**Weakness.** The rules were assembled from published sources, not from a player.
Sources disagreed on two live points (counting *all* remaining tiles vs the
rivals' only; individual vs pair count in a tranque) and were thin on several
others.

**Confirm with a Dominican player, then encode:** capicúa when both ends show the
*same* number (currently not a capicúa); 25 vs 30 point bonuses; *tranque con
todo el mundo*; penalties for playing out of turn or dropping a tile; whether the
tranque winner or the blocker opens next; zapato/pollona conventions.

**Acceptance.** `docs/RULES.md` updated with what the player says, each new
variant a `RuleSet` field with a test, and the presets adjusted if the field
research contradicts the current defaults. Do not silently change a default —
record why.

### WP9 — Keep the whole match, not just the current hand
**Weakness.** `Session.to_dict()` stores the running score plus the *current*
hand's moves. Past hands survive only as results, so the browser cannot replay
hand 3 of a match.

**Build.** `hands: [...]` in the session JSON — for each finished hand the
opener, the forced tile, the moves, the revealed hands (when known) and the
result. Bump `SCHEMA_VERSION` to 2 and read v1 files without complaint.

**Acceptance.** A round-trip test that plays a two-hand match, saves, loads, and
replays hand 1 move by move from the loaded file.

---

## C. The browser

Two separate deliverables; build them in this order.

### WP10 — Live board in the browser (local app)

**Stack decision: stdlib only.** `http.server.ThreadingHTTPServer` + a
single-page vanilla-JS front end. No framework, no build step — that keeps the
"zero dependencies, `python3 -m dominord web` and it runs" property that makes
this project easy to hand to somebody. FastAPI is allowed *only* behind an
optional extra (`pip install dominord[web]`) if something genuinely needs it.

**Layout.**

```
dominord/web/__init__.py
dominord/web/server.py        # ThreadingHTTPServer, JSON API, serves static/
dominord/web/api.py           # Session <-> JSON view models (no HTTP in here)
dominord/web/static/index.html
dominord/web/static/app.js    # state, fetch, render
dominord/web/static/board.js  # SVG chain, seats, belief grid
dominord/web/static/style.css # light + dark, no external fonts
```

Launch: `python3 -m dominord web --port 8000 [--open]`, printing the URL.

**API contract** (JSON in, JSON out; one session per server process is fine for
v1, keyed by an id if it is cheap):

| Method | Path | Body → Response |
|---|---|---|
| `POST` | `/api/session` | `{rules, players, hero, team_names}` → full state |
| `POST` | `/api/hand` | `{tiles: ["6-6",…], opener?}` → full state |
| `POST` | `/api/move` | `{player, tile, end?}` → full state, or `409` + `{error}` |
| `POST` | `/api/pass` | `{player}` → full state |
| `POST` | `/api/undo` | `{}` → full state |
| `POST` | `/api/finish` | `{pips?: [..], revealed?: {seat: [..]}}` → result + state |
| `GET` | `/api/state` | → full state |
| `GET` | `/api/analysis?seat=&effort=live\|default\|deep` | → evaluation payload |
| `GET`/`POST` | `/api/session/file` | save / load the session JSON |

`full state` = chain (oriented pairs), ends, turn, per-seat counts + voids +
expected pips, hero's hand, match scores, legality hints for the hero's tiles,
`is_over` and how. `evaluation payload` = the `PositionEval` fields: advantage
(+ CI from WP4), ev, win probability, per-seat move lists with
`ev/win/tranque/availability/choice_prob`, the tranque report, and the 28-tile
belief matrix.

**Front end, what actually has to be on screen:**
- The **chain as an SVG snake** that wraps and stays readable at 28 tiles, with
  the two live ends highlighted and the last tile played marked.
- **Your hand** as clickable tiles; illegal ones dimmed; clicking a tile that
  fits both ends asks which end (or shows two drop targets).
- **Four seats** around the board: tiles left, expected pips, and the numbers
  each is known to lack (`no tiene 6 1`) — the single most useful thing at a real
  table.
- The **evaluation bar**: horizontal, centred, our pair to the right, with the
  confidence band from WP4 and the numeric EV beside it.
- The **belief heatmap**: the 28 tiles laid out as a 7×7 triangle, each cell
  split four ways (or coloured by the most likely holder with opacity =
  probability); played tiles greyed, yours outlined. This replaces the dense
  text table and is the feature that most rewards being in a browser.
- The **tranque panel**: chance, who wins the count now, and the flagged
  opportunity/threat.
- A **move list / history** you can scrub, which replays the board to that point.
- Keyboard entry that mirrors the console (`juan 6-4`, `paso socio`) for people
  who are fast at the terminal — the browser should not be slower to drive than
  the CLI.

**Non-negotiables.** Analysis must never block input: post the move, render
immediately, fetch the analysis after, and show a spinner on the bar only.
Respect `prefers-color-scheme`. Works with the tab at 400 px wide (phone at the
table, one-handed). No CDN, no external fonts, no telemetry.

**Acceptance.**
- `python3 -m dominord web` then driving a whole hand in the browser, ending with
  `fin`, produces exactly the same result object as the same hand driven in the
  console (write it as an end-to-end test using `urllib.request` against the
  server in a thread — no browser automation needed).
- A test that every API error path returns a JSON `{error}` with a 4xx code and
  never a traceback.
- The screenshot of a mid-hand position in the README, replacing the ASCII block.

### WP11 — A shareable replay page (no server)
The live app needs Python running. For sharing a post-mortem — "look at hand 4,
this is where we lost the tranque" — build a **single self-contained HTML file**
that takes a session JSON (from WP9) and renders the board, the score and the
evaluation curve hand by hand, entirely client-side.

- `scripts/export_replay.py --session mesa.json --out replay.html`: precomputes
  the engine's read at every ply (in Python, at `DEEP`), inlines it with the page
  as one file with no external requests.
- The page: scrub through plies, the bar moves with you, the belief heatmap
  updates, and the biggest evaluation swings are listed as "momentos" you can
  jump to — the mistakes, basically.
- It must open from `file://`, from GitHub Pages, and as a published artifact.

**Stretch, only if the rest is done:** a **Pyodide** build that runs the real
engine in the browser (the core is pure Python with no dependencies, so this
should mostly just work) — full analysis with no server at the cost of a ~10 MB
first load. Keep it as a separate page; do not make the main app depend on it.

**Acceptance.** `export_replay.py` on a two-hand self-play session produces one
HTML file under 2 MB that opens offline and scrubs through every ply.

### WP12 — Keep it honest
- `tests/test_regression_positions.py`: ~20 positions with exactly-solved values
  (from `solve()`), asserting the engine's pick stays sane as things change.
- A GitHub Actions workflow: `pytest` + `ruff` on push (this repo has none).
- `scripts/benchmark.py --matches 20` result recorded in the README whenever the
  engine changes, so strength claims stay current.

---

## D. Order, and what to do if time runs short

WP4 → WP1 → WP10 is the highest-value path: a trustworthy bar, then a smarter
prior, then the browser. WP2 (ISMCTS) is the most interesting and the most likely
to eat a whole session — do not start it before WP7 gives you a time budget to
compare fairly. WP8 needs a human, so raise it early and carry on meanwhile.

If only one thing gets done: **WP10**. The engine is already stronger than the
default patio strategy; what it lacks is a way for anyone to see it.
