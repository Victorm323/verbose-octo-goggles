# Training dominord on your GPU

Yes — self-play trains on a GPU, and this is the route ROADMAP.md Phases 2–4
point at. It is the method that took DouZero to superhuman play in DouDizhu,
the closest solved analogue to this game (hidden hands, an implicit team,
similar branching).

## Windows: one double-click

`train_gpu.bat` in the repository root does everything on a Windows PC with an
NVIDIA card (written for a GTX 1070):

1. checks the NVIDIA driver (`nvidia-smi`), Python 3.10+, numpy and PyTorch;
2. runs a real kernel on the GPU. A GTX 10xx is compute 6.1, which recent CUDA
   12.8+/13 wheels no longer include, so `torch.cuda.is_available()` alone
   would be a false positive;
3. if anything is missing, offers to install it into a private `.venv`: the
   CUDA 12.6 PyTorch wheels, falling back to CUDA 11.8 if those cannot run on
   the card;
4. trains (`--resume` if `runs\gpu` exists, otherwise warm-started from
   `checkpoints\cpu2.pt`), then rebuilds `dist\dominord-mesa.html`.

`train_gpu.bat 8` trains for 8 hours and `train_gpu.bat 8 6` also sets 6
actors. The default is 24 hours with logical CPUs − 2 actors. Run it again to
continue.

## Quick start

`checkpoints/cpu2.pt` is the network trained so far (~5M self-play hands on a
CPU). Pass `--init checkpoints/cpu2.pt` to continue from it instead of from
scratch.

```bash
pip install -e ".[train]"              # numpy + torch; the core stays dependency-free
python -m dominord.train --out runs/first --hours 12 --actors 12 \
    --export web/models/dominord-net.json
python3 scripts/build_web.py           # the page now carries the champion network
node scripts/duplicate.js --a live:net --b live --deals 1000   # is it actually stronger?
```

`--device auto` picks CUDA, then Apple MPS, then CPU. `--actors` is the number
of self-play processes. Give it one per CPU core you can spare: the GPU learner
is rarely the bottleneck, hand generation is. `--resume` continues a run.

Watch `runs/first/log.jsonl` (throughput, losses) and `runs/first/ladder.jsonl`
(every evaluation). A new champion is exported only when it passes the gate
below.

## What runs

```
 actors (CPU, one process each)                  learner (GPU)
 ┌───────────────────────────────┐   batches    ┌──────────────────────────────┐
 │ 128 hands in lockstep          │ ───────────▶ │ replay buffer (1M decisions) │
 │ seats: current net, snapshots, │              │ Adam, batch 2048             │
 │ heuristic styles               │ ◀─────────── │ loss = Q + ½V + 0.2·belief   │
 │ one batched forward per round  │  current.pt  │ snapshot · evaluate · gate    │
 └───────────────────────────────┘   (reload)    └──────────────────────────────┘
```

| Piece | File | Why it is there |
|---|---|---|
| Environment | `dominord/train/env.py` | The browser engine's bitmask `State` in Python ints. It plays and scores exactly like `dominord.state`/`scoring` (tested), covering 2v2 and 1v1 with or without drawing. |
| Features | `dominord/train/features.py` | 227 numbers for one seat's information set plus 48 for a candidate move. Only the seat's own hand and public history, so nothing hidden leaks. `web/engine.js` has an identical twin (tested number for number). |
| Network | `dominord/train/model.py` | Four heads on one trunk: **Q** (value of each move), **V** (expected hand points), **win/tranque** (P our pair takes the hand, P it ends blocked) and **belief** (who holds each unseen tile). About 225k weights (two 256-wide layers), small enough for a phone to call thousands of times per search; see *Phones* below. |
| Observer rows | `selfplay.play` | At every decision the same moment is also encoded from another seat. V, win/tranque and belief then learn positions where the seat evaluated is *not* the one to move, which is what the UI asks for. Q trains on real decisions only. |
| Deep Monte-Carlo | `selfplay.py`, `train.py` | Q is regressed straight onto the final hand return of the move played. There is no bootstrapping to diverge, and the policy is argmax Q. |
| Belief head | `model.py` | Predicts who holds each unseen tile, trained on the true deal. It forces the trunk to learn to read passes and choices, and inference-aware Q values follow. |
| Population | `selfplay.Population` | Rivals are the current net (45%), a frozen snapshot (30%) or patio-style heuristics (25%). 15% of 2v2 hands give the net a *heuristic partner*. Training only against copies of itself breeds private conventions (the Hanabi failure). |
| Rule mixture | `--rules` | One net for patio, formal, 1v1 drawing and 1v1 asleep. The rules are features. |
| Gate | `train.promote` | A net becomes champion only if it beats the previous champion (the greedy player, the first time) in **both** 2v2 and 1v1 on duplicate-scored deals, with the whole 95% CI above zero. |
| Export | `model.export_json` | `dominord-net.json` for `web/engine.js`; `scripts/build_web.py` embeds it in the page. |

## How the browser uses the network

**Network read** (Engine panel, instant, no search), from your seat:

| Shown | Head | Meaning |
|---|---|---|
| Points, for us · adv | V | expected hand points for your pair; advantage = tanh(V/35), the bar's scale (the yellow tick on the bar) |
| We take the hand | win | P(your pair wins this hand) |
| Tranque | win/tranque | P(the hand ends blocked) |
| Network's choice · chance best | Q | softmax(Q / temperature) over your legal tiles, with each tile's Q in points |
| Odds grid → **Network** | belief | who holds each unseen tile, masked by everything certain (passes, hand sizes, the table) and renormalised, so it can sharpen the exact odds but never contradict them |

"Chance best" is the network's confidence, a softmax over its own move values
with a fixed temperature (3 points by default, stored in the export). It is not
a calibrated frequency.

With the **Network** toggle on, the search also uses it:

1. **Rollouts to the exact horizon.** Each imagined deal is played forward by
   the network until it is small enough to solve exactly (22 tiles at Quick,
   24 at Normal). Then alpha-beta takes over. Before, those early plies were
   greedy one-ply playouts, the weakest link in the search.
2. **Reading choices (Phase 4, opt-in: "Model their style").** Every unseen seat gets a posterior over
   styles: *sharp* (the network), *steady* (one-ply greedy), *heavy-first* and
   *erratic*. It is updated from every tile they chose, averaged over the
   possible deals and shrunk toward the prior. Deals are weighted by how
   plausible the observed plays are under that mixture, and rollouts play each
   seat in its modelled style. The seat panels show it: "plays heavy-first 68%".
   Measured against the older static weighting on 300 duplicate deals it
   scored −2.4 pts/hand (CI [−6.4, +1.5]) against engine opponents, which is
   not an improvement, so it is off by default. Against real patio players,
   who *are* heavy-first or erratic, the trade-off may differ. That is a
   question for logged human games (ROADMAP Phase 5).
3. **Network-only play.** In Play mode the "Network" level is argmax Q with no
   search: instant, and free of PIMC's strategy fusion.

## Throughput

Measured in this repository's 4-core CPU container (no GPU): 3 actors produce
about **15–19k decisions/s ≈ 2,400 hands/s**. The learner keeps up at replay
ratio 4 even on CPU. Hand generation scales with cores, about 800 hands/s per
actor, so a 16-core machine with any recent NVIDIA card makes ~12k hands/s,
i.e. **~40M hands an hour**. DouZero trained on billions of frames over days.
Budget accordingly: overnight runs, then days.

### What a GTX 1070 machine can expect

The GPU is not the limit: a 1070 runs the learner's batch of 2048 in a few
milliseconds. Hands come from the CPU, at roughly 600–800 hands/s per actor
(measured here: 3 actors ≈ 640 hands/s with the learner sharing the CPU).

| CPU | actors | hands/hour | 50M hands | 300M hands |
|---|---|---|---|---|
| 4 cores / 8 threads (i7-7700) | 6 | ~10–13M | ~4–5 h | ~1–1.5 days |
| 6 cores / 12 threads (Ryzen 5 3600, i7-8700) | 10 | ~16–22M | ~2.5–3 h | ~15–19 h |
| 8 cores / 16 threads | 14 | ~22–30M | ~2 h | ~10–14 h |

Hyperthreads add less than a real core, so read the upper end of each range
with caution. Where the milestones fall can only be measured, but as a guide:
`cpu2` (~5M hands) still loses to greedy in 2v2. Expect the first promotion
(beating greedy in both formats) in the tens of millions of hands, an
afternoon to a night. Expect stage 2 (the network alone matching the search)
in the hundreds of millions, several days of nights.

## Phones

The page has to run well on a recent iPhone and on a Redmi Note 13 Pro+
(Dimensity 7200-Ultra) as the baseline. Measured in Node on this repository's
container (a slow server core, roughly a mid-range phone core):

| trunk width | weights | page adds | one decision (trunk + 4 moves) | live-search deals in 500 ms |
|---|---|---|---|---|
| 128 | 88k | 0.5 MB | 0.11 ms | same |
| **256 (shipped)** | **225k** | **1.2 MB** | **0.30 ms** | **same** |
| 384 | 411k | 2.2 MB | 0.51 ms | same |
| 512 | 647k | 3.4 MB | 0.88 ms | not measured |

The search budget is spent in the exact endgame solver, not in the network,
so the number of deals a 500 ms analysis reaches did not change between 128 and
384. The network read panel is a single call, under a millisecond on any of
these sizes. The Q head applies the trunk half of its first layer once per
position, so each candidate move only costs its 48 sparse features.
`scripts/build_web.py` warns above 384, the phone ceiling. Width 256 is the
default because it warm-starts from `checkpoints/cpu2.pt`, and what limits
strength today is training hands, not capacity.

## A schedule that has a chance of superhuman

| Stage | Command | Gate to pass before the next stage |
|---|---|---|
| 1 | `--hours 12` (defaults) | champion beats `greedy` in both formats |
| 2 | `--resume --hours 48 --replay-ratio 2` | `node scripts/duplicate.js --a net --b live --deals 1000`: the network alone ties or beats the search |
| 3 | new run `--hidden 384 --qhidden 192` (the phone ceiling), 3–5 days | `--a live:net --b live` ≥ +3 pts/hand, CI above zero (ROADMAP Phase 2 acceptance) |
| 4 | keep going; widen `Population.styles` with fitted clusters from real games | beats every earlier champion on the ladder |

"Superhuman" is not something code can promise. It is a claim you establish on
the duplicate harness, and ultimately against strong human pairs, which is what
the replay corpus (ROADMAP Phase 5) is for. What this pipeline guarantees is
that every step is measured, and that nothing weaker than the previous
champion reaches the page.

## Knobs worth knowing

| Flag | Default | Notes |
|---|---|---|
| `--games` | 128 | hands per actor round; larger batches keep the GPU fuller |
| `--replay-ratio` | 4 | samples trained per new decision; lower it if the loss overfits |
| `--epsilon` | 0.02 | random-move exploration |
| `--belief-weight` | 0.2 | weight of the auxiliary who-holds-what loss |
| `--eval-deals` | 600 | per format per opponent; about 2 minutes on a CPU core |
| `--rules` | all four | e.g. `--rules patio,formal` for a 2v2 specialist |
| `--init` | – | start from another run's weights; heads added since start fresh |

The browser uses an ungated network (one that never beat the previous
champion) only for the read panel. The search switches to it only when the
export records a promotion, or when you tick **Network** yourself.
