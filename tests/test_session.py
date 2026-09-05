"""Reconstructing a real table: recording, closing hands and persistence."""

import io
import json

import pytest

from dominord.cli import Console, repl
from dominord.session import Session, SessionError
from dominord.state import IllegalMove
from dominord.tiles import Tile, parse_tiles


def new_session():
    return Session(player_names=("Yo", "Juan", "Socio", "Pedro"), hero=0)


def test_the_hand_with_the_double_six_opens_the_match():
    session = new_session()
    view = session.start_hand(parse_tiles("6-6 5-5 3-1 0-0 2-6 4-4 5-0"))
    assert view.opener == 0
    assert view.forced_open_tile == Tile(6, 6)
    with pytest.raises(IllegalMove):
        session.play(0, Tile(5, 5))       # must open with the double six


def test_without_the_double_six_the_session_asks_who_opened():
    session = new_session()
    with pytest.raises(SessionError):
        session.start_hand(parse_tiles("5-5 3-1 0-0 2-6 4-4 5-0 6-4"))
    view = session.start_hand(parse_tiles("5-5 3-1 0-0 2-6 4-4 5-0 6-4"),
                              opener=2)
    assert view.opener == 2 and view.turn == 2


def test_recording_rejects_impossible_moves():
    session = new_session()
    session.start_hand(parse_tiles("6-6 5-5 3-1 0-0 2-6 4-4 5-0"))
    session.play(0, Tile(6, 6))
    with pytest.raises(IllegalMove):
        session.play(0, Tile.of(6, 5))            # not P0's turn
    session.play(1, Tile.of(6, 5))
    with pytest.raises(IllegalMove):
        session.play(2, Tile.of(6, 5))            # already on the table
    with pytest.raises(IllegalMove):
        session.play(2, Tile.of(4, 3))            # fits neither end
    session.play(2, Tile.of(5, 4))
    with pytest.raises(IllegalMove):
        session.play(3, Tile.of(2, 6))            # that one is ours


def test_undo_walks_the_hand_back():
    session = new_session()
    session.start_hand(parse_tiles("6-6 5-5 3-1 0-0 2-6 4-4 5-0"))
    session.play(0, Tile(6, 6))
    session.play(1, Tile.of(6, 5))
    session.undo()
    assert session.view.ends == (6, 6)
    assert session.view.counts() == [6, 7, 7, 7]


def replayed_session(seed: int):
    """Reconstruct a real (self-played) hand move by move, as a person would."""
    import random

    from dominord.rules import DOMINICAN_PATIO
    from dominord.selfplay import greedy_chooser, play_hand
    from dominord.state import deal_tiles, opening_seat, opening_tile

    rng = random.Random(seed)
    deal = deal_tiles(rng, DOMINICAN_PATIO)
    opener = opening_seat(deal, DOMINICAN_PATIO)
    trace = play_hand(DOMINICAN_PATIO, deal, opener,
                      opening_tile(DOMINICAN_PATIO, deal),
                      [greedy_chooser(seed + i) for i in range(4)])
    session = new_session()
    session.start_hand(deal[0], opener=opener)
    for move in trace.moves:
        session.record(move)
    return session, trace


@pytest.mark.parametrize("seed", [1, 2, 3, 4, 5, 6])
def test_a_reconstructed_hand_scores_exactly_like_the_real_one(seed):
    session, trace = replayed_session(seed)
    view = session.view
    assert view.is_over()
    assert view.counts() == [len(h) for h in trace.state.hands]
    by_pips = session.finish_hand(pips=trace.state.hand_pips())
    assert (by_pips.kind, by_pips.winner, by_pips.points) == (
        trace.result.kind, trace.result.winner, trace.result.points)
    assert by_pips.bonuses == trace.result.bonuses
    assert session.match.scores[by_pips.winning_team] == by_pips.points


@pytest.mark.parametrize("seed", [7, 8, 9])
def test_revealed_tiles_close_the_hand_the_same_way(seed):
    session, trace = replayed_session(seed)
    revealed = {seat: set(trace.state.hands[seat]) for seat in (1, 2, 3)}
    result = session.finish_hand(revealed=revealed)
    assert (result.kind, result.winner, result.points) == (
        trace.result.kind, trace.result.winner, trace.result.points)
    assert result.bonuses == trace.result.bonuses


def test_closing_needs_the_missing_hands():
    session, trace = replayed_session(3)
    with pytest.raises(SessionError):
        session.finish_hand()
    with pytest.raises(SessionError):
        session.finish_hand(revealed={1: set(trace.state.hands[1])})


def test_session_survives_a_json_round_trip(tmp_path):
    session = new_session()
    session.start_hand(parse_tiles("6-6 5-5 3-1 0-0 2-6 4-4 5-0"))
    session.play(0, Tile(6, 6))
    session.play(1, Tile.of(6, 1))
    session.passes(2)
    path = session.save(tmp_path / "mesa.json")
    twin = Session.load(path)
    assert twin.view.ends == session.view.ends
    assert twin.view.counts() == session.view.counts()
    assert twin.view.voids() == session.view.voids()
    assert twin.player_names == session.player_names
    assert json.loads(path.read_text())["version"] == 1


def run_console(script: str) -> str:
    out = io.StringIO()
    console = Console(session=new_session())
    console.out = out
    repl(console, io.StringIO(script))
    return out.getvalue()


def test_console_walks_through_a_hand():
    text = run_console(
        "nombres Yo Juan Socio Pedro\n"
        "mano 6-6 5-5 3-1 0-0 2-6 4-4 5-0\n"
        "juega yo 6-6\n"
        "juan 6-1\n"
        "paso socio\n"
        "mesa\n"
        "barra\n"
        "sugerencia juan\n"
    )
    assert "sale Yo" in text
    assert "Juan juega [1|6]" in text
    assert "Socio pasa" in text
    assert "punta izquierda" in text
    assert "ventaja" in text
    assert "jugadas de Juan" in text


def test_console_reports_mistakes_without_dying():
    text = run_console(
        "mano 6-6 5-5 3-1 0-0 2-6 4-4 5-0\n"
        "juega P1 6-6\n"          # not their turn, and not their tile
        "chachacha\n"
        "puntos\n"
    )
    assert "⚠" in text
    assert "comando desconocido" in text
    assert "Nosotros 0 - 0 Ellos" in text


def test_salida_can_be_named_before_the_deal():
    """At a live table you often deal, look at your hand, and only then say
    who opened - and it may not be you."""
    session = new_session()
    session.match.next_opener = 2          # what 'salida socio' records
    view = session.start_hand(parse_tiles("5-5 3-1 0-0 2-6 4-4 5-0 6-4"))
    assert view.opener == 2 and view.turn == 2


def test_console_accepts_salida_before_mano():
    text = run_console(
        "nombres Yo Juan Socio Pedro\n"
        "salida socio\n"
        "mano 5-5 3-1 0-0 2-6 4-4 5-0 6-4\n"
        "socio 6-6\n"
    )
    assert "⚠" not in text
    assert "sale Socio" in text
    assert "Socio juega [6|6]" in text
