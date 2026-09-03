"""Counting a finished hand, Dominican style.

Two things end a hand:

* **dominó / se pegó** - somebody lays their last tile;
* **tranque** - the four players pass in a row and the chain is dead.

Who scores, and how much, depends on the table's :class:`~dominord.rules.RuleSet`.
The counting itself only needs the pips left in each hand, so it is exposed
twice: :func:`score_hand` for a simulated state, and :func:`score_totals` for a
real table where the players simply announce what they were holding.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Iterable, Optional, Sequence

from .rules import HandPoints, NextOpener, RuleSet, TranqueTie, TranqueWinner
from .state import BonusEvent, HandState
from .tiles import CHUCHA, Tile


@dataclass(frozen=True)
class HandResult:
    """The outcome of one hand: who took it, for how much, and why."""

    kind: str                      # "domino" | "tranque" | "void"
    winner: Optional[int]          # seat that took the hand
    winning_team: Optional[int]
    points: int                    # total awarded to the winning team
    base_points: int               # the pips part of the score
    bonuses: tuple[tuple[str, int], ...] = ()
    hand_pips: tuple[int, ...] = ()
    team_pips: tuple[int, int] = (0, 0)
    next_opener: int = 0
    notes: tuple[str, ...] = ()

    @property
    def is_capicua(self) -> bool:
        return any(k == "capicua" for k, _ in self.bonuses)

    @property
    def is_chuchazo(self) -> bool:
        return any(k == "chuchazo" for k, _ in self.bonuses)

    def describe(self) -> str:
        if self.kind == "void":
            return "Tranque empatado - nadie cuenta"
        who = f"P{self.winner} (pareja {self.winning_team})"
        extra = "".join(f" +{p} {k}" for k, p in self.bonuses)
        head = "Dominó" if self.kind == "domino" else "Tranque"
        return f"{head}: {who} cuenta {self.points} ({self.base_points} puntos{extra})"


# ----------------------------------------------------------------------
# helpers
# ----------------------------------------------------------------------
def _seats_of_team(rules: RuleSet, team: int) -> list[int]:
    return [s for s in range(rules.players) if rules.team_of(s) == team]


def _team_pips(rules: RuleSet, pips: Sequence[int]) -> tuple[int, int]:
    return (
        sum(p for s, p in enumerate(pips) if rules.team_of(s) == 0),
        sum(p for s, p in enumerate(pips) if rules.team_of(s) == 1),
    )


def _base_points(rules: RuleSet, pips: Sequence[int], team: int,
                 mode: HandPoints) -> int:
    if mode is HandPoints.ALL_REMAINING:
        return sum(pips)
    return sum(pips[s] for s in _seats_of_team(rules, 1 - team))


def _next_opener(rules: RuleSet, winner: int, opener: int) -> int:
    if rules.next_opener is NextOpener.HAND_WINNER:
        return winner
    if rules.next_opener is NextOpener.WINNER_TEAM_ROTATES:
        return rules.partner_of(winner)
    return rules.next_seat(opener)


def is_capicua(state: HandState) -> bool:
    """True when the closing tile fitted *both* ends with its two faces."""
    ctx = state.winning_tile_context()
    if ctx is None:
        return False
    play, left_before, right_before = ctx
    if left_before == right_before:
        return False  # the same number at both ends is not a capicúa
    return play.tile == Tile.of(left_before, right_before)


def tranque_winner(rules: RuleSet, pips: Sequence[int], opener: int,
                   blocker: Optional[int]) -> tuple[Optional[int], list[str]]:
    """Seat that takes a blocked hand under ``rules``, plus commentary."""
    notes: list[str] = []
    if rules.tranque_winner is TranqueWinner.LOWEST_INDIVIDUAL:
        best = min(pips)
        tied = [s for s, p in enumerate(pips) if p == best]
    else:
        totals = _team_pips(rules, pips)
        best = min(totals)
        tied = [
            min(_seats_of_team(rules, t), key=lambda s: pips[s])
            for t, p in enumerate(totals)
            if p == best
        ]
    if len(tied) == 1:
        return tied[0], notes
    if len(set(rules.team_of(s) for s in tied)) == 1:
        # Both light hands belong to the same pair: no tie to break.
        return min(tied), notes
    if rules.tranque_tie is TranqueTie.NO_SCORE:
        notes.append("Empate en el tranque: la mano se anula")
        return None, notes
    prefers_opener = rules.tranque_tie is TranqueTie.OPENER
    preferred = opener if prefers_opener else blocker
    label = "la salida" if prefers_opener else "quien trancó"
    if preferred is None:
        notes.append("Empate sin desempate posible: la mano se anula")
        return None, notes
    if preferred in tied:
        notes.append(f"Empate resuelto a favor de {label}")
        return preferred, notes
    partner = rules.partner_of(preferred)
    if partner in tied:
        notes.append(f"Empate resuelto a favor de la pareja de {label}")
        return partner, notes
    notes.append("Empate sin desempate posible: la mano se anula")
    return None, notes


# ----------------------------------------------------------------------
# scoring
# ----------------------------------------------------------------------
def score_totals(
    rules: RuleSet,
    pips: Sequence[int],
    kind: str,
    *,
    winner: Optional[int] = None,
    opener: int = 0,
    blocker: Optional[int] = None,
    bonus_events: Iterable[BonusEvent] = (),
    capicua: bool = False,
    chuchazo: bool = False,
) -> HandResult:
    """Score a hand from the pips left in each seat.

    ``kind`` is ``"domino"`` (``winner`` closed the hand) or ``"tranque"``
    (the winner is worked out from the counts).
    """
    if len(pips) != rules.players:
        raise ValueError(f"expected {rules.players} pip totals")
    notes: list[str] = []
    if kind == "domino":
        if winner is None:
            raise ValueError("a dominó needs the seat that closed the hand")
        if pips[winner] != 0:
            raise ValueError("the seat that closed the hand cannot hold tiles")
        mode = rules.hand_points
    elif kind == "tranque":
        winner, notes = tranque_winner(rules, pips, opener, blocker)
        mode = rules.tranque_points
    else:
        raise ValueError(f"unknown hand ending: {kind!r}")

    team_pips = _team_pips(rules, pips)
    if winner is None:
        return HandResult(
            kind="void", winner=None, winning_team=None, points=0,
            base_points=0, hand_pips=tuple(pips), team_pips=team_pips,
            next_opener=blocker if blocker is not None else opener,
            notes=tuple(notes),
        )

    team = rules.team_of(winner)
    base = _base_points(rules, pips, team, mode)
    bonuses = [(b.kind, b.points) for b in bonus_events if b.team == team]
    if kind == "domino":
        if rules.capicua_bonus and capicua:
            bonuses.append(("capicua", rules.capicua_bonus))
            notes.append("¡Capicúa!")
        if rules.chuchazo_bonus and chuchazo:
            bonuses.append(("chuchazo", rules.chuchazo_bonus))
            notes.append("¡Chuchazo!")
    return HandResult(
        kind=kind,
        winner=winner,
        winning_team=team,
        points=base + sum(p for _, p in bonuses),
        base_points=base,
        bonuses=tuple(bonuses),
        hand_pips=tuple(pips),
        team_pips=team_pips,
        next_opener=_next_opener(rules, winner, opener),
        notes=tuple(notes),
    )


def score_hand(state: HandState) -> HandResult:
    """Score a finished simulated hand.  Raises if the hand is still running."""
    if not state.is_over():
        raise ValueError("hand is not finished")
    winner = state.domino_player()
    closing = state.played[-1].tile if state.played else None
    if winner is not None:
        return score_totals(
            state.rules, state.hand_pips(), "domino",
            winner=winner, opener=state.opener, blocker=state.last_player,
            bonus_events=state.bonuses,
            capicua=is_capicua(state), chuchazo=closing == CHUCHA,
        )
    return score_totals(
        state.rules, state.hand_pips(), "tranque",
        opener=state.opener, blocker=state.last_player,
        bonus_events=state.bonuses,
    )


def points_if_blocked_now(state: HandState) -> HandResult:
    """Score the position *as if* the table were dead right now.

    The evaluation bar uses it to answer "and who wins the tranque today?"
    without touching the live state.
    """
    return score_totals(
        state.rules, state.hand_pips(), "tranque",
        opener=state.opener, blocker=state.last_player,
        bonus_events=state.bonuses,
    )
