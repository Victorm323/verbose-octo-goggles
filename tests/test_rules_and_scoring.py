"""Rules, legality and the Dominican counting."""

import pytest

from dominord.rules import (DOMINICAN_FORMAL, DOMINICAN_PATIO, HandPoints,
                            TranqueTie, TranqueWinner, preset)
from dominord.scoring import score_totals, tranque_winner
from dominord.state import (End, HandState, IllegalMove, Pass, Play,
                            opening_seat, opening_tile)
from dominord.tiles import FULL_SET, Tile, parse_tiles, pip_total


def test_full_set_is_28_tiles_worth_168_points():
    assert len(set(FULL_SET)) == 28
    assert pip_total(FULL_SET) == 168


def test_tile_parsing_is_orientation_free():
    assert Tile.parse("6-4") == Tile.parse("4|6") == Tile(4, 6)
    assert Tile.parse("00") == Tile(0, 0)
    assert Tile.parse("6-4").other_face(6) == 4


def deal(*hands):
    return [set(parse_tiles(h)) for h in hands]


FOUR_HANDS = deal(
    "6-6 6-5 6-4 6-3 6-2 6-1 6-0",
    "5-5 5-4 5-3 5-2 5-1 5-0 4-4",
    "4-3 4-2 4-1 4-0 3-3 3-2 3-1",
    "3-0 2-2 2-1 2-0 1-1 1-0 0-0",
)


def test_double_six_opens_the_first_hand_and_must_be_played():
    assert opening_seat(FOUR_HANDS, DOMINICAN_PATIO) == 0
    assert opening_tile(DOMINICAN_PATIO, FOUR_HANDS) == Tile(6, 6)
    state = HandState.from_deal(FOUR_HANDS)
    state.force_open_tile(Tile(6, 6))
    assert state.legal_plays(0) == [Play(0, Tile(6, 6), End.RIGHT)]
    with pytest.raises(IllegalMove):
        state.apply(Play(0, Tile.of(6, 5), End.RIGHT))


def test_a_player_holding_a_legal_tile_may_not_pass():
    state = HandState.from_deal(SPREAD_HANDS)
    state.apply(Play(0, Tile(6, 6), End.RIGHT))
    assert state.can_play(1)          # P1 holds [6|5]
    with pytest.raises(IllegalMove):
        state.apply(Pass(1))


SPREAD_HANDS = deal(
    "6-6 5-5 4-4 3-3 2-2 1-1 0-0",
    "6-5 5-4 5-3 5-2 5-1 5-0 4-3",
    "6-4 4-2 4-1 4-0 3-2 3-1 3-0",
    "6-3 6-2 6-1 6-0 2-1 2-0 1-0",
)


def test_only_two_ends_ever_no_spinner():
    state = HandState.from_deal(SPREAD_HANDS)
    state.apply(Play(0, Tile(6, 6), End.RIGHT))
    state.apply(Play(1, Tile.of(6, 5), End.RIGHT))
    assert state.ends == (6, 5)
    # The double does not open a third end: the left end is still a plain 6.
    plays = {(p.tile, p.end) for p in state.legal_plays(2)}
    assert all(t.has(6) or t.has(5) for t, _ in plays)


def test_undo_restores_the_position_exactly():
    state = HandState.from_deal(FOUR_HANDS)
    before = (state.ends, state.turn, [set(h) for h in state.hands])
    undo = state.apply(Play(0, Tile(6, 6), End.RIGHT))
    state.undo(undo)
    assert (state.ends, state.turn, [set(h) for h in state.hands]) == before


# ----------------------------------------------------------------- counting
def test_domino_counts_every_remaining_tile_under_patio_rules():
    result = score_totals(DOMINICAN_PATIO, [0, 10, 7, 12], "domino", winner=0)
    assert result.winning_team == 0
    assert result.base_points == 29        # partner's tiles count too
    assert result.points == 29


def test_domino_counts_only_the_rivals_under_formal_rules():
    result = score_totals(DOMINICAN_FORMAL, [0, 10, 7, 12], "domino", winner=0)
    assert result.base_points == 22        # 10 + 12, the other pair
    assert result.points == 22


def test_capicua_and_chuchazo_pay_a_bonus_at_the_patio():
    result = score_totals(DOMINICAN_PATIO, [0, 10, 7, 12], "domino", winner=0,
                          capicua=True, chuchazo=True)
    assert dict(result.bonuses) == {"capicua": 25, "chuchazo": 25}
    assert result.points == 29 + 50
    formal = score_totals(DOMINICAN_FORMAL, [0, 10, 7, 12], "domino", winner=0,
                          capicua=True, chuchazo=True)
    assert formal.bonuses == ()


def test_tranque_goes_to_the_lightest_hand_and_counts_the_table():
    result = score_totals(DOMINICAN_PATIO, [12, 3, 9, 20], "tranque", opener=0)
    assert result.winner == 1 and result.winning_team == 1
    assert result.points == 44             # every tile on the table


def test_formal_tranque_is_decided_by_pair_totals():
    # Seat 1 is the lightest hand, but pair 0 is the lighter pair.
    pips = [4, 3, 4, 30]
    patio = score_totals(DOMINICAN_PATIO, pips, "tranque", opener=0)
    formal = score_totals(DOMINICAN_FORMAL, pips, "tranque", opener=0)
    assert patio.winning_team == 1
    assert formal.winning_team == 0
    assert formal.points == 33             # only the rivals' tiles


def test_tranque_ties_follow_the_table_rule():
    pips = [7, 7, 20, 20]
    to_opener = score_totals(DOMINICAN_PATIO, pips, "tranque", opener=1,
                             blocker=0)
    assert to_opener.winner == 1
    to_blocker = score_totals(
        DOMINICAN_PATIO.with_(tranque_tie=TranqueTie.BLOCKER), pips,
        "tranque", opener=1, blocker=0)
    assert to_blocker.winner == 0
    void = score_totals(DOMINICAN_FORMAL, [7, 7, 7, 7], "tranque", opener=0)
    assert void.kind == "void" and void.points == 0


def test_a_tie_inside_one_pair_needs_no_tiebreak():
    winner, notes = tranque_winner(DOMINICAN_PATIO, [5, 30, 5, 30], opener=1,
                                   blocker=1)
    assert winner in (0, 2) and not notes


def test_paso_corrido_is_paid_even_when_the_hand_is_lost():
    # P0 opens, the other three pass: pair 0 banks the bonus.
    hands = deal(
        "6-6 6-5 6-4 6-3 6-2 6-1 6-0",
        "5-5 5-4 5-3 5-2 5-1 5-0 4-4",
        "4-3 4-2 4-1 4-0 3-3 3-2 3-1",
        "3-0 2-2 2-1 2-0 1-1 1-0 0-0",
    )
    state = HandState.from_deal(hands)
    state.apply(Play(0, Tile(6, 6), End.RIGHT))
    for seat in (1, 2, 3):
        assert not state.legal_plays(seat)   # nobody else holds a six
        state.apply(Pass(seat))
    assert [b.kind for b in state.bonuses] == ["paso_corrido"]
    assert state.bonuses[0].team == 0
    # P0 keeps playing sixes; the bonus survives even if the hand is lost.
    state.apply(Play(0, Tile.of(6, 5), End.RIGHT))
    assert any(b.kind == "paso_corrido" for b in state.bonuses)


def test_presets_are_reachable_by_name():
    assert preset("patio").target_score == 200
    assert preset("patio100").target_score == 100
    assert preset("formal").hand_points is HandPoints.OPPONENTS_ONLY
    assert preset("formal").tranque_winner is TranqueWinner.LOWEST_TEAM_TOTAL
    with pytest.raises(ValueError):
        preset("cibaeño")
