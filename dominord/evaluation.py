"""The evaluation bar: who is ahead, by how much, and what the tranque is worth.

Everything here is derived from one shared batch of imagined deals so that the
bar, the move list and the tranque numbers all describe the *same* position -
no two parts of the report ever disagree with each other.
"""

from __future__ import annotations

import math
from dataclasses import dataclass
from typing import Optional

from .inference import Beliefs, build_beliefs
from .match import Match
from .scoring import points_if_blocked_now
from .search import (DEFAULT, MoveEval, SearchConfig, evaluate_moves, resolve)
from .table import TableView

#: Points swing that maps to a "clearly winning" bar.  A Dominican hand is
#: usually worth 20-60 points, so ~35 is the natural full-scale value.
ADVANTAGE_SCALE = 35.0


@dataclass
class TranqueReport:
    """How the blocked-game dimension of the position looks."""

    chance: float               # P(the hand ends in a tranque at all)
    win_if_tranque: float       # P(our pair takes the count | it is blocked)
    win_if_now: float           # P(our pair takes the count if it died right now)
    pips_now: tuple[float, ...] # expected pips per seat right now
    team_pips_now: tuple[float, float]
    opportunity: Optional[MoveEval] = None   # move that best engineers a tranque
    opportunity_seat: Optional[int] = None   # whose move that is
    opportunity_is_ours: bool = True
    seat_names: tuple[str, ...] = ()
    note: str = ""

    def name(self, seat: int) -> str:
        return self.seat_names[seat] if seat < len(self.seat_names) else f"P{seat}"

    def describe(self) -> str:
        lines = [
            f"tranque: probabilidad {self.chance:5.1%}"
            f" | la ganamos {self.win_if_tranque:5.1%}"
            f" | si trancara ahora {self.win_if_now:5.1%}",
            "puntos esperados en mano: "
            + "  ".join(f"{self.name(s)} {p:4.1f}"
                        for s, p in enumerate(self.pips_now)),
        ]
        if self.opportunity is not None:
            head = ("oportunidad de tranque" if self.opportunity_is_ours
                    else f"{self.name(self.opportunity_seat or 0)} puede "
                         "trancar a su favor")
            lines.append(f"{head}: {self.opportunity.describe()}")
        if self.note:
            lines.append(self.note)
        return "\n".join(lines)


@dataclass
class PositionEval:
    """A full read of the position from one pair's point of view."""

    team: int
    seat_to_play: int
    ev_points: float
    win_prob: float
    advantage: float             # -1 (losing badly) .. +1 (winning big)
    moves: list[MoveEval]        # candidates for the seat to play
    seat_moves: dict[int, list[MoveEval]]   # best options seat by seat
    tranque: TranqueReport
    beliefs: Beliefs
    deals: int
    match_note: str = ""

    @property
    def best(self) -> Optional[MoveEval]:
        return self.moves[0] if self.moves else None


def _outlook(view: TableView, team: int, config: SearchConfig,
             deals: list[list[set]]) -> tuple[float, float, float, float, float]:
    """Expected points, win rate, tranque rate, tranque-win rate, block-now rate."""
    rng = config.rng()
    total = wins = blocked = blocked_wins = now_wins = 0.0
    n = 0
    for deal in deals:
        state = view.to_hand_state(deal)
        if state.is_over():
            continue
        n += 1
        blocked_now = points_if_blocked_now(state)
        if blocked_now.winning_team == team:
            now_wins += 1
        value, result = resolve(state, team, config, rng)
        total += value
        if result.winning_team == team:
            wins += 1
        if result.kind in ("tranque", "void"):
            blocked += 1
            if result.winning_team == team:
                blocked_wins += 1
    if not n:
        return 0.0, 0.0, 0.0, 0.0, 0.0
    tranque_win = blocked_wins / blocked if blocked else 0.0
    return total / n, wins / n, blocked / n, tranque_win, now_wins / n


def evaluate_position(
    view: TableView,
    team: Optional[int] = None,
    config: SearchConfig = DEFAULT,
    match: Optional[Match] = None,
    analyse_all_seats: bool = True,
) -> PositionEval:
    """Evaluate the live position for ``team`` (default: the hero's pair)."""
    rules = view.rules
    if team is None:
        team = rules.team_of(view.hero if view.hero is not None else view.turn)
    beliefs = build_beliefs(view)
    rng = config.rng()
    deals = [beliefs.sample_deal(rng) for _ in range(config.samples)]

    ev, win, tranque_chance, tranque_win, block_now_win = _outlook(
        view, team, config, deals)

    seat = view.turn
    moves = evaluate_moves(view, seat, config, beliefs=beliefs, deals=deals)
    seat_moves: dict[int, list[MoveEval]] = {seat: moves}
    if analyse_all_seats:
        for other in range(rules.players):
            if other == seat:
                continue
            seat_moves[other] = evaluate_moves(
                view, other, config, beliefs=beliefs, deals=deals,
                hypothetical=True)

    pips_now = tuple(beliefs.expected_pips(s) for s in range(rules.players))
    team_pips = (
        sum(p for s, p in enumerate(pips_now) if rules.team_of(s) == 0),
        sum(p for s, p in enumerate(pips_now) if rules.team_of(s) == 1),
    )
    # The move list belongs to whoever is on play, and its numbers are read
    # from *their* pair's side - so a tranque "opportunity" is only ours when
    # the seat on play is ours.
    ours_to_play = rules.team_of(seat) == team
    baseline = tranque_win if ours_to_play else 1.0 - tranque_win
    opportunity = _best_tranque_move(moves, baseline)
    report = TranqueReport(
        chance=tranque_chance,
        win_if_tranque=tranque_win,
        win_if_now=block_now_win,
        pips_now=pips_now,
        team_pips_now=team_pips,
        opportunity=opportunity,
        opportunity_seat=seat,
        opportunity_is_ours=ours_to_play,
        seat_names=tuple(view.name(s) for s in range(rules.players)),
        note=_tranque_note(view, team, block_now_win, tranque_chance),
    )

    return PositionEval(
        team=team,
        seat_to_play=seat,
        ev_points=ev,
        win_prob=win,
        advantage=math.tanh(ev / ADVANTAGE_SCALE),
        moves=moves,
        seat_moves=seat_moves,
        tranque=report,
        beliefs=beliefs,
        deals=len(deals),
        match_note=_match_note(match, team, ev) if match else "",
    )


def _best_tranque_move(moves: list[MoveEval], baseline: float) -> Optional[MoveEval]:
    """The candidate that most improves our odds of closing the table well."""
    if not moves:
        return None
    ranked = sorted(moves, key=lambda m: -m.tranque_win_prob)
    top = ranked[0]
    if top.tranque_win_prob <= 0.0:
        return None
    if top is moves[0] and top.tranque_win_prob <= baseline * 1.05:
        return None  # nothing special: the best move is simply the best move
    return top


def _tranque_note(view: TableView, team: int, block_now_win: float,
                  chance: float) -> str:
    if block_now_win >= 0.7:
        return "Mesa a favor: trancar ahora nos conviene."
    if block_now_win <= 0.3 and chance >= 0.25:
        return "Cuidado: si se tranca, la cuenta la pierden ustedes. Descárguense."
    return ""


def _match_note(match: Match, team: int, ev: float) -> str:
    need = match.rules.target_score - match.scores[team]
    rival = match.rules.target_score - match.scores[1 - team]
    parts = [f"faltan {need} para la partida (ellos {rival})"]
    if ev >= need:
        parts.append("esta mano puede cerrarla")
    return "; ".join(parts)


def advantage_bar(value: float, width: int = 40) -> str:
    """A chess-style bar: ``value`` in [-1, 1], positive means our pair."""
    value = max(-1.0, min(1.0, value))
    half = width // 2
    filled = int(round(abs(value) * half))
    left = " " * (half - filled) + "#" * filled if value < 0 else " " * half
    right = "#" * filled + " " * (half - filled) if value > 0 else " " * half
    return f"[{left}|{right}]"
