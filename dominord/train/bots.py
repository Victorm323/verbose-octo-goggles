"""The population the network trains with and against (ROADMAP Phase 2).

An agent trained only against copies of itself invents conventions no human
shares (the Hanabi failure).  So opponents *and partners* are drawn from a
mixture of human-like styles as well as network snapshots.  The same styles
are the archetypes the browser's partner model scores (Phase 4), so the names
here are part of the contract with ``web/engine.js``.
"""

from __future__ import annotations

import random

from .env import HIGH, LOW, PIPS, SUIT, Game, bits


def _plays(legal: list[int]) -> list[int]:
    return [m for m in legal if m >= 0]


def heavy(g: Game, legal: list[int], rng: random.Random) -> int:
    """El patio: drop the heaviest tile that fits."""
    best = max(PIPS[m >> 1] for m in legal)
    return rng.choice([m for m in legal if PIPS[m >> 1] == best])


def random_legal(g: Game, legal: list[int], rng: random.Random) -> int:
    return rng.choice(legal)


def double_hoarder(g: Game, legal: list[int], rng: random.Random) -> int:
    """Keeps doubles back until they are the only play, otherwise heavy."""
    plain = [m for m in legal if LOW[m >> 1] != HIGH[m >> 1]]
    return heavy(g, plain or legal, rng)


def suit_leader(g: Game, legal: list[int], rng: random.Random) -> int:
    """"Repite": play into the number it holds most of, so it can answer again."""
    hand = g.hands[g.turn]

    def score(m: int) -> float:
        t = m >> 1
        # the face left exposed after the play
        if g.chain_len == 0:
            exposed = [LOW[t], HIGH[t]]
        else:
            end = g.right if m & 1 else g.left
            exposed = [HIGH[t] if LOW[t] == end else LOW[t]]
        rest = hand & ~(1 << t)
        return max(bin(rest & SUIT[e]).count("1") for e in exposed) + PIPS[t] / 100.0
    best = max(score(m) for m in legal)
    return rng.choice([m for m in legal if score(m) >= best - 1e-9])


def greedy(g: Game, legal: list[int], rng: random.Random) -> int:
    """One-ply greedy on dominord.search.static_eval (the old rollout policy)."""
    team = g.turn % 2
    best_v, best = -1e9, []
    for m in legal:
        v = _static_after(g, m, team)
        if v > best_v + 1e-9:
            best_v, best = v, [m]
        elif v > best_v - 1e-9:
            best.append(m)
    return rng.choice(best)


def _static_after(g: Game, m: int, team: int) -> float:
    t = m >> 1
    hands = list(g.hands)
    seat = g.turn
    hands[seat] &= ~(1 << t)
    if g.chain_len == 0:
        L, R = LOW[t], HIGH[t]
    else:
        L, R = g.left, g.right
        if m & 1:
            R = HIGH[t] if LOW[t] == R else LOW[t]
        else:
            L = HIGH[t] if LOW[t] == L else LOW[t]
    if hands[seat] == 0:
        return 1000.0  # going out is always the greedy choice
    ends = SUIT[L] | SUIT[R]
    pip = tiles = control = 0.0
    for s in range(g.n):
        sign = -1 if s % 2 == team else 1
        pip += sign * sum(PIPS[x] for x in bits(hands[s]))
        tiles += sign * bin(hands[s]).count("1")
        control -= sign * bin(hands[s] & ends).count("1")
    return 0.45 * pip + 3.0 * tiles + 1.5 * control


HEURISTICS = {
    "heavy": heavy,
    "random": random_legal,
    "double_hoarder": double_hoarder,
    "suit_leader": suit_leader,
    "greedy": greedy,
}


def choose(name: str, g: Game, legal: list[int], rng: random.Random) -> int:
    plays = _plays(legal)
    if len(legal) == 1 or not plays:
        return legal[0]
    return HEURISTICS[name](g, plays, rng)
