"""A fast training environment: the browser engine's State, in plain Python ints.

Self-play needs millions of hands, so this is not built on
:class:`dominord.state.HandState` (sets of Tile objects) but mirrors
``web/engine.js``'s ``State`` move for move: hands are 28-bit masks, moves
are small ints (``tile * 2 + end``, :data:`PASS`, :data:`DRAW`) and the rule
presets carry the 1v1 fields (``players``, ``draw``).  Scoring is checked
against :func:`dominord.scoring.score_totals` and the whole game against the
JS engine in ``tests/test_train_env.py``.

Pure Python, no dependencies: importable without the ``[train]`` extras.
"""

from __future__ import annotations

import random
from typing import Optional

LOW: list[int] = []
HIGH: list[int] = []
PIPS: list[int] = []
ID = [[0] * 7 for _ in range(7)]
SUIT = [0] * 7
for _a in range(7):
    for _b in range(_a, 7):
        _k = len(LOW)
        LOW.append(_a)
        HIGH.append(_b)
        PIPS.append(_a + _b)
        ID[_a][_b] = ID[_b][_a] = _k
        SUIT[_a] |= 1 << _k
        SUIT[_b] |= 1 << _k
FULL = (1 << 28) - 1
CHUCHA = 0
DOUBLE_SIX = 27
PASS = -1
DRAW = -2
PIPS_OF_MASK_CACHE: dict[int, int] = {}


def bits(mask: int) -> list[int]:
    out = []
    while mask:
        b = mask & -mask
        out.append(b.bit_length() - 1)
        mask ^= b
    return out


def pips_of(mask: int) -> int:
    s = 0
    while mask:
        b = mask & -mask
        s += PIPS[b.bit_length() - 1]
        mask ^= b
    return s


def tile_name(t: int) -> str:
    return f"{HIGH[t]}|{LOW[t]}"


# ---------------------------------------------------------------- rules
# Same fields and presets as web/engine.js (RULE_DEFAULTS / PRESETS); a test
# dumps the JS presets and compares.
RULE_DEFAULTS = {
    "label": "Patio (to 200)",
    "players": 4,
    "tilesPerPlayer": 7,
    "targetScore": 200,
    "firstOpener": "double_six",
    "firstOpenerMustPlay": True,
    "nextOpener": "hand_winner",
    "mustPlayIfAble": True,
    "handPoints": "all_remaining",
    "tranqueWinner": "lowest_individual",
    "tranqueTie": "opener",
    "tranquePoints": "all_remaining",
    "capicuaBonus": 25,
    "chuchazoBonus": 25,
    "pasoCorridoBonus": 25,
    "pollonaDoublesGame": False,
    "draw": False,
}
_FORMAL = dict(handPoints="opponents_only", tranquePoints="opponents_only",
               tranqueWinner="lowest_team_total", tranqueTie="no_score",
               capicuaBonus=0, chuchazoBonus=0, pasoCorridoBonus=0)
_MANO = dict(players=2, targetScore=100, firstOpener="highest_double",
             handPoints="opponents_only", tranquePoints="opponents_only",
             capicuaBonus=0, chuchazoBonus=0, pasoCorridoBonus=0)
PRESETS = {
    "patio": dict(RULE_DEFAULTS),
    "patio100": dict(RULE_DEFAULTS, label="Patio (to 100)", targetScore=100),
    "formal": dict(RULE_DEFAULTS, label="Formal / club", **_FORMAL),
    "mano": dict(RULE_DEFAULTS, label="1 vs 1, drawing (a robar)", draw=True, **_MANO),
    "mano_dormidas": dict(RULE_DEFAULTS, label="1 vs 1, no drawing (14 asleep)", draw=False, **_MANO),
}


def make_rules(name: str, **changes) -> dict:
    return dict(RULE_DEFAULTS, **PRESETS[name], **changes)


def tranque_winner(r: dict, pips: list[int], opener: int, blocker: int) -> Optional[int]:
    """Port of scoring.tranque_winner (seat or None)."""
    n = r["players"]
    if r["tranqueWinner"] == "lowest_individual":
        best = min(pips)
        tied = [s for s in range(n) if pips[s] == best]
    else:
        totals = [0, 0]
        for s in range(n):
            totals[s % 2] += pips[s]
        best = min(totals)
        tied = []
        for t in (0, 1):
            if totals[t] != best:
                continue
            seats = [s for s in range(n) if s % 2 == t]
            tied.append(min(seats, key=lambda s: pips[s]))
    if len(tied) == 1:
        return tied[0]
    if len({s % 2 for s in tied}) == 1:
        return min(tied)
    if r["tranqueTie"] == "no_score":
        return None
    preferred = opener if r["tranqueTie"] == "opener" else blocker
    if preferred is None or preferred < 0:
        return None
    if preferred in tied:
        return preferred
    partner = (preferred + 2) % n
    if partner in tied:
        return partner
    return None


# ---------------------------------------------------------------- game
class Game:
    """One hand with every hand known — what self-play simulates."""

    __slots__ = ("r", "n", "hands", "played_by", "voids", "left", "right", "turn",
                 "passes", "last", "pc", "chain_len", "pozo", "pozo_ptr", "capicua",
                 "closer", "opener", "forced", "log")

    def __init__(self, rules: dict, hands: list[int], pozo: list[int],
                 opener: int, forced: int = -1):
        self.r = rules
        self.n = rules["players"]
        self.hands = list(hands) + [0] * (4 - len(hands))
        self.played_by = [0, 0, 0, 0]
        self.voids = [0, 0, 0, 0]
        self.left = -1
        self.right = -1
        self.turn = opener
        self.passes = 0
        self.last = -1
        self.pc = [0, 0]
        self.chain_len = 0
        self.pozo = list(pozo)
        self.pozo_ptr = 0
        self.capicua = False
        self.closer = -1
        self.opener = opener
        self.forced = forced
        self.log: list[tuple[int, int]] = []

    # ------------------------------------------------------------ queries
    def pozo_left(self) -> int:
        return len(self.pozo) - self.pozo_ptr

    def is_over(self) -> bool:
        return (self.last >= 0 and self.hands[self.last] == 0) or self.passes >= self.n

    def legal(self, seat: Optional[int] = None) -> list[int]:
        """Same moves, same order as State.gen in engine.js."""
        seat = self.turn if seat is None else seat
        h = self.hands[seat]
        out: list[int] = []
        if self.chain_len == 0:
            if self.forced >= 0:
                if (h >> self.forced) & 1:
                    out.append(self.forced * 2 + 1)
            else:
                out.extend(t * 2 + 1 for t in bits(h))
        else:
            L, R = self.left, self.right
            sl, sr = SUIT[L], SUIT[R]
            for t in bits(h & (sl | sr)):
                b = 1 << t
                lok, rok = bool(sl & b), bool(sr & b)
                if lok:
                    out.append(t * 2)
                if rok and not (lok and L == R):
                    out.append(t * 2 + 1)
        if not out:
            out.append(DRAW if self.r["draw"] and self.pozo_ptr < len(self.pozo) else PASS)
        return out

    # ------------------------------------------------------------ moves
    def step(self, m: int) -> None:
        seat = self.turn
        self.log.append((seat, m))
        if m == PASS:
            if self.chain_len:
                self.voids[seat] |= (1 << self.left) | (1 << self.right)
            self.passes += 1
            if self.r["pasoCorridoBonus"] and self.passes == self.n - 1 and self.last >= 0:
                self.pc[self.last % 2] += 1
            self.turn = (seat + 1) % self.n
            return
        if m == DRAW:
            t = self.pozo[self.pozo_ptr]
            self.pozo_ptr += 1
            self.hands[seat] |= 1 << t
            self.voids[seat] = ((1 << self.left) | (1 << self.right)) if self.chain_len else 0
            return
        t = m >> 1
        b = 1 << t
        if self.chain_len == 0:
            self.left, self.right = LOW[t], HIGH[t]
        else:
            if self.hands[seat] == b:
                L, R = self.left, self.right
                self.capicua = L != R and t == ID[L][R]
            if m & 1:
                self.right = HIGH[t] if LOW[t] == self.right else LOW[t]
            else:
                self.left = HIGH[t] if LOW[t] == self.left else LOW[t]
        self.hands[seat] &= ~b
        self.played_by[seat] |= b
        self.chain_len += 1
        self.passes = 0
        self.last = seat
        self.closer = t
        self.turn = (seat + 1) % self.n

    # ------------------------------------------------------------ scoring
    def result(self) -> tuple[int, str, Optional[int]]:
        """(points signed for team 0, kind, winning team) of a finished hand."""
        r, n = self.r, self.n
        w = self.last
        pips = [pips_of(self.hands[s]) for s in range(n)]
        if w >= 0 and self.hands[w] == 0:
            team = w % 2
            pts = sum(p for s, p in enumerate(pips)
                      if r["handPoints"] == "all_remaining" or s % 2 != team)
            pts += self.pc[team] * r["pasoCorridoBonus"]
            if self.capicua and r["capicuaBonus"]:
                pts += r["capicuaBonus"]
            if self.closer == CHUCHA and r["chuchazoBonus"]:
                pts += r["chuchazoBonus"]
            return (pts if team == 0 else -pts), "domino", team
        winner = tranque_winner(r, pips, self.opener, self.last)
        if winner is None:
            return 0, "void", None
        team = winner % 2
        pts = sum(p for s, p in enumerate(pips)
                  if r["tranquePoints"] == "all_remaining" or s % 2 != team)
        pts += self.pc[team] * r["pasoCorridoBonus"]
        return (pts if team == 0 else -pts), "tranque", team


def first_opening(r: dict, hands: list[int]) -> tuple[int, int]:
    """(seat, forced tile or -1) for the first hand — engine.js firstOpening."""
    def holder(t: int) -> int:
        for s, h in enumerate(hands):
            if (h >> t) & 1:
                return s
        return -1
    must = r["firstOpenerMustPlay"]
    if r["firstOpener"] == "double_six":
        s = holder(DOUBLE_SIX)
        if s >= 0:
            return s, DOUBLE_SIX if must else -1
    if r["firstOpener"] in ("double_six", "highest_double"):
        for p in range(6, -1, -1):
            s = holder(ID[p][p])
            if s >= 0:
                return s, ID[p][p] if must else -1
    best, best_seat = -1, 0

    def rank(t: int) -> int:
        return PIPS[t] * 100 + (10 if LOW[t] == HIGH[t] else 0) + HIGH[t]
    for s, h in enumerate(hands):
        for t in bits(h):
            if best < 0 or rank(t) > rank(best):
                best, best_seat = t, s
    return best_seat, best if must else -1


def new_game(rules: dict, rng: random.Random, first_hand: Optional[bool] = None) -> Game:
    """Shuffle and deal.  Half the hands are first hands (forced salida), half
    are later hands opened by a random seat with any tile."""
    tiles = list(range(28))
    rng.shuffle(tiles)
    n = rules["players"]
    hands = [sum(1 << t for t in tiles[s * 7:(s + 1) * 7]) for s in range(n)]
    pozo = tiles[n * 7:]
    if first_hand is None:
        first_hand = rng.random() < 0.5
    if first_hand:
        opener, forced = first_opening(rules, hands)
    else:
        opener, forced = rng.randrange(n), -1
    return Game(rules, hands, pozo, opener, forced)
