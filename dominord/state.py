"""The board, the moves and the state of a single hand (``mano``).

:class:`HandState` is a *perfect information* state: it knows every hand.  It
is what the search engine simulates on.  What an observer of a physical game
actually knows lives in :mod:`dominord.table`, which produces ``HandState``
determinizations through :mod:`dominord.inference`.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from enum import Enum
from typing import Iterable, Optional, Sequence

from .rules import FirstOpener, RuleSet, DOMINICAN_PATIO
from .tiles import FULL_SET, Tile, pip_total


class End(str, Enum):
    LEFT = "left"
    RIGHT = "right"

    @property
    def other(self) -> "End":
        return End.RIGHT if self is End.LEFT else End.LEFT


@dataclass(frozen=True)
class Play:
    """A tile laid on one end of the chain (``end`` is ignored for la salida)."""

    player: int
    tile: Tile
    end: End = End.RIGHT

    def __str__(self) -> str:
        return f"P{self.player} plays [{self.tile}] {self.end.value}"


@dataclass(frozen=True)
class Pass:
    """``paso``: the player had nothing for either end."""

    player: int

    def __str__(self) -> str:
        return f"P{self.player} passes"


Move = Play | Pass


@dataclass(frozen=True)
class BonusEvent:
    """A bonus earned while the hand is still running (e.g. paso corrido)."""

    kind: str
    player: int
    team: int
    points: int


@dataclass
class _Undo:
    move: Move
    prev_left: Optional[int]
    prev_right: Optional[int]
    prev_turn: int
    prev_passes_in_row: int
    prev_last_player: Optional[int]
    added_bonus: bool


class IllegalMove(ValueError):
    """Raised when a move contradicts the rules or the recorded position."""


@dataclass
class HandState:
    """One hand of dominoes with full knowledge of the four hands."""

    rules: RuleSet = DOMINICAN_PATIO
    hands: list[set[Tile]] = field(default_factory=list)
    opener: int = 0
    turn: int = 0
    chain: list[tuple[int, int]] = field(default_factory=list)  # oriented faces
    played: list[Play] = field(default_factory=list)
    log: list[Move] = field(default_factory=list)
    left_end: Optional[int] = None
    right_end: Optional[int] = None
    passes_in_row: int = 0
    last_player: Optional[int] = None
    pass_events: list[tuple[int, tuple[int, int]]] = field(default_factory=list)
    bonuses: list[BonusEvent] = field(default_factory=list)

    # ------------------------------------------------------------------
    # construction
    # ------------------------------------------------------------------
    @classmethod
    def from_deal(
        cls,
        deal: Sequence[Iterable[Tile]],
        rules: RuleSet = DOMINICAN_PATIO,
        opener: Optional[int] = None,
    ) -> "HandState":
        hands = [set(h) for h in deal]
        if len(hands) != rules.players:
            raise ValueError(f"expected {rules.players} hands, got {len(hands)}")
        seen: set[Tile] = set()
        for hand in hands:
            if len(hand) != rules.tiles_per_player:
                raise ValueError("every hand must hold exactly "
                                 f"{rules.tiles_per_player} tiles")
            if seen & hand:
                raise ValueError(f"duplicate tiles in deal: {sorted(seen & hand)}")
            seen |= hand
        if opener is None:
            opener = opening_seat(hands, rules)
        return cls(rules=rules, hands=hands, opener=opener, turn=opener)

    def copy(self) -> "HandState":
        return HandState(
            rules=self.rules,
            hands=[set(h) for h in self.hands],
            opener=self.opener,
            turn=self.turn,
            chain=list(self.chain),
            played=list(self.played),
            log=list(self.log),
            left_end=self.left_end,
            right_end=self.right_end,
            passes_in_row=self.passes_in_row,
            last_player=self.last_player,
            pass_events=list(self.pass_events),
            bonuses=list(self.bonuses),
            _forced_open_tile=self._forced_open_tile,
        )

    # ------------------------------------------------------------------
    # position queries
    # ------------------------------------------------------------------
    @property
    def started(self) -> bool:
        return bool(self.chain)

    @property
    def ends(self) -> tuple[Optional[int], Optional[int]]:
        return (self.left_end, self.right_end)

    @property
    def tiles_left(self) -> int:
        return sum(len(h) for h in self.hands)

    def hand_pips(self) -> tuple[int, ...]:
        return tuple(pip_total(h) for h in self.hands)

    def team_pips(self) -> tuple[int, int]:
        pips = self.hand_pips()
        return (
            sum(p for s, p in enumerate(pips) if self.rules.team_of(s) == 0),
            sum(p for s, p in enumerate(pips) if self.rules.team_of(s) == 1),
        )

    def played_tiles(self) -> list[Tile]:
        return [p.tile for p in self.played]

    def can_play(self, player: int) -> bool:
        return bool(self.legal_plays(player))

    def legal_plays(self, player: int) -> list[Play]:
        """Legal tile placements, with symmetric duplicates removed."""
        hand = self.hands[player]
        if not self.started:
            if self.first_move_forced() is not None:
                forced = self.first_move_forced()
                return [Play(player, forced, End.RIGHT)] if forced in hand else []
            return [Play(player, t, End.RIGHT) for t in sorted(hand)]
        out: list[Play] = []
        for tile in sorted(hand):
            left_ok = tile.has(self.left_end)  # type: ignore[arg-type]
            right_ok = tile.has(self.right_end)  # type: ignore[arg-type]
            if left_ok:
                out.append(Play(player, tile, End.LEFT))
            # Both ends showing the same number produce the same position.
            if right_ok and not (left_ok and self.left_end == self.right_end):
                out.append(Play(player, tile, End.RIGHT))
        return out

    def first_move_forced(self) -> Optional[Tile]:
        """The tile the opener is obliged to lay, if the rules force one."""
        if self.started or not self.rules.first_opener_must_play_tile:
            return None
        # Only the very first hand of a match is forced; later hands are opened
        # by the previous winner with any tile.  A forced opener is modelled by
        # HandState only when the deal says so, via ``forced_open_tile``.
        return self._forced_open_tile

    _forced_open_tile: Optional[Tile] = None

    def force_open_tile(self, tile: Optional[Tile]) -> None:
        self._forced_open_tile = tile

    def legal_moves(self, player: Optional[int] = None) -> list[Move]:
        player = self.turn if player is None else player
        plays = self.legal_plays(player)
        if plays:
            return list(plays)
        return [Pass(player)]

    # ------------------------------------------------------------------
    # mutation
    # ------------------------------------------------------------------
    def apply(self, move: Move) -> _Undo:
        if self.is_over():
            raise IllegalMove("the hand is already finished")
        if move.player != self.turn:
            raise IllegalMove(
                f"it is P{self.turn}'s turn, not P{move.player}'s")
        undo = _Undo(
            move=move,
            prev_left=self.left_end,
            prev_right=self.right_end,
            prev_turn=self.turn,
            prev_passes_in_row=self.passes_in_row,
            prev_last_player=self.last_player,
            added_bonus=False,
        )
        if isinstance(move, Pass):
            if self.rules.must_play_if_able and self.can_play(move.player):
                raise IllegalMove(
                    f"P{move.player} must play: {self.legal_plays(move.player)}")
            self.pass_events.append(
                (move.player, (self.left_end or -1, self.right_end or -1))
            )
            self.passes_in_row += 1
            self.log.append(move)
            # Paso corrido: the other three passed on the back of one play.
            if (
                self.rules.paso_corrido_bonus
                and self.passes_in_row == self.rules.players - 1
                and self.last_player is not None
            ):
                self.bonuses.append(
                    BonusEvent(
                        "paso_corrido",
                        self.last_player,
                        self.rules.team_of(self.last_player),
                        self.rules.paso_corrido_bonus,
                    )
                )
                undo.added_bonus = True
        else:
            self._apply_play(move)
            self.passes_in_row = 0
            self.last_player = move.player
        self.turn = self.rules.next_seat(self.turn)
        return undo

    def _apply_play(self, move: Play) -> None:
        tile = move.tile
        if tile not in self.hands[move.player]:
            raise IllegalMove(f"P{move.player} does not hold [{tile}]")
        if not self.started:
            forced = self.first_move_forced()
            if forced is not None and tile != forced:
                raise IllegalMove(f"the opener must lay [{forced}]")
            self.chain.append((tile.low, tile.high))
            self.left_end, self.right_end = tile.low, tile.high
        elif move.end is End.LEFT:
            if not tile.has(self.left_end):  # type: ignore[arg-type]
                raise IllegalMove(f"[{tile}] does not fit the left end {self.left_end}")
            outer = tile.other_face(self.left_end)  # type: ignore[arg-type]
            self.chain.insert(0, (outer, self.left_end))  # type: ignore[arg-type]
            self.left_end = outer
        else:
            if not tile.has(self.right_end):  # type: ignore[arg-type]
                raise IllegalMove(
                    f"[{tile}] does not fit the right end {self.right_end}")
            outer = tile.other_face(self.right_end)  # type: ignore[arg-type]
            self.chain.append((self.right_end, outer))  # type: ignore[arg-type]
            self.right_end = outer
        self.hands[move.player].discard(tile)
        self.played.append(move)
        self.log.append(move)

    def undo(self, undo: _Undo) -> None:
        move = undo.move
        self.log.pop()
        if isinstance(move, Pass):
            self.pass_events.pop()
            if undo.added_bonus:
                self.bonuses.pop()
        else:
            self.played.pop()
            self.hands[move.player].add(move.tile)
            if not self.played:
                self.chain.clear()
            elif move.end is End.LEFT and undo.prev_left is not None:
                self.chain.pop(0)
            else:
                self.chain.pop()
        self.left_end = undo.prev_left
        self.right_end = undo.prev_right
        self.turn = undo.prev_turn
        self.passes_in_row = undo.prev_passes_in_row
        self.last_player = undo.prev_last_player

    # ------------------------------------------------------------------
    # termination
    # ------------------------------------------------------------------
    def domino_player(self) -> Optional[int]:
        for seat, hand in enumerate(self.hands):
            if not hand:
                return seat
        return None

    def is_blocked(self) -> bool:
        return self.passes_in_row >= self.rules.players

    def is_over(self) -> bool:
        return self.domino_player() is not None or self.is_blocked()

    def winning_tile_context(self) -> Optional[tuple[Play, int, int]]:
        """The closing play plus the two ends it faced, for capicúa checks."""
        if self.domino_player() is None or not self.played:
            return None
        last = self.played[-1]
        # Reconstruct the ends immediately before the closing tile.
        if len(self.chain) == 1:
            return None
        if last.end is End.LEFT:
            left_before = self.chain[1][0]
            right_before = self.right_end
        else:
            left_before = self.left_end
            right_before = self.chain[-2][1]
        return last, left_before, right_before  # type: ignore[return-value]


def opening_seat(hands: Sequence[Iterable[Tile]], rules: RuleSet) -> int:
    """The seat that opens the first hand of a match, per the rules."""
    sets = [set(h) for h in hands]
    if rules.first_opener is FirstOpener.DOUBLE_SIX:
        target = Tile(6, 6)
        for seat, hand in enumerate(sets):
            if target in hand:
                return seat
        raise ValueError("[6|6] was not dealt")
    if rules.first_opener is FirstOpener.HIGHEST_DOUBLE:
        for pips in range(6, -1, -1):
            target = Tile(pips, pips)
            for seat, hand in enumerate(sets):
                if target in hand:
                    return seat
        raise ValueError("no double was dealt")
    best_seat, best_tile = 0, None
    for seat, hand in enumerate(sets):
        top = max(hand, key=lambda t: (t.pips, t.is_double, t.high))
        if best_tile is None or (top.pips, top.is_double, top.high) > (
            best_tile.pips, best_tile.is_double, best_tile.high
        ):
            best_seat, best_tile = seat, top
    return best_seat


def opening_tile(rules: RuleSet, hands: Sequence[Iterable[Tile]]) -> Optional[Tile]:
    """The tile the first opener is obliged to lay, if any."""
    if not rules.first_opener_must_play_tile:
        return None
    seat = opening_seat(hands, rules)
    hand = set(hands[seat])
    if rules.first_opener is FirstOpener.DOUBLE_SIX:
        return Tile(6, 6)
    if rules.first_opener is FirstOpener.HIGHEST_DOUBLE:
        for pips in range(6, -1, -1):
            if Tile(pips, pips) in hand:
                return Tile(pips, pips)
        return None
    return max(hand, key=lambda t: (t.pips, t.is_double, t.high))


def deal_tiles(rng, rules: RuleSet = DOMINICAN_PATIO) -> list[set[Tile]]:
    """Shuffle the 28 tiles and deal seven to each seat."""
    tiles = list(FULL_SET)
    rng.shuffle(tiles)
    n = rules.tiles_per_player
    return [set(tiles[i * n:(i + 1) * n]) for i in range(rules.players)]
