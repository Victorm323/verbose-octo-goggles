# dominord — roadmap to a superhuman phone engine

**Decision (this is settled, do not re-litigate):** build the heavy engine first.
Target superhuman play, real-time partner modelling that works from the first
hand with a stranger, and an anonymous replay corpus that feeds retraining.
Android first, web second, both on one native core.

`docs/NEXT_SESSION.md` holds the smaller quality-of-life packages (WP1–WP12).
Where the two conflict, **this document wins**. Sequence:

```
Phase 0  measurement harness ............ 2 days   (mandatory, everything else is unfalsifiable without it)
Phase 1  native core in Rust ............ 1-2 wks  ← THE HEAVY BUILD, start here
Phase 2  learned value + policy ......... 2-4 wks
Phase 3  belief search on the opening ... 2-3 wks
Phase 4  live partner modelling ......... 1-2 wks
Phase 5  replay corpus + retraining ..... 1-2 wks  (ship early, data compounds)
Phase 6  Android app, then web .......... 3-4 wks
```

Phase 5 ships **before** the engine is finished: every week without collection is
a week of training data that does not exist. Phases 4/5/6 can run in parallel
with 2/3 once the core is stable.

---

## The numbers this plan is built on

All measured in this repo, not estimated:

| Fact | Value | Where it came from |
|---|---|---|
| Full perfect-information solve, ply 0 | **225,067 nodes**, 4.46 s in Python | `solve()` instrumented |
| Python node rate | 50–100k nodes/s | same |
| Deals consistent with the evidence | 4.0e8 → 3.5e4 → 1,680 at plies 0 / 12 / 16 | `build_beliefs().total_deals` |
| Per-hand point margin | **sd 34.8** | 300 self-play hands |
| Hands to resolve a 2 pt/hand edge, unpaired | ~1,164 | from that sd |
| Bar noise at 80 deals | sd ≈ 5.8 points across seeds | 8 sampling seeds, one position |

Two consequences drive everything below:

1. **The endgame is already a solved problem.** By ply ~14 the belief space is
   small enough that a native core can exactly solve *every consistent deal*.
   No approximation, no network, nothing to improve. All effort goes to plies 0–12.
2. **Variance is brutal.** Any claim of improvement without duplicate scoring and
   ~1,000 paired hands is noise. Hence Phase 0 first.

---

## Phase 0 — The harness (do this before anything else)

`scripts/duplicate.py`: play the same deals with both engines in **both seat
pairings** (duplicate-bridge style), so deal luck cancels.

- Input: engine A, engine B, N deals, a seed. Output: paired point margin per
  deal, mean, sd, 95% CI, and the number of deals needed for significance.
- Also report per-decision agreement rate — cheap, low-variance early signal.
- `scripts/elo.py`: a ladder across engine versions, results appended to
  `data/ladder.jsonl` so strength history survives.

**Acceptance.** Running A vs A returns a margin whose CI contains zero, and
duplicate pairing reduces the sd of the margin by ≥ 3× versus unpaired on the
same deals.

---

## Phase 1 — The native core (THE HEAVY BUILD)

Rust, one crate, three targets: Android (JNI/UniFFI), wasm32 (web), and a
Python extension (PyO3) so the existing test-suite can keep validating it.

```
core/            # no_std-friendly: tiles, state, rules, scoring, solve, inference DP
core/src/bits.rs      # hand = u32 bitmask over 28 tile ids
core/src/solve.rs     # alpha-beta + Zobrist TT
core/src/infer.rs     # the counting DP + uniform sampler
bindings/jni/    bindings/wasm/    bindings/pyo3/
```

**Representation.** The search state is *not* the chain — it is
`(hands: [u32;4], left: u8, right: u8, turn: u8, pass_streak: u8)`. Chain
geometry only matters for display and capicúa detection, and capicúa is
derivable from the ends before the closing play. Move generation becomes
`hand & (SUIT_MASK[left] | SUIT_MASK[right])`, then iterate set bits — no
allocation, no branching per tile.

**Transposition table.** Open-addressed array, Zobrist keys over (tile, owner)
plus ends, turn and pass streak. Keep the EXACT/LOWER/UPPER flags the Python
version already has — that correctness detail is easy to lose in a port.

**Targets.**
- ≥ **3M nodes/s** per Cortex-A715-class core (≥ 8M on desktop x86).
- Full ply-0 solve **< 80 ms** on one phone big core.
- Rayon fan-out over determinizations, sized to big cores only (the A510s are
  ~⅓ the throughput and will hold back a naive parallel-for).

**Conformance — non-negotiable.** The Python engine becomes the oracle:
`tests/test_conformance.py` runs 10,000 random positions through both and
asserts identical `solve()` values, identical legal-move sets, identical
`total_deals`, and identical scoring on 1,000 finished hands under all three
presets. A port that is fast and subtly wrong is worse than no port.

**Watch out for:** thermals (design for bursts, think during opponents' turns,
idle otherwise), and WASM being ~1.5–2× slower than native — still enough for
exact endgame play in the browser.

---

## Phase 2 — Learned value and policy

**Free labels first.** From ~16 tiles down, `solve()` is exact ground truth.
Generate millions of labelled positions with no self-play loop at all.

- Sample positions from a *diverse* policy mixture (random, greedy, engine,
  noisy engine) — sampling only from greedy play trains a net that is confident
  and wrong off-distribution.
- Features (~130 dims): own hand (28), played (28), per-opponent void masks
  (3×7), tile counts (3), both ends (7+7 one-hot), turn (4), pass streak,
  points-to-target for both pairs, rule flags.
- Net: MLP, 3 hidden layers of 128–256, two heads — signed hand points and
  (Phase 3) match-win probability. Int8-quantised, 1–3 MB.

**Then Deep Monte-Carlo self-play** (DouZero's method — the closest solved
analogue to this game: hidden hands, implicit team, similar branching) for the
region the exact solver cannot reach.

**Population training, from the start.** Sample training partners and opponents
from `{novice, random-legal, heavy-first, suit-signaller, double-hoarder,
weak-engine, strong-engine, noisy-engine}`. An agent trained only against copies
of itself invents conventions no human shares — this is the documented Hanabi
failure, and it is exactly the "suboptimal team play" problem. Robustness to a
bad partner is bought here, in training, and only refined in Phase 4.

**Acceptance.** NN-leaf search beats full-rollout PIMC by ≥ 3 pts/hand on the
duplicate harness at equal time budget; value head's MAE < 8 points against
exact solves on a held-out set.

---

## Phase 3 — Belief search on plies 0–12

Depth-limited search (4–6 ply) with the NN at the leaves, over importance-
weighted determinizations, then blueprint-conditioned belief search
(SPARTA-style: fix the blueprint policy, re-solve the subgame over the belief
distribution at each decision). This is where strategy fusion dies and where
partner conventions become consistent rather than accidental.

**Note the theory honestly:** 2v2 with no communication is **not** a two-player
zero-sum game. Partners hold separate private information and cannot correlate
at play time, so the solution concept is TMECor, not Nash, and it is
computationally much harder. Do not claim optimality. The practical route is
shared-parameter self-play plus search, which is what worked in Bridge and Hanabi.

Also fold in the match objective here: optimise **probability of winning the
partida**, not raw hand points (`docs/NEXT_SESSION.md` WP5).

**Acceptance.** Beats Phase 2 on the duplicate harness; on a set of constructed
positions where PIMC provably errs, picks the information-robust move.

---

## Phase 4 — Real-time partner modelling (cold start)

The requirement: sit down with a partner the engine has never seen and adapt
**within the game**.

**Mechanism.** A Bayesian posterior over archetypes, updated after every observed
decision:

```
p(type | history) ∝ prior(type) · Σ_deals w(deal) · Π_t π_type(move_t | infoset_t, deal)
```

The inner term is the same likelihood used to weight determinizations, so one
computation serves both. Cost is O(#types × #deals) per move — negligible next
to the search.

- **Archetypes** come from Phase 5 data (clustered behaviour), not from
  imagination. Start with the hand-built population from Phase 2 and replace
  them with fitted clusters as the corpus grows.
- **Cold start**: prior = the population mixture. Expect a usefully sharp
  posterior after ~10–15 observed decisions, i.e. **inside the first hand or
  two**. Report the posterior in the UI ("tu socio: 70% conservador") — it is
  both a feature and a debugging tool.
- **Use it in the rollouts, not just the beliefs.** The search must simulate the
  *modelled* partner. That is what makes "my partner will not find the tranque,
  so I take responsibility" emerge on its own instead of being hand-coded.
- **Guardrail**: shrink toward the blueprint with a prior strength, cap how far
  the model may move play, and A/B it on the duplicate harness. A confidently
  wrong partner model plays worse than no model at all.
- **Persistence**: per-partner profiles keyed by a label the *user* types
  ("Juan") live in local storage and **never leave the device** (see Phase 5).

**Acceptance.** Against a scripted bad partner, the modelling engine beats the
non-modelling engine by ≥ 5 pts/hand on the duplicate harness; against a strong
partner it loses nothing (CI contains zero); posterior identifies the true
archetype in ≥ 70% of games by the end of hand two.

---

## Phase 5 — The replay corpus

Ship the collection early; the corpus is the long-term moat.

### What a replay is

One file per **game** (a full match to the target), validated by replaying every
move through the engine before it is stored.

```json
{
  "schema": "dominord.replay/1",
  "game_id": "9f2c…",              // random UUIDv4, generated per game
  "created_date": "2026-09",        // month granularity, no clock time
  "source": "app_play | table_reconstruction",
  "app_version": "1.4.0", "engine_version": "core-0.3.1",
  "rules": { …full RuleSet… },
  "seats": [{"index":0,"role":"hero"},{"index":1,"role":"rival"}, …],
  "hands": [{
     "opener": 1, "forced": "6-6",
     "deal": {"0": ["6-6","5-4", …]},      // whatever was known
     "moves": [{"p":1,"tile":"6-6","end":"right"}, {"p":2,"pass":true}, …],
     "revealed": {"1": ["5-5", …]},        // tiles shown at the count
     "result": {"kind":"tranque","winner":0,"points":58, …}
  }],
  "final_scores": [201, 118]
}
```

Two record types, both useful: **app games** (all four hands known — the gold
data) and **table reconstructions** (hero's hand + observed moves + whatever was
revealed at the count — sparser but real human play).

This is the same format as `Session` persistence, so build it once
(`docs/NEXT_SESSION.md` WP9 gets folded in here and bumped to schema v2).

### Privacy posture — decide it now, not after launch

- **No names, no accounts, no device identifiers, no location, no free text.**
  A random game id and the moves. Month-granularity dates, because exact
  timestamps re-identify people who played one game at one table.
- **Opt-in, default off.** One screen that shows an actual example of what gets
  sent, and a toggle. Not buried in settings.
- **No cross-game linkage in the upload.** This is the important design call and
  it reconciles the two goals: *player-specific* profiles (Phase 4) stay on the
  device forever; the uploaded corpus learns *population* archetypes, which
  cluster fine from within-game behaviour (a game gives 50–100 decisions per
  seat — plenty). Nothing uploaded links Juan's Tuesday game to his Friday game.
- **Deletion path.** Keep the uploaded `game_id`s locally so the user can
  request deletion of specific games; the server honours delete-by-id.
- Declare it in Google Play's Data Safety form and write a short privacy note
  in-app. If the corpus is ever published or shared, that has to be stated in
  the consent screen *before* collection starts, not retrofitted.

### Pipeline

Local SQLite queue → gzip batch → upload on Wi-Fi → server validates by replay,
dedupes on `game_id`, writes parquet shards. ~1 KB gzipped per game, so 100k
games is ~100 MB: trivial to store, trivial to reprocess.

**What the corpus is for:** fitting the archetype policies and the deal-choice
likelihood (behavioural cloning), calibrating the belief model against real
human play, and measuring engine-vs-human decision agreement. **Not** for value
labels — humans are the thing being beaten, so values keep coming from exact
solves and self-play.

**Acceptance.** 100% of uploaded replays re-simulate cleanly; a corpus of ≥ 500
games yields ≥ 4 behavioural clusters that improve partner-posterior accuracy
over the hand-built archetypes on held-out games.

---

## Phase 6 — Android, then web

Kotlin + Compose over the Rust core through UniFFI. The engine thinks on a
background thread during the other seats' turns; UI never blocks. Then the same
core to wasm32 for the web app, sharing the board renderer's design if not its
code. Screen inventory and the API shape are in `docs/NEXT_SESSION.md` WP10 —
they carry over unchanged.

---

## Honest expectations

| After | Strength |
|---|---|
| Phase 1 | Strong club player; **endgame perfect from ~ply 14** |
| Phase 2 | Top human |
| Phase 3 + 4 | Superhuman versus typical patio play, with high confidence |

"Superhuman versus the best Dominican pairs" is a claim only logged human games
can settle — which is the other reason Phase 5 matters. There is no public
benchmark for this game; the ladder in `data/ladder.jsonl` plus duplicate-scored
human sessions *is* the benchmark, and it has to be built.
