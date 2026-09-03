"""Reconstructing a physical hand on a virtual board.

:class:`TableView` is what an observer at the table actually knows: the chain,
whose turn it is, how many tiles everybody is holding, who passed on which
numbers, and the hands that were shown to them (normally their own seven).

It is deliberately *not* a :class:`~dominord.state.HandState`: the other hands
are unknown.  It can, however, produce consistent ``HandState`` determinizations
through :mod:`dominord.inference`, which is what the engine searches on.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Iterable, Optional

from .rules import RuleSet, DOMINICAN_PATIO
from .state import End, HandState, IllegalMove, Move, Pass, Play
from .tiles import FULL_SET, Tile


@dataclass
class Derived:
    """Everything that follows mechanically from the recorded moves."""

    chain: list[tuple[int, int]] = field(default_factory=list)
    left_end: Optional[int] = None
    right_end: Optional[int] = None
    turn: int = 0
    counts: list[int] = field(default_factory=list)
    played: list[Play] = field(default_factory=list)
    voids: list[set[int]] = field(default_factory=list)
    passes_in_row: int = 0
    last_player: Optional[int] = None
    pass_events: list[tuple[int, tuple[int, int]]] = field(default_factory=list)


@dataclass
class TableView:
    """A hand in progress, seen from outside the other players' hands."""

    rules: RuleSet = DOMINICAN_PATIO
    opener: int = 0
    hero: Optional[int] = None
    forced_open_tile: Optional[Tile] = None
    known_hands: dict[int, set[Tile]] = field(default_factory=dict)
    moves: list[Move] = field(default_factory=list)
    player_names: tuple[str, ...] = ("P0", "P1", "P2", "P3")
    _derived: Optional[Derived] = field(default=None, repr=False, compare=False)

    # ------------------------------------------------------------------
    # setup
    # ------------------------------------------------------------------
    def set_hand(self, seat: int, tiles: Iterable[Tile]) -> None:
        """Record a hand that is known at deal time (usually the hero's)."""
        tiles = set(tiles)
        if len(tiles) != self.rules.tiles_per_player:
            raise ValueError(
                f"a dealt hand holds {self.rules.tiles_per_player} tiles, got {len(tiles)}"
            )
        for other, hand in self.known_hands.items():
            if other != seat and hand & tiles:
                raise ValueError(
                    f"tiles {sorted(hand & tiles)} are already dealt to P{other}")
        self.known_hands[seat] = tiles
        self._derived = None

    def name(self, seat: int) -> str:
        return self.player_names[seat] if seat < len(self.player_names) else f"P{seat}"

    # ------------------------------------------------------------------
    # recording
    # ------------------------------------------------------------------
    def record(self, move: Move) -> None:
        self._validate(move)
        self.moves.append(move)
        self._derived = None

    def record_play(self, player: int, tile: Tile, end: Optional[End] = None) -> Play:
        end = self.resolve_end(tile, end)
        play = Play(player, tile, end)
        self.record(play)
        return play

    def record_pass(self, player: int) -> Pass:
        move = Pass(player)
        self.record(move)
        return move

    def undo(self) -> Optional[Move]:
        if not self.moves:
            return None
        move = self.moves.pop()
        self._derived = None
        return move

    def resolve_end(self, tile: Tile, end: Optional[End]) -> End:
        """Pick the end a tile goes on when the notation leaves it implicit."""
        d = self.derived
        if not d.chain:
            return End.RIGHT
        left_ok = tile.has(d.left_end)
        right_ok = tile.has(d.right_end)
        if end is not None:
            return end
        if left_ok and right_ok:
            if d.left_end == d.right_end:
                return End.RIGHT  # same position either way
            raise IllegalMove(
                f"[{tile}] fits both ends ({d.left_end} and {d.right_end}); "
                "say 'left' or 'right'")
        if left_ok:
            return End.LEFT
        if right_ok:
            return End.RIGHT
        raise IllegalMove(
            f"[{tile}] fits neither end ({d.left_end}, {d.right_end})")

    def _validate(self, move: Move) -> None:
        d = self.derived
        if self.is_over():
            raise IllegalMove("the hand is already finished")
        if move.player != d.turn:
            raise IllegalMove(
                f"it is {self.name(d.turn)}'s turn, not {self.name(move.player)}'s")
        if isinstance(move, Pass):
            hand = self.current_hand(move.player)
            if hand is not None and d.chain:
                playable = [t for t in hand
                            if t.has(d.left_end) or t.has(d.right_end)]
                if playable and self.rules.must_play_if_able:
                    raise IllegalMove(
                        f"{self.name(move.player)} holds a legal tile: "
                        + " ".join(f"[{t}]" for t in sorted(playable)))
            return
        tile = move.tile
        if tile in self.played_tiles():
            raise IllegalMove(f"[{tile}] is already on the table")
        hand = self.current_hand(move.player)
        if hand is not None and tile not in hand:
            raise IllegalMove(f"{self.name(move.player)} does not hold [{tile}]")
        for seat, known in self.known_hands.items():
            if seat != move.player and tile in known and tile not in self.played_tiles():
                raise IllegalMove(f"[{tile}] belongs to {self.name(seat)}")
        if not d.chain:
            if self.forced_open_tile is not None and tile != self.forced_open_tile:
                raise IllegalMove(f"the opener must lay [{self.forced_open_tile}]")
            return
        if move.end is End.LEFT and not tile.has(d.left_end):
            raise IllegalMove(f"[{tile}] does not fit the left end {d.left_end}")
        if move.end is End.RIGHT and not tile.has(d.right_end):
            raise IllegalMove(f"[{tile}] does not fit the right end {d.right_end}")
        if d.counts[move.player] == 0:
            raise IllegalMove(f"{self.name(move.player)} has no tiles left")

    # ------------------------------------------------------------------
    # derived position
    # ------------------------------------------------------------------
    @property
    def derived(self) -> Derived:
        if self._derived is None:
            self._derived = self._derive()
        return self._derived

    def _derive(self) -> Derived:
        rules = self.rules
        d = Derived(
            turn=self.opener,
            counts=[rules.tiles_per_player] * rules.players,
            voids=[set() for _ in range(rules.players)],
        )
        for move in self.moves:
            if isinstance(move, Pass):
                if d.left_end is not None and d.right_end is not None:
                    # A pass is permanent information: tiles never come back,
                    # so this seat can never hold either of those numbers.
                    d.voids[move.player].update((d.left_end, d.right_end))
                    d.pass_events.append(
                        (move.player, (d.left_end, d.right_end)))
                d.passes_in_row += 1
            else:
                tile = move.tile
                if not d.chain:
                    d.chain.append((tile.low, tile.high))
                    d.left_end, d.right_end = tile.low, tile.high
                elif move.end is End.LEFT:
                    outer = tile.other_face(d.left_end)  # type: ignore[arg-type]
                    d.chain.insert(0, (outer, d.left_end))  # type: ignore[arg-type]
                    d.left_end = outer
                else:
                    outer = tile.other_face(d.right_end)  # type: ignore[arg-type]
                    d.chain.append((d.right_end, outer))  # type: ignore[arg-type]
                    d.right_end = outer
                d.counts[move.player] -= 1
                d.played.append(move)
                d.passes_in_row = 0
                d.last_player = move.player
            d.turn = rules.next_seat(move.player)
        return d

    # convenience accessors -------------------------------------------
    @property
    def ends(self) -> tuple[Optional[int], Optional[int]]:
        return (self.derived.left_end, self.derived.right_end)

    @property
    def turn(self) -> int:
        return self.derived.turn

    @property
    def chain(self) -> list[tuple[int, int]]:
        return self.derived.chain

    def counts(self) -> list[int]:
        return self.derived.counts

    def voids(self) -> list[set[int]]:
        return self.derived.voids

    def played_tiles(self) -> set[Tile]:
        return {p.tile for p in self.derived.played}

    def current_hand(self, seat: int) -> Optional[set[Tile]]:
        """What is still in a known hand, or ``None`` if the hand is unknown."""
        if seat not in self.known_hands:
            return None
        return set(self.known_hands[seat]) - self.played_tiles()

    def unseen_tiles(self) -> set[Tile]:
        """Tiles neither on the table nor in a hand we already know."""
        seen = set(self.played_tiles())
        for seat in self.known_hands:
            hand = self.current_hand(seat)
            assert hand is not None
            seen |= hand
        return set(FULL_SET) - seen

    def unknown_seats(self) -> list[int]:
        return [s for s in range(self.rules.players) if s not in self.known_hands]

    def is_blocked(self) -> bool:
        return self.derived.passes_in_row >= self.rules.players

    def domino_player(self) -> Optional[int]:
        for seat, count in enumerate(self.counts()):
            if count == 0:
                return seat
        return None

    def is_over(self) -> bool:
        return self.domino_player() is not None or self.is_blocked()

    def legal_plays(self, seat: Optional[int] = None) -> list[Play]:
        """Legal placements for a seat whose hand we know."""
        seat = self.turn if seat is None else seat
        hand = self.current_hand(seat)
        if hand is None:
            raise ValueError(f"{self.name(seat)}'s hand is unknown")
        probe = HandState(rules=self.rules, hands=[set()] * self.rules.players)
        d = self.derived
        probe.hands = [set() for _ in range(self.rules.players)]
        probe.hands[seat] = set(hand)
        probe.chain = list(d.chain)
        probe.left_end, probe.right_end = d.left_end, d.right_end
        probe.turn = seat
        probe.force_open_tile(self.forced_open_tile if not d.chain else None)
        return probe.legal_plays(seat)

    # ------------------------------------------------------------------
    # bridging to full-information states
    # ------------------------------------------------------------------
    def initial_deal(self, current_hands: list[set[Tile]]) -> list[set[Tile]]:
        """Rebuild the four dealt hands from the tiles still held."""
        deal = [set(h) for h in current_hands]
        for play in self.derived.played:
            deal[play.player].add(play.tile)
        return deal

    def to_hand_state(self, current_hands: list[set[Tile]]) -> HandState:
        """Replay the recorded moves onto a full-information deal.

        ``current_hands`` holds what each seat is holding *now* (that is what
        :meth:`dominord.inference.Beliefs.sample_deal` produces); the dealt
        hands are rebuilt from the move history.  Replaying, rather than
        copying a position, re-checks that the deal is consistent with every
        move actually observed.
        """
        deal = self.initial_deal(current_hands)
        state = HandState.from_deal(deal, self.rules, opener=self.opener)
        state.force_open_tile(self.forced_open_tile)
        for move in self.moves:
            state.apply(move)
        return state
