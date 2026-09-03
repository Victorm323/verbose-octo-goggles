"""Tiles of the double-six set used in Dominican domino."""

from __future__ import annotations

from dataclasses import dataclass
from typing import Iterable, Iterator

MAX_PIP = 6
SUITS = tuple(range(MAX_PIP + 1))


@dataclass(frozen=True, order=True)
class Tile:
    """A domino, stored canonically with ``low <= high``.

    Orientation on the table is not a property of the tile; the board keeps
    track of which face is exposed at each end.
    """

    low: int
    high: int

    def __post_init__(self) -> None:
        if not (0 <= self.low <= MAX_PIP and 0 <= self.high <= MAX_PIP):
            raise ValueError(f"pips out of range: {self.low}-{self.high}")
        if self.low > self.high:
            raise ValueError("Tile must be built with low <= high; use Tile.of()")

    @classmethod
    def of(cls, a: int, b: int) -> "Tile":
        return cls(min(a, b), max(a, b))

    @classmethod
    def parse(cls, text: str) -> "Tile":
        """Parse ``6-4``, ``6|4``, ``6:4``, ``64`` (and ``dd`` for doubles)."""
        raw = text.strip().lower()
        for sep in ("-", "|", ":", "/", ","):
            if sep in raw:
                a, b = raw.split(sep, 1)
                return cls.of(int(a), int(b))
        if len(raw) == 2 and raw.isdigit():
            return cls.of(int(raw[0]), int(raw[1]))
        raise ValueError(f"cannot parse tile: {text!r}")

    @property
    def pips(self) -> int:
        """Point value of the tile (``la chucha`` 0-0 is worth 0)."""
        return self.low + self.high

    @property
    def is_double(self) -> bool:
        return self.low == self.high

    @property
    def faces(self) -> tuple[int, int]:
        return (self.low, self.high)

    def has(self, suit: int) -> bool:
        return self.low == suit or self.high == suit

    def other_face(self, suit: int) -> int:
        """The face left exposed when the tile is joined through ``suit``."""
        if self.low == suit:
            return self.high
        if self.high == suit:
            return self.low
        raise ValueError(f"{self} has no {suit}")

    def __str__(self) -> str:
        return f"{self.low}|{self.high}"

    def __repr__(self) -> str:
        return f"Tile({self.low},{self.high})"


def full_set() -> tuple[Tile, ...]:
    """The 28 tiles of the double-six set, in canonical order."""
    return tuple(Tile(a, b) for a in SUITS for b in range(a, MAX_PIP + 1))


FULL_SET = full_set()
DOUBLE_SIX = Tile(6, 6)
CHUCHA = Tile(0, 0)  # la chucha / el blanco doble

assert len(FULL_SET) == 28


def pip_total(tiles: Iterable[Tile]) -> int:
    return sum(t.pips for t in tiles)


def parse_tiles(text: str) -> list[Tile]:
    """Parse a whitespace/comma separated list of tiles."""
    parts = [p for p in text.replace(",", " ").split() if p]
    return [Tile.parse(p) for p in parts]


def format_tiles(tiles: Iterable[Tile]) -> str:
    return " ".join(f"[{t}]" for t in tiles)


def iter_suit(suit: int) -> Iterator[Tile]:
    """The seven tiles carrying ``suit``."""
    for tile in FULL_SET:
        if tile.has(suit):
            yield tile
