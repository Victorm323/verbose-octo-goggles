"""Who is holding what: hard deductions plus exact tile probabilities.

Dominican players track two things all hand long: **what has fallen**, and
**what each seat cannot possibly hold**.  The second one is free information -
a player who passed on the 4 and the 1 will never hold another 4 or 1, because
tiles only ever leave a hand.

This module turns those deductions into numbers:

* :attr:`Beliefs.candidates` - the hard set of tiles a seat can still hold;
* :attr:`Beliefs.marginals` - the exact probability that a seat holds a tile,
  computed over *all* deals consistent with the observations (not a sample);
* :meth:`Beliefs.sample_deal` - a uniformly random consistent deal, which is
  what the search engine determinizes on.

The counting model treats every consistent deal as equally likely.  That is the
honest prior given passes, hand sizes and shown tiles; it deliberately does not
try to read a player's *choice* of tile (a soft signal that varies by opponent).
"""

from __future__ import annotations

import random
from dataclasses import dataclass, field
from typing import Optional, Sequence

from .table import TableView
from .tiles import Tile


class InconsistentObservations(ValueError):
    """No deal of the unseen tiles fits everything that has been recorded."""


@dataclass
class Beliefs:
    """Per-seat tile probabilities for one position."""

    seats: tuple[int, ...]                     # seats whose hands are unknown
    capacities: tuple[int, ...]                # tiles each unknown seat holds
    tiles: tuple[Tile, ...]                    # the unseen tiles
    allowed: dict[int, set[Tile]]              # seat -> tiles it may hold
    marginals: dict[Tile, dict[int, float]]    # tile -> seat -> probability
    total_deals: int                           # number of consistent deals
    known_hands: dict[int, set[Tile]] = field(default_factory=dict)
    _suffix: list[dict[tuple[int, ...], int]] = field(
        default_factory=list, repr=False)

    def probability(self, seat: int, tile: Tile) -> float:
        """Probability that ``seat`` holds ``tile`` (1.0 / 0.0 when known)."""
        if seat in self.known_hands:
            return 1.0 if tile in self.known_hands[seat] else 0.0
        return self.marginals.get(tile, {}).get(seat, 0.0)

    def expected_pips(self, seat: int) -> float:
        """Expected pip weight of a seat's hand."""
        if seat in self.known_hands:
            return float(sum(t.pips for t in self.known_hands[seat]))
        return sum(t.pips * self.probability(seat, t) for t in self.tiles)

    def suit_probability(self, seat: int, suit: int) -> float:
        """Probability that ``seat`` can answer ``suit`` (holds at least one)."""
        if seat in self.known_hands:
            return 1.0 if any(t.has(suit) for t in self.known_hands[seat]) else 0.0
        if seat not in self.allowed:
            return 0.0
        if not any(t.has(suit) for t in self.allowed[seat]):
            return 0.0
        # 1 - P(holds none of the suit); estimated by Monte Carlo over exact
        # samples when a closed form is not available.
        return _suit_probability(self, seat, suit)

    def sample_deal(self, rng: random.Random) -> list[set[Tile]]:
        """A uniformly random deal of the unseen tiles, consistent with play."""
        assign = _sample_assignment(self, rng)
        hands: dict[int, set[Tile]] = {s: set() for s in self.seats}
        for tile, seat in assign.items():
            hands[seat].add(tile)
        out: list[set[Tile]] = []
        for seat in range(max(list(self.seats) + list(self.known_hands)) + 1):
            if seat in self.known_hands:
                out.append(set(self.known_hands[seat]))
            else:
                out.append(hands.get(seat, set()))
        return out


# ----------------------------------------------------------------------
# building
# ----------------------------------------------------------------------
def build_beliefs(view: TableView) -> Beliefs:
    """Deduce candidate sets and exact marginals for the current position."""
    unknown = view.unknown_seats()
    counts = view.counts()
    voids = view.voids()
    unseen = sorted(view.unseen_tiles())
    capacities = tuple(counts[s] for s in unknown)
    if sum(capacities) != len(unseen):
        raise InconsistentObservations(
            f"{len(unseen)} unseen tiles cannot fill hands of sizes {capacities}")

    allowed: dict[int, set[Tile]] = {}
    for seat in unknown:
        void = voids[seat]
        allowed[seat] = {
            t for t in unseen if not (t.low in void or t.high in void)
        }
    allow_idx = [
        tuple(i for i, seat in enumerate(unknown) if tile in allowed[seat])
        for tile in unseen
    ]
    suffix = _suffix_counts(allow_idx, capacities)
    total = suffix[0].get(capacities, 0)
    if total == 0:
        raise InconsistentObservations(
            "the recorded passes and hand sizes admit no legal deal; "
            "check the move history")

    marginals = _marginals(unseen, allow_idx, capacities, suffix, unknown, total)
    known = {s: h for s in view.known_hands
             if (h := view.current_hand(s)) is not None}
    return Beliefs(
        seats=tuple(unknown),
        capacities=capacities,
        tiles=tuple(unseen),
        allowed=allowed,
        marginals=marginals,
        total_deals=total,
        known_hands=known,
        _suffix=suffix,
    )


def _suffix_counts(
    allow_idx: Sequence[tuple[int, ...]],
    capacities: tuple[int, ...],
) -> list[dict[tuple[int, ...], int]]:
    """``suffix[i][caps]`` = deals of tiles ``i..`` into the given free slots."""
    n = len(allow_idx)
    zero = tuple(0 for _ in capacities)
    suffix: list[dict[tuple[int, ...], int]] = [dict() for _ in range(n + 1)]
    suffix[n][zero] = 1
    for i in range(n - 1, -1, -1):
        table = suffix[i]
        nxt = suffix[i + 1]
        for caps, ways in nxt.items():
            for k in allow_idx[i]:
                if caps[k] >= capacities[k]:
                    continue
                bumped = list(caps)
                bumped[k] += 1
                key = tuple(bumped)
                table[key] = table.get(key, 0) + ways
    return suffix


def _marginals(
    tiles: Sequence[Tile],
    allow_idx: Sequence[tuple[int, ...]],
    capacities: tuple[int, ...],
    suffix: list[dict[tuple[int, ...], int]],
    seats: Sequence[int],
    total: int,
) -> dict[Tile, dict[int, float]]:
    """Exact P(seat holds tile) by pairing prefix and suffix counts."""
    n = len(tiles)
    zero = tuple(0 for _ in capacities)
    prefix: dict[tuple[int, ...], int] = {zero: 1}   # slots already filled
    out: dict[Tile, dict[int, float]] = {}
    for i in range(n):
        tile_probs: dict[int, int] = {}
        for used, ways in prefix.items():
            free = tuple(c - u for c, u in zip(capacities, used))
            for k in allow_idx[i]:
                if free[k] == 0:
                    continue
                rest = list(free)
                rest[k] -= 1
                tail = suffix[i + 1].get(tuple(rest))
                if tail:
                    tile_probs[k] = tile_probs.get(k, 0) + ways * tail
        out[tiles[i]] = {
            seats[k]: count / total for k, count in sorted(tile_probs.items())
        }
        # advance the prefix
        nxt: dict[tuple[int, ...], int] = {}
        for used, ways in prefix.items():
            for k in allow_idx[i]:
                if used[k] >= capacities[k]:
                    continue
                bumped = list(used)
                bumped[k] += 1
                key = tuple(bumped)
                nxt[key] = nxt.get(key, 0) + ways
        prefix = nxt
    return out


def _sample_assignment(beliefs: Beliefs, rng: random.Random) -> dict[Tile, int]:
    """Exact uniform sampling of one consistent deal, using the suffix counts."""
    capacities = beliefs.capacities
    tiles = beliefs.tiles
    allow_idx = [
        tuple(i for i, seat in enumerate(beliefs.seats)
              if tile in beliefs.allowed[seat])
        for tile in tiles
    ]
    suffix = beliefs._suffix or _suffix_counts(allow_idx, capacities)
    free = list(capacities)
    assignment: dict[Tile, int] = {}
    for i, tile in enumerate(tiles):
        weights: list[tuple[int, int]] = []
        for k in allow_idx[i]:
            if free[k] == 0:
                continue
            rest = list(free)
            rest[k] -= 1
            ways = suffix[i + 1].get(tuple(rest), 0)
            if ways:
                weights.append((k, ways))
        if not weights:
            raise InconsistentObservations("sampling hit a dead end")
        total = sum(w for _, w in weights)
        pick = rng.randrange(total)
        for k, w in weights:
            if pick < w:
                free[k] -= 1
                assignment[tile] = beliefs.seats[k]
                break
            pick -= w
    return assignment


def _suit_probability(beliefs: Beliefs, seat: int, suit: int,
                      samples: int = 400) -> float:
    """P(seat holds at least one tile of ``suit``), by exact-uniform sampling."""
    rng = random.Random(0xD070 + suit * 31 + seat)
    hits = 0
    for _ in range(samples):
        deal = beliefs.sample_deal(rng)
        if any(t.has(suit) for t in deal[seat]):
            hits += 1
    return hits / samples


def sample_deals(view: TableView, count: int, rng: random.Random,
                 beliefs: Optional[Beliefs] = None) -> list[list[set[Tile]]]:
    """``count`` uniformly random deals consistent with the recorded hand."""
    beliefs = beliefs or build_beliefs(view)
    return [beliefs.sample_deal(rng) for _ in range(count)]
