"""The match (``partida``): hands strung together until a pair reaches the target."""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Optional, Sequence

from .rules import RuleSet, DOMINICAN_PATIO
from .scoring import HandResult, score_hand
from .state import HandState, opening_seat, opening_tile
from .tiles import Tile


@dataclass
class Match:
    """Running score of a 2 vs 2 match and the sequence of hand results."""

    rules: RuleSet = DOMINICAN_PATIO
    scores: list[int] = field(default_factory=lambda: [0, 0])
    results: list[HandResult] = field(default_factory=list)
    next_opener: Optional[int] = None   # None => first hand, decided by the deal
    team_names: tuple[str, str] = ("Nosotros", "Ellos")

    @property
    def hands_played(self) -> int:
        return len(self.results)

    @property
    def is_first_hand(self) -> bool:
        return not self.results

    def winner(self) -> Optional[int]:
        for team, score in enumerate(self.scores):
            if score >= self.rules.target_score:
                return team
        return None

    def start_hand(self, deal: Sequence[set[Tile]]) -> HandState:
        """Build the next hand's state from a deal, applying the opening rules."""
        if self.is_first_hand:
            opener = opening_seat(deal, self.rules)
            forced = opening_tile(self.rules, deal)
        else:
            opener = self.next_opener if self.next_opener is not None else 0
            forced = None
        state = HandState.from_deal(deal, self.rules, opener=opener)
        state.force_open_tile(forced)
        return state

    def finish_hand(self, state: HandState) -> HandResult:
        """Score a finished hand and fold it into the match score."""
        result = score_hand(state)
        return self.record(result)

    def record(self, result: HandResult) -> HandResult:
        """Fold an already-computed hand result into the match."""
        if result.winning_team is not None:
            self.scores[result.winning_team] += result.points
        self.results.append(result)
        self.next_opener = result.next_opener
        return result

    def is_pollona(self) -> bool:
        """Target reached while the rivals are still on zero."""
        champ = self.winner()
        return champ is not None and self.scores[1 - champ] == 0

    def summary(self) -> str:
        a, b = self.scores
        line = f"{self.team_names[0]} {a} - {b} {self.team_names[1]}"
        champ = self.winner()
        if champ is None:
            return f"{line}  (a {self.rules.target_score})"
        tag = " ¡POLLONA!" if self.is_pollona() else ""
        return f"{line}  -> {self.team_names[champ]} gana la partida{tag}"
