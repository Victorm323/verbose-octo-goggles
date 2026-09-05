"""A reconstruction session: a real match being mirrored on the virtual board.

A session owns the running score (:class:`~dominord.match.Match`) and the hand
in progress (:class:`~dominord.table.TableView`), and knows how to save itself
to JSON so a table can be picked up again later.
"""

from __future__ import annotations

import json
from dataclasses import dataclass, field
from pathlib import Path
from typing import Iterable, Mapping, Optional, Sequence

from .match import Match
from .rules import (FirstOpener, HandPoints, NextOpener, RuleSet, TranqueTie,
                    TranqueWinner, preset)
from .scoring import HandResult, score_hand, score_totals
from .search import DEFAULT, SearchConfig
from .state import End, Move, Pass, Play
from .table import TableView
from .tiles import CHUCHA, Tile

SCHEMA_VERSION = 1
_ENUM_FIELDS = {
    "first_opener": FirstOpener,
    "next_opener": NextOpener,
    "hand_points": HandPoints,
    "tranque_points": HandPoints,
    "tranque_winner": TranqueWinner,
    "tranque_tie": TranqueTie,
}


class SessionError(RuntimeError):
    pass


@dataclass
class Session:
    """A match being reconstructed tile by tile."""

    rules: RuleSet = field(default_factory=lambda: preset("patio"))
    player_names: tuple[str, ...] = ("P0", "P1", "P2", "P3")
    hero: int = 0
    team_names: tuple[str, str] = ("Nosotros", "Ellos")
    config: SearchConfig = DEFAULT
    match: Match = field(init=False)
    view: Optional[TableView] = None

    def __post_init__(self) -> None:
        self.match = Match(rules=self.rules, team_names=self.team_names)

    # ------------------------------------------------------------------
    # hand lifecycle
    # ------------------------------------------------------------------
    def start_hand(self, hero_tiles: Iterable[Tile],
                   opener: Optional[int] = None) -> TableView:
        """Open a new hand with the hero's seven tiles.

        In the first hand of a match the opener is whoever holds the [6|6] (or
        whatever :class:`~dominord.rules.RuleSet` says), and they are obliged
        to lay it.  Later hands are opened by the previous winner with any tile.
        """
        tiles = set(hero_tiles)
        forced: Optional[Tile] = None
        if opener is None:
            # 'salida <jugador>' before the deal parks the seat here.
            opener = self.match.next_opener
        if self.match.is_first_hand:
            forced = _forced_first_tile(self.rules)
            if opener is None:
                if forced is not None and forced in tiles:
                    opener = self.hero
                else:
                    raise SessionError(
                        "say who opened: 'open <jugador>' "
                        f"(quien tenga la {forced})" if forced else
                        "say who opened the hand")
            if forced is not None and forced in tiles and opener != self.hero:
                raise SessionError(
                    f"you hold [{forced}], so the salida is yours")
        else:
            opener = self.match.next_opener if opener is None else opener
        view = TableView(
            rules=self.rules,
            opener=opener,
            hero=self.hero,
            forced_open_tile=forced,
            player_names=self.player_names,
        )
        view.set_hand(self.hero, tiles)
        self.view = view
        return view

    def require_view(self) -> TableView:
        if self.view is None:
            raise SessionError("no hand in progress - deal your tiles first")
        return self.view

    def record(self, move: Move) -> None:
        self.require_view().record(move)

    def play(self, player: int, tile: Tile, end: Optional[End] = None) -> Play:
        return self.require_view().record_play(player, tile, end)

    def passes(self, player: int) -> Pass:
        return self.require_view().record_pass(player)

    def undo(self) -> Optional[Move]:
        return self.require_view().undo()

    # ------------------------------------------------------------------
    # closing a hand
    # ------------------------------------------------------------------
    def finish_hand(
        self,
        pips: Optional[Sequence[int]] = None,
        revealed: Optional[Mapping[int, Iterable[Tile]]] = None,
    ) -> HandResult:
        """Score the finished hand and add it to the match.

        Give either the tiles the other seats were still holding (``revealed``,
        which lets the engine spot capicúa and chuchazo itself) or just the pip
        totals they announced (``pips``).
        """
        view = self.require_view()
        if not view.is_over():
            raise SessionError(
                "the hand is not over: nobody has closed and it is not blocked")
        if revealed is not None:
            result = self._score_revealed(view, revealed)
        elif pips is not None:
            result = self._score_pips(view, pips)
        else:
            raise SessionError("give the remaining tiles or the pip totals")
        self.match.record(result)
        self.view = None
        return result

    def _score_revealed(self, view: TableView,
                        revealed: Mapping[int, Iterable[Tile]]) -> HandResult:
        hands: list[set[Tile]] = []
        for seat in range(self.rules.players):
            known = view.current_hand(seat)
            if known is not None:
                hands.append(known)
            elif seat in revealed:
                hands.append(set(revealed[seat]))
            else:
                raise SessionError(f"missing the tiles left by {view.name(seat)}")
        for seat, hand in enumerate(hands):
            if len(hand) != view.counts()[seat]:
                raise SessionError(
                    f"{view.name(seat)} should have {view.counts()[seat]} tiles, "
                    f"got {len(hand)}")
        state = view.to_hand_state(hands)
        return score_hand(state)

    def _score_pips(self, view: TableView, pips: Sequence[int]) -> HandResult:
        if len(pips) != self.rules.players:
            raise SessionError(f"expected {self.rules.players} pip totals")
        d = view.derived
        winner = view.domino_player()
        closing = d.played[-1].tile if d.played else None
        if winner is not None:
            if pips[winner] != 0:
                raise SessionError(
                    f"{view.name(winner)} closed the hand and cannot hold tiles")
            return score_totals(
                self.rules, pips, "domino", winner=winner, opener=view.opener,
                blocker=d.last_player, bonus_events=_bonus_events(view),
                capicua=closed_capicua(view), chuchazo=closing == CHUCHA,
            )
        return score_totals(
            self.rules, pips, "tranque", opener=view.opener,
            blocker=d.last_player, bonus_events=_bonus_events(view),
        )

    # ------------------------------------------------------------------
    # persistence
    # ------------------------------------------------------------------
    def to_dict(self) -> dict:
        data: dict = {
            "version": SCHEMA_VERSION,
            "rules": _rules_to_dict(self.rules),
            "players": list(self.player_names),
            "team_names": list(self.team_names),
            "hero": self.hero,
            "scores": list(self.match.scores),
            "next_opener": self.match.next_opener,
            "results": [_result_to_dict(r) for r in self.match.results],
        }
        if self.view is not None:
            v = self.view
            data["hand"] = {
                "opener": v.opener,
                "forced": str(v.forced_open_tile) if v.forced_open_tile else None,
                "known": {str(s): [str(t) for t in sorted(h)]
                          for s, h in v.known_hands.items()},
                "moves": [_move_to_dict(m) for m in v.moves],
            }
        return data

    def save(self, path: str | Path) -> Path:
        path = Path(path)
        path.write_text(json.dumps(self.to_dict(), indent=2, ensure_ascii=False))
        return path

    @classmethod
    def from_dict(cls, data: Mapping) -> "Session":
        if data.get("version") != SCHEMA_VERSION:
            raise SessionError(f"unsupported session version: {data.get('version')}")
        rules = _rules_from_dict(data["rules"])
        session = cls(
            rules=rules,
            player_names=tuple(data["players"]),
            hero=int(data["hero"]),
            team_names=tuple(data.get("team_names", ("Nosotros", "Ellos"))),
        )
        session.match.scores = list(data["scores"])
        session.match.next_opener = data.get("next_opener")
        session.match.results = [_result_from_dict(r) for r in data["results"]]
        hand = data.get("hand")
        if hand:
            view = TableView(
                rules=rules,
                opener=int(hand["opener"]),
                hero=session.hero,
                forced_open_tile=Tile.parse(hand["forced"]) if hand["forced"] else None,
                player_names=session.player_names,
            )
            for seat, tiles in hand["known"].items():
                view.set_hand(int(seat), [Tile.parse(t) for t in tiles])
            for move in hand["moves"]:
                view.record(_move_from_dict(move))
            session.view = view
        return session

    @classmethod
    def load(cls, path: str | Path) -> "Session":
        return cls.from_dict(json.loads(Path(path).read_text()))


# ----------------------------------------------------------------------
# helpers
# ----------------------------------------------------------------------
def _forced_first_tile(rules: RuleSet) -> Optional[Tile]:
    if not rules.first_opener_must_play_tile:
        return None
    if rules.first_opener is FirstOpener.DOUBLE_SIX:
        return Tile(6, 6)
    return None  # highest double / heaviest tile depend on the deal


def closed_capicua(view: TableView) -> bool:
    """Did the last tile played close the hand on both ends?"""
    d = view.derived
    if view.domino_player() is None or len(d.played) < 2:
        return False
    probe = TableView(
        rules=view.rules, opener=view.opener, hero=view.hero,
        forced_open_tile=view.forced_open_tile,
        known_hands={s: set(h) for s, h in view.known_hands.items()},
        moves=list(view.moves[:-1]),
    )
    left, right = probe.ends
    last = d.played[-1].tile
    if left is None or right is None or left == right:
        return False
    return last == Tile.of(left, right)


def _bonus_events(view: TableView):
    """Paso corrido bonuses visible from the recorded move history."""
    from .state import BonusEvent

    rules = view.rules
    if not rules.paso_corrido_bonus:
        return []
    events = []
    streak = 0
    last_player: Optional[int] = None
    for move in view.moves:
        if isinstance(move, Pass):
            streak += 1
            if streak == rules.players - 1 and last_player is not None:
                events.append(BonusEvent(
                    "paso_corrido", last_player, rules.team_of(last_player),
                    rules.paso_corrido_bonus))
        else:
            streak = 0
            last_player = move.player
    return events


def _rules_to_dict(rules: RuleSet) -> dict:
    out = {}
    for key, value in vars(rules).items():
        out[key] = value.value if hasattr(value, "value") else value
    return out


def _rules_from_dict(data: Mapping) -> RuleSet:
    kwargs = dict(data)
    for key, enum in _ENUM_FIELDS.items():
        if key in kwargs:
            kwargs[key] = enum(kwargs[key])
    return RuleSet(**kwargs)


def _move_to_dict(move: Move) -> dict:
    if isinstance(move, Pass):
        return {"t": "pass", "p": move.player}
    return {"t": "play", "p": move.player, "tile": str(move.tile),
            "end": move.end.value}


def _move_from_dict(data: Mapping) -> Move:
    if data["t"] == "pass":
        return Pass(int(data["p"]))
    return Play(int(data["p"]), Tile.parse(data["tile"]), End(data["end"]))


def _result_to_dict(result: HandResult) -> dict:
    return {
        "kind": result.kind,
        "winner": result.winner,
        "winning_team": result.winning_team,
        "points": result.points,
        "base_points": result.base_points,
        "bonuses": [list(b) for b in result.bonuses],
        "hand_pips": list(result.hand_pips),
        "team_pips": list(result.team_pips),
        "next_opener": result.next_opener,
        "notes": list(result.notes),
    }


def _result_from_dict(data: Mapping) -> HandResult:
    return HandResult(
        kind=data["kind"],
        winner=data["winner"],
        winning_team=data["winning_team"],
        points=data["points"],
        base_points=data["base_points"],
        bonuses=tuple((k, p) for k, p in data["bonuses"]),
        hand_pips=tuple(data["hand_pips"]),
        team_pips=tuple(data["team_pips"]),
        next_opener=data["next_opener"],
        notes=tuple(data["notes"]),
    )
