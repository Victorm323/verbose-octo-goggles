"""Text rendering: the virtual board, the belief table and the evaluation bar."""

from __future__ import annotations

from typing import Iterable, Optional

from .evaluation import PositionEval, advantage_bar
from .inference import Beliefs
from .match import Match
from .search import MoveEval
from .table import TableView
from .tiles import SUITS

BOX_WIDTH = 74


def rule(title: str = "", width: int = BOX_WIDTH) -> str:
    if not title:
        return "─" * width
    head = f"── {title} "
    return head + "─" * max(0, width - len(head))


def render_chain(view: TableView, width: int = BOX_WIDTH) -> str:
    """The chain as it lies on the table, with the two live ends marked."""
    chain = view.chain
    if not chain:
        return "(mesa vacía)"
    cells = [f"[{a}|{b}]" for a, b in chain]
    lines: list[str] = []
    current = ""
    for cell in cells:
        if len(current) + len(cell) > width:
            lines.append(current)
            current = ""
        current += cell
    if current:
        lines.append(current)
    left, right = view.ends
    header = f"punta izquierda: {left}     punta derecha: {right}"
    return header + "\n" + "\n".join(lines)


def render_seats(view: TableView, beliefs: Optional[Beliefs] = None) -> str:
    """Seat-by-seat: tiles left, expected weight, and the numbers they lack."""
    rows = ["asiento   fichas  puntos esp.  no tiene", rule(width=48)]
    counts = view.counts()
    voids = view.voids()
    for seat in range(view.rules.players):
        pips = f"{beliefs.expected_pips(seat):5.1f}" if beliefs else "    ?"
        lacks = " ".join(str(v) for v in sorted(voids[seat])) or "-"
        mark = " (tú)" if seat == view.hero else ""
        team = view.rules.team_of(seat)
        rows.append(
            f"{view.name(seat):<7}{mark:<5}{counts[seat]:^7}{pips:^13}{lacks}"
            f"   [pareja {team}]"
        )
    hand = view.current_hand(view.hero) if view.hero is not None else None
    if hand:
        rows.append("")
        rows.append("tu mano: " + " ".join(f"[{t}]" for t in sorted(hand))
                    + f"   ({sum(t.pips for t in hand)} puntos)")
    return "\n".join(rows)


def render_beliefs(view: TableView, beliefs: Beliefs,
                   limit: Optional[int] = None) -> str:
    """Probability that each unseen tile sits in each hand."""
    seats = range(view.rules.players)
    head = "ficha  " + "".join(f"{view.name(s):>8}" for s in seats)
    rows = [head, rule(width=len(head))]
    tiles = sorted(beliefs.tiles, key=lambda t: (-t.pips, t.low))
    if limit is not None:
        tiles = tiles[:limit]
    for tile in tiles:
        cells = []
        for seat in seats:
            prob = beliefs.probability(seat, tile)
            if prob <= 0:
                cells.append(f"{'·':>8}")
            elif prob >= 0.999:
                cells.append(f"{'SÍ':>8}")
            else:
                cells.append(f"{prob:>7.0%} ")
        rows.append(f"[{tile}]  " + "".join(cells))
    rows.append("")
    rows.append("respuesta por número (probabilidad de tener el palo):")
    rows.append("       " + "".join(f"{n:>8}" for n in SUITS))
    for seat in seats:
        cells = "".join(f"{beliefs.suit_probability(seat, n):>7.0%} " for n in SUITS)
        rows.append(f"{view.name(seat):<7}" + cells)
    return "\n".join(rows)


def render_moves(evals: Iterable[MoveEval], top: int = 5) -> str:
    lines = []
    for i, ev in enumerate(list(evals)[:top]):
        tag = "*" if i == 0 else " "
        lines.append(f" {tag} {ev.describe()}")
    return "\n".join(lines) if lines else " (sin jugadas)"


def render_bar(pos: PositionEval, view: TableView) -> str:
    """The evaluation bar plus the numbers behind it."""
    team = pos.team
    label_us = f"pareja {team}"
    label_them = f"pareja {1 - team}"
    bar = advantage_bar(pos.advantage)
    arrow = "=" if abs(pos.advantage) < 0.05 else ("→" if pos.advantage > 0 else "←")
    lines = [
        f"{label_them:>12}  {bar}  {label_us:<12} {arrow}",
        f"ventaja {pos.advantage:+.2f}   puntos esperados {pos.ev_points:+.1f}"
        f"   ganamos la mano {pos.win_prob:.1%}"
        f"   ({pos.deals} repartos imaginados)",
    ]
    if pos.match_note:
        lines.append(pos.match_note)
    return "\n".join(lines)


def render_position(view: TableView, pos: PositionEval,
                    beliefs_limit: Optional[int] = 12) -> str:
    """The whole picture: board, seats, bar, candidate moves and tranque read."""
    parts = [
        rule("mesa"),
        render_chain(view),
        "",
        render_seats(view, pos.beliefs),
        "",
        rule("evaluación"),
        render_bar(pos, view),
        "",
        pos.tranque.describe(),
        "",
        rule(f"jugadas de {view.name(pos.seat_to_play)}"),
        render_moves(pos.moves),
    ]
    others = [s for s in sorted(pos.seat_moves) if s != pos.seat_to_play]
    if others:
        parts += ["", rule("qué haría cada quien (si le tocara)")]
        for seat in others:
            evals = pos.seat_moves[seat]
            best = evals[0].describe() if evals else "(nada)"
            parts.append(f" {view.name(seat):<5} {best}")
    parts += ["", rule("fichas por caer"),
              render_beliefs(view, pos.beliefs, beliefs_limit)]
    return "\n".join(parts)


def render_match(match: Match) -> str:
    lines = [match.summary()]
    for i, result in enumerate(match.results, 1):
        lines.append(f"  mano {i}: {result.describe()}")
    return "\n".join(lines)
