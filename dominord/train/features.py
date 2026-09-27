"""What the network sees: one seat's information set, and a candidate move.

The encoding reads only the acting seat's own hand plus public information
(who played what, who is void in what, hand sizes, the ends, the pass streak,
the pozo, the rules), so it never leaks hidden hands and works unchanged on a
determinized position inside the search.  ``web/engine.js`` has a line-by-line
twin (``stateFeatures`` / ``actionFeatures``); ``tests/test_train_env.py``
checks they agree number for number.

Seats are relative: slot 0 is the acting seat, slot k the seat k places after
it in playing order (slot 2 is the partner at a 4-seat table).
"""

from __future__ import annotations

import numpy as np

from .env import DRAW, FULL, HIGH, LOW, PASS, PIPS, Game

STATE_DIM = 227
ACTION_DIM = 48

_FLAG_KEYS = ("players2", "draw", "all_remaining", "lowest_team_total",
              "capicua", "chuchazo", "paso_corrido")


def _set_bits(out: np.ndarray, offset: int, mask: int) -> None:
    while mask:
        b = mask & -mask
        out[offset + b.bit_length() - 1] = 1.0
        mask ^= b


def state_features(g: Game, me: int, out: np.ndarray | None = None) -> np.ndarray:
    f = np.zeros(STATE_DIM, dtype=np.float32) if out is None else out
    if out is not None:
        f[:] = 0.0
    n, r = g.n, g.r
    o = 0
    _set_bits(f, o, g.hands[me])
    o += 28
    played = 0
    for k in range(4):
        if k < n:
            s = (me + k) % n
            _set_bits(f, o + k * 28, g.played_by[s])
            played |= g.played_by[s]
    o += 112
    _set_bits(f, o, FULL & ~g.hands[me] & ~played)
    o += 28
    for k in range(1, 4):
        if k < n:
            s = (me + k) % n
            v = g.voids[s]
            for suit in range(7):
                if v >> suit & 1:
                    f[o + (k - 1) * 7 + suit] = 1.0
    o += 21
    for k in range(4):
        if k < n:
            f[o + k] = bin(g.hands[(me + k) % n]).count("1") / 7.0
    o += 4
    if g.chain_len:
        f[o + g.left] = 1.0
        f[o + 7 + g.right] = 1.0
    o += 14
    f[o] = 1.0 if g.chain_len == 0 else 0.0
    o += 1
    f[o + min(g.passes, 3)] = 1.0
    o += 4
    f[o] = g.pozo_left() / 14.0
    o += 1
    if g.last >= 0:
        f[o + (g.last - me) % n] = 1.0
    o += 4
    team = me % 2
    f[o] = g.pc[team] / 2.0
    f[o + 1] = g.pc[1 - team] / 2.0
    o += 2
    flags = (n == 2, r["draw"], r["handPoints"] == "all_remaining",
             r["tranqueWinner"] == "lowest_team_total", r["capicuaBonus"] > 0,
             r["chuchazoBonus"] > 0, r["pasoCorridoBonus"] > 0)
    for i, x in enumerate(flags):
        f[o + i] = 1.0 if x else 0.0
    o += 7
    f[o] = 1.0 if (g.forced >= 0 and g.chain_len == 0) else 0.0
    o += 1
    assert o == STATE_DIM
    return f


def action_features(g: Game, m: int, out: np.ndarray | None = None) -> np.ndarray:
    a = np.zeros(ACTION_DIM, dtype=np.float32) if out is None else out
    if out is not None:
        a[:] = 0.0
    if m == PASS:
        a[30] = 1.0
        L, R = g.left, g.right
    elif m == DRAW:
        a[31] = 1.0
        L, R = g.left, g.right
    else:
        t = m >> 1
        a[t] = 1.0
        if g.chain_len == 0:
            a[29] = 1.0
            L, R = LOW[t], HIGH[t]
        else:
            a[28 + (m & 1)] = 1.0
            L, R = g.left, g.right
            if m & 1:
                R = HIGH[t] if LOW[t] == R else LOW[t]
            else:
                L = HIGH[t] if LOW[t] == L else LOW[t]
        a[46] = PIPS[t] / 12.0
        a[47] = 1.0 if LOW[t] == HIGH[t] else 0.0
    if L >= 0:
        a[32 + L] = 1.0
        a[39 + R] = 1.0
    return a


def belief_targets(g: Game, me: int) -> np.ndarray:
    """For the auxiliary head: who holds each tile the acting seat cannot see.

    Class 0 = the pozo, class k = relative seat k; -1 = not a hidden tile.
    """
    y = np.full(28, -1, dtype=np.int64)
    n = g.n
    for k in range(1, n):
        s = (me + k) % n
        m = g.hands[s]
        while m:
            b = m & -m
            y[b.bit_length() - 1] = k
            m ^= b
    for t in g.pozo[g.pozo_ptr:]:
        y[t] = 0
    return y
