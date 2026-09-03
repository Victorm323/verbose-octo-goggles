"""Belief tracking: hard deductions, exact marginals and consistent sampling."""

import itertools
import random

import pytest

from dominord.inference import InconsistentObservations, build_beliefs
from dominord.table import TableView
from dominord.tiles import Tile, parse_tiles


def opening_view(hero_hand: str, opener: int = 0) -> TableView:
    view = TableView(opener=opener, hero=0, forced_open_tile=Tile(6, 6))
    view.set_hand(0, parse_tiles(hero_hand))
    return view


def brute_force_counts(view: TableView):
    """Enumerate every consistent deal the slow, obviously-correct way."""
    unseen = sorted(view.unseen_tiles())
    seats = view.unknown_seats()
    counts = view.counts()
    voids = view.voids()
    total = 0
    holds = {(s, t): 0 for s in seats for t in unseen}
    for assignment in itertools.product(seats, repeat=len(unseen)):
        per_seat = {s: [] for s in seats}
        for tile, seat in zip(unseen, assignment):
            per_seat[seat].append(tile)
        if any(len(per_seat[s]) != counts[s] for s in seats):
            continue
        if any(t.low in voids[s] or t.high in voids[s]
               for s in seats for t in per_seat[s]):
            continue
        total += 1
        for seat, tiles in per_seat.items():
            for tile in tiles:
                holds[(seat, tile)] += 1
    return total, holds


def replay_prefix(max_unseen: int = 11) -> TableView:
    """A real (self-played) hand, replayed for seat 0 until few tiles are left."""
    from dominord.selfplay import greedy_chooser, play_hand
    from dominord.rules import DOMINICAN_PATIO
    from dominord.state import deal_tiles, opening_seat, opening_tile

    rng = random.Random(12)
    deal = deal_tiles(rng, DOMINICAN_PATIO)
    opener = opening_seat(deal, DOMINICAN_PATIO)
    trace = play_hand(DOMINICAN_PATIO, deal, opener,
                      opening_tile(DOMINICAN_PATIO, deal),
                      [greedy_chooser(i) for i in range(4)])
    view = TableView(opener=opener, hero=0,
                     forced_open_tile=opening_tile(DOMINICAN_PATIO, deal))
    view.set_hand(0, deal[0])
    for move in trace.moves:
        if len(view.unseen_tiles()) <= max_unseen or view.is_over():
            break
        view.record(move)
    return view


def test_marginals_match_brute_force_on_a_real_position():
    view = replay_prefix()
    beliefs = build_beliefs(view)
    assert 0 < len(beliefs.tiles) <= 12
    total, holds = brute_force_counts(view)
    assert total == beliefs.total_deals
    for (seat, tile), count in holds.items():
        assert beliefs.probability(seat, tile) == pytest.approx(count / total)


def test_a_pass_rules_out_both_numbers_forever():
    view = opening_view("6-6 5-5 4-4 3-3 2-2 1-1 0-0")
    view.record_play(0, Tile(6, 6))
    view.record_play(1, Tile.of(6, 4))
    view.record_play(2, Tile.of(4, 2))
    view.record_pass(3)                 # ends are 6 and 2
    beliefs = build_beliefs(view)
    assert view.voids()[3] == {6, 2}
    for tile in beliefs.tiles:
        if tile.has(6) or tile.has(2):
            assert beliefs.probability(3, tile) == 0.0
    assert beliefs.suit_probability(3, 6) == 0.0
    assert beliefs.suit_probability(3, 2) == 0.0


def test_probabilities_sum_to_one_over_the_seats():
    view = opening_view("6-6 6-5 4-4 3-3 2-2 1-1 0-0")
    view.record_play(0, Tile(6, 6))
    view.record_play(1, Tile.of(6, 3))
    view.record_pass(2)
    beliefs = build_beliefs(view)
    for tile in beliefs.tiles:
        total = sum(beliefs.probability(s, tile) for s in range(4))
        assert total == pytest.approx(1.0)


def test_sampled_deals_respect_every_deduction():
    view = opening_view("6-6 6-5 4-4 3-3 2-2 1-1 0-0")
    view.record_play(0, Tile(6, 6))
    view.record_play(1, Tile.of(6, 3))
    view.record_pass(2)
    view.record_play(3, Tile.of(3, 5))
    beliefs = build_beliefs(view)
    rng = random.Random(4)
    counts = view.counts()
    voids = view.voids()
    seen = set()
    for _ in range(50):
        deal = beliefs.sample_deal(rng)
        assert [len(h) for h in deal] == counts
        assert set().union(*deal) & view.played_tiles() == set()
        assert sum(len(h) for h in deal) + len(view.played_tiles()) == 28
        for seat, hand in enumerate(deal):
            for tile in hand:
                assert not (tile.low in voids[seat] or tile.high in voids[seat])
        seen.add(frozenset(deal[1]))
    assert len(seen) > 1                # the sampler actually varies


def test_expected_pips_of_a_known_hand_are_exact():
    view = opening_view("6-6 6-5 4-4 3-3 2-2 1-1 0-0")
    assert build_beliefs(view).expected_pips(0) == pytest.approx(12 + 11 + 8 + 6 + 4 + 2)


def test_impossible_observations_are_reported():
    view = opening_view("6-6 6-5 6-4 6-3 6-2 6-1 6-0")
    view.record_play(0, Tile(6, 6))
    for seat in (1, 2, 3):
        view.record_pass(seat)
    # Hand-craft a contradiction: everybody is void in every number.
    for suit in range(7):
        view.derived.voids[1].add(suit)
    with pytest.raises(InconsistentObservations):
        build_beliefs(view)
