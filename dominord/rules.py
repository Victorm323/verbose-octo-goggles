"""Rule sets for Dominican domino (dominó dominicano, 2 vs 2).

Dominican domino is a *house rules* game: the skeleton is fixed (28 tiles,
four players, partners across, seven tiles each, no boneyard, two open ends)
but the counting is agreed at the table before the first hand.  Every point
that varies from patio to patio is a field of :class:`RuleSet`, so a session
can be configured to match the table being reconstructed.

See ``docs/RULES.md`` for the research behind each option.
"""

from __future__ import annotations

from dataclasses import dataclass, replace
from enum import Enum


class FirstOpener(str, Enum):
    """Who makes ``la salida`` in the first hand of a match."""

    DOUBLE_SIX = "double_six"      # holder of [6|6] opens, and must play it
    HIGHEST_DOUBLE = "highest_double"  # holder of the highest double opens with it
    HIGHEST_TILE = "highest_tile"  # holder of the heaviest tile opens with it


class NextOpener(str, Enum):
    """Who opens the hands after the first one."""

    HAND_WINNER = "hand_winner"        # the player who closed / won the count
    WINNER_TEAM_ROTATES = "winner_team_rotates"  # winning team, alternating partner
    ROTATE_SEAT = "rotate_seat"        # simply the next seat in turn order


class HandPoints(str, Enum):
    """Which tiles feed the winning team's score."""

    ALL_REMAINING = "all_remaining"    # every tile still in hand, partner's included
    OPPONENTS_ONLY = "opponents_only"  # only the losing pair's tiles


class TranqueWinner(str, Enum):
    """How a blocked hand (``tranque``) is awarded."""

    LOWEST_INDIVIDUAL = "lowest_individual"  # lightest single hand wins for its team
    LOWEST_TEAM_TOTAL = "lowest_team_total"  # lightest pair total wins


class TranqueTie(str, Enum):
    """Who takes a tranque when the deciding counts are equal."""

    OPENER = "opener"        # the player who made la salida of this hand
    BLOCKER = "blocker"      # the player whose tile closed the table
    NO_SCORE = "no_score"    # nobody scores, the hand is void


@dataclass(frozen=True)
class RuleSet:
    """A complete, self-consistent set of table rules."""

    # --- match ---------------------------------------------------------
    target_score: int = 200
    # --- seating / turn order -----------------------------------------
    # Dominican tables deal and play "a la derecha" (counter-clockwise as seen
    # from above).  Seats are numbered in playing order, so seat i is followed
    # by seat (i + 1) % 4 whichever way the physical table turns.
    players: int = 4
    tiles_per_player: int = 7
    # --- openings ------------------------------------------------------
    first_opener: FirstOpener = FirstOpener.DOUBLE_SIX
    first_opener_must_play_tile: bool = True
    next_opener: NextOpener = NextOpener.HAND_WINNER
    # After a tranque the count winner opens; when the tranque is void
    # (TranqueTie.NO_SCORE) the player who blocked the table opens.
    # --- play ----------------------------------------------------------
    must_play_if_able: bool = True   # passing with a legal tile is illegal
    # --- counting ------------------------------------------------------
    hand_points: HandPoints = HandPoints.ALL_REMAINING
    tranque_winner: TranqueWinner = TranqueWinner.LOWEST_INDIVIDUAL
    tranque_tie: TranqueTie = TranqueTie.OPENER
    tranque_points: HandPoints = HandPoints.ALL_REMAINING
    # --- bonuses (0 disables) ------------------------------------------
    capicua_bonus: int = 25    # last tile playable on both ends
    chuchazo_bonus: int = 25   # hand closed with [0|0]
    paso_corrido_bonus: int = 25  # the other three pass in a row on your play
    # --- honours -------------------------------------------------------
    pollona_doubles_game: bool = False  # winning while rivals sit on 0

    def with_(self, **changes: object) -> "RuleSet":
        return replace(self, **changes)  # type: ignore[arg-type]

    @property
    def deck_size(self) -> int:
        return self.players * self.tiles_per_player

    def team_of(self, seat: int) -> int:
        """Partners sit across the table: seats 0/2 vs 1/3."""
        return seat % 2

    def partner_of(self, seat: int) -> int:
        return (seat + 2) % self.players

    def next_seat(self, seat: int) -> int:
        return (seat + 1) % self.players


#: Patio / street rules: what a casual Dominican table plays by default.
#: Every tile left on the table counts for the winners and the bonuses are live.
DOMINICAN_PATIO = RuleSet()

#: Club / federated rules: only the losing pair's tiles count, the tranque is
#: decided by pair totals and there are no shout bonuses.
DOMINICAN_FORMAL = RuleSet(
    hand_points=HandPoints.OPPONENTS_ONLY,
    tranque_points=HandPoints.OPPONENTS_ONLY,
    tranque_winner=TranqueWinner.LOWEST_TEAM_TOTAL,
    tranque_tie=TranqueTie.NO_SCORE,
    capicua_bonus=0,
    chuchazo_bonus=0,
    paso_corrido_bonus=0,
)

#: A shorter match to 100, otherwise identical to patio rules.
DOMINICAN_PATIO_100 = DOMINICAN_PATIO.with_(target_score=100)

PRESETS: dict[str, RuleSet] = {
    "patio": DOMINICAN_PATIO,
    "patio100": DOMINICAN_PATIO_100,
    "formal": DOMINICAN_FORMAL,
}


def preset(name: str) -> RuleSet:
    try:
        return PRESETS[name.strip().lower()]
    except KeyError:
        raise ValueError(
            f"unknown ruleset {name!r}; known: {', '.join(sorted(PRESETS))}"
        ) from None
