"""Ground truth from the Python engine for the browser port's conformance test.

The Python engine is the oracle (ROADMAP Phase 1: "a port that is fast and
subtly wrong is worse than no port").  This writes positions plus what Python
says about them; tests/js/conformance.test.js asserts the JS engine agrees.

    python3 tests/js/make_fixtures.py > tests/js/fixtures.json
"""

from __future__ import annotations

import json
import random
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))

from dominord.inference import build_beliefs  # noqa: E402
from dominord.rules import PRESETS  # noqa: E402
from dominord.scoring import score_hand, score_totals  # noqa: E402
from dominord.search import solve  # noqa: E402
from dominord.state import End, HandState, Pass, deal_tiles  # noqa: E402
from dominord.table import TableView  # noqa: E402


def move_dict(m):
    if isinstance(m, Pass):
        return {"k": "pass", "p": m.player}
    return {"k": "play", "p": m.player, "tile": str(m.tile),
            "end": "L" if m.end is End.LEFT else "R"}


def random_line(rng, rules, stop_tiles, forced=True):
    """A random legal line from a random deal, stopped at `stop_tiles` left."""
    deal = deal_tiles(rng, rules)
    opener = rng.randrange(4)
    state = HandState.from_deal(deal, rules, opener=opener)
    if forced and rng.random() < 0.5:
        # Hand the [6|6] to the opener so forced salidas get exercised too.
        holder = next(s for s, h in enumerate(state.hands) if any(
            t.low == 6 and t.high == 6 for t in h))
        if holder != opener:
            a, b = state.hands[holder], state.hands[opener]
            six = next(t for t in a if t.low == 6 and t.high == 6)
            swap = next(iter(b))
            a.discard(six)
            b.discard(swap)
            a.add(swap)
            b.add(six)
            deal = [set(h) for h in state.hands]
        state.force_open_tile(six if holder != opener else next(
            t for t in state.hands[opener] if t.low == 6 and t.high == 6))
    dealt = [sorted(str(t) for t in h) for h in state.hands]
    moves = []
    while not state.is_over() and state.tiles_left > stop_tiles:
        opts = state.legal_moves()
        mv = rng.choice(opts)
        state.apply(mv)
        moves.append(mv)
    return state, dealt, opener, moves


def main() -> None:
    rng = random.Random(20260926)
    out: dict = {"scoring": [], "positions": [], "beliefs": []}

    # 1. scoring from pip totals, every preset, dominó and tranque
    for name, rules in PRESETS.items():
        for _ in range(400):
            pips = [rng.choice([0, 0, 1, 2, 3, 5, 7, 8, 12, 15, 20, 25, 30]) for _ in range(4)]
            kind = rng.choice(["domino", "tranque"])
            opener = rng.randrange(4)
            blocker = rng.choice([None, 0, 1, 2, 3])
            winner = None
            if kind == "domino":
                winner = rng.randrange(4)
                pips[winner] = 0
            capicua, chuchazo = rng.random() < 0.3, rng.random() < 0.2
            from dominord.state import BonusEvent
            pc = [rng.choice([0, 0, 0, 1, 2]), rng.choice([0, 0, 0, 1])]
            events = [BonusEvent("paso_corrido", t, t, rules.paso_corrido_bonus)
                      for t in (0, 1) for _ in range(pc[t])]
            res = score_totals(rules, pips, kind, winner=winner, opener=opener,
                               blocker=blocker, bonus_events=events,
                               capicua=capicua, chuchazo=chuchazo)
            out["scoring"].append({
                "preset": name, "pips": pips, "kind": kind, "winner": winner,
                "opener": opener, "blocker": blocker, "pc": pc,
                "capicua": capicua, "chuchazo": chuchazo,
                "result": {"kind": res.kind, "winner": res.winner,
                           "winning_team": res.winning_team, "points": res.points,
                           "next_opener": res.next_opener},
            })

    # 2. legal moves + exact solve values + finished-hand scores
    for i in range(160):
        name = ["patio", "formal", "patio100"][i % 3]
        rules = PRESETS[name]
        stop = rng.choice([8, 10, 11, 12, 13])
        state, dealt, opener, moves = random_line(rng, rules, stop)
        rec = {"preset": name, "dealt": dealt, "opener": opener,
               "forced": str(state._forced_open_tile) if state._forced_open_tile else None,
               "moves": [move_dict(m) for m in moves]}
        rec["legal"] = [move_dict(m) for m in state.legal_moves()] if not state.is_over() else []
        value, _ = solve(state.copy(), 0)
        rec["solve0"] = value
        # play the rest out randomly and record the final score
        fin = state.copy()
        while not fin.is_over():
            fin.apply(rng.choice(fin.legal_moves()))
        r = score_hand(fin)
        rec["final_moves"] = [move_dict(m) for m in fin.log[len(moves):]]
        rec["final"] = {"kind": r.kind, "winner": r.winner, "points": r.points,
                        "winning_team": r.winning_team}
        out["positions"].append(rec)

    # 3. beliefs: exact deal counts and marginals, hero = seat 0
    for i in range(120):
        rules = PRESETS["patio"]
        stop = rng.choice([27, 24, 20, 16, 12, 8])
        state, dealt, opener, moves = random_line(rng, rules, stop, forced=False)
        view = TableView(rules=rules, opener=opener, hero=0)
        from dominord.tiles import Tile
        view.set_hand(0, [Tile.parse(t) for t in dealt[0]])
        for m in moves:
            view.record(m)
        b = build_beliefs(view)
        marg = {str(t): {str(s): p for s, p in d.items()} for t, d in b.marginals.items()}
        out["beliefs"].append({
            "dealt0": dealt[0], "opener": opener,
            "moves": [move_dict(m) for m in moves],
            "total": b.total_deals, "marginals": marg,
        })

    json.dump(out, sys.stdout)


if __name__ == "__main__":
    main()
