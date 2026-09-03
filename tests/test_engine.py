"""Search, evaluation bar and tranque reading."""


import pytest

from dominord.evaluation import advantage_bar, evaluate_position
from dominord.rules import DOMINICAN_PATIO
from dominord.search import (FAST, evaluate_moves, solve,
                             static_eval)
from dominord.state import HandState, Play
from dominord.table import TableView
from dominord.tiles import Tile, parse_tiles


def endgame(hands, left, right, turn=0, chain=None):
    state = HandState(rules=DOMINICAN_PATIO,
                      hands=[set(parse_tiles(h)) for h in hands],
                      opener=0, turn=turn)
    state.chain = chain or [(left, 3), (3, right)]
    state.left_end, state.right_end = left, right
    state.played = [Play(0, Tile.of(left, 3)), Play(0, Tile.of(3, right))]
    return state


def test_solver_finds_the_immediate_win_and_scores_the_capicua():
    state = endgame(["1-2"], left=1, right=2)
    state.hands = [set(parse_tiles("1-2")), set(parse_tiles("0-5")),
                   set(parse_tiles("6-6")), set(parse_tiles("4-4"))]
    value, result = solve(state, team=0)
    assert result.kind == "domino" and result.winner == 0
    # 5 + 12 + 8 on the table, plus the capicúa bonus for closing both ends.
    assert result.base_points == 25
    assert result.is_capicua
    assert value == 25 + DOMINICAN_PATIO.capicua_bonus


def test_solver_reads_a_tranque_the_light_hand_wins():
    # Ends are 1 and 0; only P0 can move, and whatever it plays kills the table.
    state = HandState(
        rules=DOMINICAN_PATIO,
        hands=[set(parse_tiles("0-1 2-2")), set(parse_tiles("5-5 4-4")),
               set(parse_tiles("6-6 3-3")), set(parse_tiles("5-4 6-3"))],
        opener=0, turn=0)
    state.chain = [(1, 6), (6, 0)]
    state.left_end, state.right_end = 1, 0
    state.played = [Play(0, Tile.of(1, 6)), Play(0, Tile.of(6, 0))]
    value, result = solve(state, team=0)
    assert result.kind == "tranque"
    assert result.winner == 0                 # 4 pips against 18 apiece
    assert result.base_points == 4 + 18 + 18 + 18
    assert dict(result.bonuses) == {"paso_corrido": 25}   # the three passes
    assert value == 58 + 25


def test_evaluate_moves_covers_exactly_the_legal_plays():
    view = TableView(opener=0, hero=0, forced_open_tile=Tile(6, 6))
    view.set_hand(0, parse_tiles("6-6 6-5 5-5 4-4 3-3 2-2 1-1"))
    view.record_play(0, Tile(6, 6))
    view.record_play(1, Tile.of(6, 4))
    view.record_play(2, Tile.of(4, 3))
    view.record_play(3, Tile.of(3, 1))
    evals = evaluate_moves(view, 0, FAST)
    legal = {(p.tile, p.end) for p in view.legal_plays(0)}
    assert {(e.move.tile, e.move.end) for e in evals} == legal
    for ev in evals:
        assert 0.0 <= ev.win_prob <= 1.0
        assert 0.0 <= ev.tranque_prob <= 1.0
        assert ev.tranque_win_prob <= ev.tranque_prob + 1e-9


def test_evaluation_is_zero_sum_between_the_pairs():
    view = TableView(opener=0, hero=0, forced_open_tile=Tile(6, 6))
    view.set_hand(0, parse_tiles("6-6 6-5 5-5 4-4 3-3 2-2 1-1"))
    view.record_play(0, Tile(6, 6))
    view.record_play(1, Tile.of(6, 4))
    ours = evaluate_position(view, team=0, config=FAST, analyse_all_seats=False)
    theirs = evaluate_position(view, team=1, config=FAST, analyse_all_seats=False)
    assert ours.ev_points == pytest.approx(-theirs.ev_points, abs=1e-6)
    assert ours.advantage == pytest.approx(-theirs.advantage, abs=1e-6)


def test_unknown_seats_are_predicted_rather_than_advised():
    view = TableView(opener=0, hero=0, forced_open_tile=Tile(6, 6))
    view.set_hand(0, parse_tiles("6-6 6-5 5-5 4-4 3-3 2-2 1-1"))
    view.record_play(0, Tile(6, 6))
    evals = evaluate_moves(view, 1, FAST)
    assert evals and evals[0].label == "jugada más probable"
    assert all(0.0 <= e.availability <= 1.0 for e in evals)
    assert sum(e.choice_prob for e in evals) == pytest.approx(1.0, abs=0.02)


def test_tranque_report_knows_who_wins_the_count_today():
    view = TableView(opener=0, hero=0, forced_open_tile=Tile(6, 6))
    # A very light hero hand: if the table died now, we would take the count.
    view.set_hand(0, parse_tiles("6-6 0-1 0-2 0-3 1-2 1-0 2-0"[:0] or
                                 "6-6 0-1 0-2 0-3 1-2 2-2 1-1"))
    view.record_play(0, Tile(6, 6))
    pos = evaluate_position(view, config=FAST, analyse_all_seats=False)
    assert pos.tranque.win_if_now > 0.8
    assert 0.0 <= pos.tranque.chance <= 1.0
    assert pos.tranque.pips_now[0] == pytest.approx(
        sum(t.pips for t in view.current_hand(0)))


def test_advantage_bar_is_symmetric_and_bounded():
    assert advantage_bar(0.0).count("#") == 0
    assert advantage_bar(1.0).count("#") == advantage_bar(-1.0).count("#")
    assert advantage_bar(5.0) == advantage_bar(1.0)


def test_static_eval_prefers_holding_fewer_and_lighter_tiles():
    heavy = HandState(rules=DOMINICAN_PATIO,
                      hands=[set(parse_tiles("6-6 6-5")), set(parse_tiles("0-1")),
                             set(parse_tiles("0-2")), set(parse_tiles("0-3"))],
                      opener=0, turn=0)
    heavy.left_end, heavy.right_end = 0, 0
    heavy.chain = [(0, 0)]
    assert static_eval(heavy, 0) < static_eval(heavy, 1)
