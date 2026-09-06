# dominord — motor de dominó dominicano

A Dominican domino engine (4 players, 2 pairs, double-six, no boneyard) that

* **reconstructs a physical game on a virtual board** — you type what happens at
  the table, it keeps the chain, the ends, the turn and the legality;
* **tracks the likely tiles in every hand** — exact probabilities over all deals
  still consistent with what has been played and passed;
* **evaluates the best move for every player**, not just yours;
* **shows an evaluation bar** — advantage, chance of a tranque, and who takes the
  count if the table dies.

Rules, variants and the sources behind them: **[docs/RULES.md](docs/RULES.md)**.

---

## Quick start

```bash
python3 -m dominord            # the console (no dependencies, Python 3.10+)
```

```
> nombres Yo Juan Socio Pedro
> mano 6-6 5-5 3-1 0-0 2-6 4-4 5-0     # your seven tiles; the [6|6] opens
> juega yo 6-6
> juan 6-1                             # shorthand: <jugador> <ficha> [izq|der]
> paso socio
> eval
```

```
── mesa ──────────────────────────────────────────────────────────────────
punta izquierda: 6     punta derecha: 1
[6|6][6|1]

asiento   fichas  puntos esp.  no tiene
────────────────────────────────────────────────
Yo      (tú)   6        35.0    -   [pareja 0]
Juan           6        34.7    -   [pareja 1]
Socio          7        38.8    1 6   [pareja 0]
Pedro          7        40.5    -   [pareja 1]

── evaluación ────────────────────────────────────────────────────────────
    pareja 1  [        ############|                    ]  pareja 0     ←
ventaja -0.60   puntos esperados -24.1   ganamos la mano 20.0%
tranque: probabilidad 15.0% | la ganamos 41.7% | si trancara ahora 37.5%
puntos esperados en mano: Yo 35.0  Juan 34.7  Socio 38.8  Pedro 40.5
Pedro puede trancar a su favor: [1|4] right  ev +23.1  win 78.4%  tranque 32.4%
```

Socio passed on the 6 and the 1, so the engine has already struck every tile
carrying a 6 or a 1 out of his hand — for the rest of the hand.


Other entry points:

```bash
python3 -m dominord mesa --rules formal --names Yo Juan Socio Pedro
python3 -m dominord selfplay --matches 3 --greedy-rivals
python3 scripts/benchmark.py --matches 10      # engine pair vs "heaviest tile" pair
pytest                                         # the test suite
```

## Console commands

| | |
|---|---|
| `nueva [patio\|patio100\|formal]` | start a match under a rule preset |
| `nombres <a> <b> <c> <d>` / `soy <jugador>` | name the seats / say which one is yours |
| `mano <7 fichas>` | your dealt hand — starts the hand |
| `salida <jugador>` | who opens (needed when you don't hold the [6\|6]) |
| `juega <jugador> <ficha> [izq\|der]` | record a play (shorthand: `juan 6-4`) |
| `paso <jugador>` / `deshacer` | record a pass / undo |
| `mesa` / `barra` / `fichas [n]` | board & seats / evaluation bar / tile probabilities |
| `eval [rápido\|hondo]` | the full read of the position |
| `sugerencia [jugador]` | best moves for a seat (a prediction, for seats you can't see) |
| `fin puntos <p0> <p1> <p2> <p3>` | close the hand with the pips announced |
| `fin fichas <jugador>=<fichas>; ...` | close it with the tiles revealed (spots capicúa) |
| `puntos` / `guardar <f>` / `cargar <f>` | scoreboard / save / load |

Every command has an English alias (`deal`, `play`, `pass`, `board`, `hint`, `end`…).

## As a library

```python
from dominord import Session, evaluate_position, parse_tiles, Tile

s = Session(player_names=("Yo", "Juan", "Socio", "Pedro"), hero=0)
s.start_hand(parse_tiles("6-6 5-5 3-1 0-0 2-6 4-4 5-0"))
s.play(0, Tile(6, 6))
s.play(1, Tile.of(6, 1))
s.passes(2)                       # Socio can't answer a 6 or a 1 — ever again

pos = evaluate_position(s.view)
pos.best.move                     # the engine's pick for the seat on play
pos.advantage                     # -1 .. +1, from your pair's side
pos.tranque.win_if_now            # who takes the count if the table dies now
pos.beliefs.probability(3, Tile.of(5, 5))   # P(Pedro holds the [5|5])
```

## How it works

| Module | Job |
|---|---|
| `tiles.py`, `state.py` | the 28 tiles, the chain, legality, undo |
| `rules.py` | every house rule as a field; `patio` / `patio100` / `formal` presets |
| `scoring.py` | dominó, tranque, capicúa, chuchazo, paso corrido, ties |
| `table.py` | what an observer knows: the reconstruction layer |
| `inference.py` | candidate sets from passes + **exact** tile probabilities (DP over all consistent deals) and uniform sampling of them |
| `search.py` | perfect-information Monte Carlo: imagine consistent deals, play each out, solve the endgame exactly with alpha-beta |
| `evaluation.py` | the bar: expected points, win rate, tranque chance and opportunity |
| `render.py`, `cli.py`, `session.py` | text output, console, JSON save/load |
| `selfplay.py` | four private views, one table — the engine playing itself |

Two ideas do most of the work:

1. **A pass is permanent.** Tiles never return to a hand, so "Socio passed on 6
   and 1" removes thirteen tiles from his possible holdings for the rest of the
   hand. Counting the deals that survive those constraints is a small dynamic
   program, so the probabilities are exact rather than sampled — and the same
   table samples deals uniformly for the search.
2. **Guess, then play it out.** The engine samples deals consistent with
   everything observed, plays each one out (solving exactly once few tiles
   remain), and averages the hand points. That is where the bar, the move
   ranking and the tranque odds all come from — one shared batch of imagined
   deals, so the numbers never contradict each other.

Strength check (`scripts/benchmark.py`, 6 matches, patio rules): the engine pair
beat the "drop your heaviest legal tile" pair **5–1**, 1319 points to 717.

## What's next

`docs/ROADMAP.md` is the plan of record: a native Rust core (the same engine on
Android, the web and Python), a learned value function trained from exactly
solved endgames, belief search on the opening plies, live Bayesian partner
modelling that adapts to a stranger inside the first hand, and an anonymous
replay corpus — game id and moves only, no names — that feeds retraining.

`docs/NEXT_SESSION.md` is the detailed backlog behind it: closing the engine's
known weaknesses (variance in the bar, the uniform prior over deals, PIMC's
strategy fusion, match-aware play) and putting the board in a **browser** —
a local SVG app (`python3 -m dominord web`) plus a self-contained replay page you
can share. `CLAUDE.md` holds the conventions and the invariants not to break.

## Repository note

This repository was created from n8n's node-starter template; the leftover
JavaScript scaffolding (`nodes/`, `credentials/`, `package.json`, `tsconfig.json`,
lint configs) is unrelated to the engine and can be deleted — its README is kept
at [`docs/n8n-starter-README.md`](docs/n8n-starter-README.md).
