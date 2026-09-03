"""Engine vs engine: four seats, four private views, one table.

Every seat gets its own :class:`~dominord.table.TableView` holding only what
that player can see, so a self-play game exercises exactly the same code path
as a hand reconstructed from a real table.
"""

from __future__ import annotations

import random
from dataclasses import dataclass
from typing import Callable, Optional

from .match import Match
from .rules import RuleSet, DOMINICAN_PATIO
from .scoring import HandResult, score_hand
from .search import FAST, SearchConfig, best_move
from .state import HandState, Move, Pass, deal_tiles, opening_seat, opening_tile
from .table import TableView
from .tiles import Tile

Chooser = Callable[[TableView, int], Move]


def engine_chooser(config: SearchConfig = FAST) -> Chooser:
    """Pick moves with the full evaluation stack."""

    def choose(view: TableView, seat: int) -> Move:
        best = best_move(view, seat, config)
        if best is None:
            return Pass(seat)
        return best.move

    return choose


def greedy_chooser(seed: int = 0) -> Chooser:
    """A cheap opponent: one-ply greedy on its own hand only."""
    rng = random.Random(seed)

    def choose(view: TableView, seat: int) -> Move:
        hand = view.current_hand(seat)
        if hand is None:
            raise ValueError("greedy chooser needs its own hand")
        plays = view.legal_plays(seat)
        if not plays:
            return Pass(seat)
        # Heaviest playable tile, the classic patio default.
        return max(plays, key=lambda p: (p.tile.pips, rng.random()))

    return choose


@dataclass
class HandTrace:
    """A played-out hand plus its result."""

    state: HandState
    result: HandResult
    moves: list[Move]


def play_hand(
    rules: RuleSet,
    deal: list[set[Tile]],
    opener: int,
    forced: Optional[Tile],
    choosers: list[Chooser],
) -> HandTrace:
    """Play one hand out, each seat deciding from its own private view."""
    truth = HandState.from_deal(deal, rules, opener=opener)
    truth.force_open_tile(forced)
    views = []
    for seat in range(rules.players):
        view = TableView(rules=rules, opener=opener, hero=seat,
                         forced_open_tile=forced)
        view.set_hand(seat, deal[seat])
        views.append(view)

    moves: list[Move] = []
    while not truth.is_over():
        seat = truth.turn
        move = choosers[seat](views[seat], seat)
        truth.apply(move)
        for view in views:
            view.record(move)
        moves.append(move)
    return HandTrace(truth, score_hand(truth), moves)


def play_match(
    rules: RuleSet = DOMINICAN_PATIO,
    choosers: Optional[list[Chooser]] = None,
    rng: Optional[random.Random] = None,
    max_hands: int = 40,
    on_hand: Optional[Callable[[int, HandTrace, Match], None]] = None,
) -> Match:
    """Play a full match to the target score."""
    rng = rng or random.Random()
    choosers = choosers or [engine_chooser() for _ in range(rules.players)]
    match = Match(rules=rules)
    for index in range(max_hands):
        deal = deal_tiles(rng, rules)
        if match.is_first_hand:
            opener = opening_seat(deal, rules)
            forced = opening_tile(rules, deal)
        else:
            opener = match.next_opener or 0
            forced = None
        trace = play_hand(rules, deal, opener, forced, choosers)
        match.record(trace.result)
        if on_hand is not None:
            on_hand(index, trace, match)
        if match.winner() is not None:
            break
    return match
