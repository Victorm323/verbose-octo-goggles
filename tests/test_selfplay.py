"""Whole-game plumbing: the engine playing itself with four private views."""

import random

from dominord.rules import DOMINICAN_FORMAL, DOMINICAN_PATIO
from dominord.search import FAST
from dominord.selfplay import engine_chooser, greedy_chooser, play_hand, play_match
from dominord.state import deal_tiles, opening_seat, opening_tile
from dominord.tiles import FULL_SET


def test_every_tile_is_accounted_for_at_the_end_of_a_hand():
    rng = random.Random(21)
    deal = deal_tiles(rng)
    trace = play_hand(DOMINICAN_PATIO, deal, opening_seat(deal, DOMINICAN_PATIO),
                      opening_tile(DOMINICAN_PATIO, deal),
                      [greedy_chooser(i) for i in range(4)])
    on_table = trace.state.played_tiles()
    in_hands = [t for hand in trace.state.hands for t in hand]
    assert len(on_table) + len(in_hands) == 28
    assert set(on_table) | set(in_hands) == set(FULL_SET)
    assert sum(trace.result.hand_pips) == sum(t.pips for t in in_hands)


def test_a_match_runs_to_the_target_score():
    match = play_match(rng=random.Random(3),
                       choosers=[greedy_chooser(i) for i in range(4)])
    assert match.winner() is not None
    assert max(match.scores) >= match.rules.target_score
    totals = [0, 0]
    for result in match.results:
        if result.winning_team is not None:
            totals[result.winning_team] += result.points
    assert totals == match.scores


def test_the_engine_can_drive_a_hand_from_private_views_only():
    rng = random.Random(9)
    deal = deal_tiles(rng)
    trace = play_hand(DOMINICAN_PATIO, deal, opening_seat(deal, DOMINICAN_PATIO),
                      opening_tile(DOMINICAN_PATIO, deal),
                      [engine_chooser(FAST) for _ in range(4)])
    assert trace.state.is_over()
    assert trace.result.kind in ("domino", "tranque", "void")


def test_formal_rules_play_through_as_well():
    match = play_match(rules=DOMINICAN_FORMAL, rng=random.Random(2),
                       choosers=[greedy_chooser(i) for i in range(4)])
    assert match.winner() is not None
    assert all(r.kind in ("domino", "tranque", "void") for r in match.results)
