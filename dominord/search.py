"""Move evaluation: perfect-information Monte Carlo over consistent deals.

The engine cannot see the other hands, so it does what a strong player does: it
imagines the deals that are *still possible* given everything that has been
played and passed (:mod:`dominord.inference`), plays each of them out, and
averages.  Late in the hand, when few tiles are left, it stops guessing and
solves the position exactly with alpha-beta.

Values are in **hand points**, signed from one team's point of view: ``+45``
means "this line ends with 45 points going to my pair", ``-45`` means the
rivals take 45.
"""

from __future__ import annotations

import random
from dataclasses import dataclass
from typing import Optional, Sequence

from .inference import Beliefs, build_beliefs
from .scoring import HandResult, score_hand
from .state import HandState, Move, Play
from .table import TableView
from .tiles import Tile


# ----------------------------------------------------------------------
# configuration
# ----------------------------------------------------------------------
@dataclass(frozen=True)
class SearchConfig:
    """Knobs for the engine's effort."""

    samples: int = 80           # imagined deals per evaluation
    exact_tiles: int = 14       # solve exactly at or below this many tiles left
    playout_lookahead: int = 1  # plies the rollout policy looks ahead
    seed: int = 0

    def rng(self) -> random.Random:
        return random.Random(self.seed)


#: Cheap: for self-play and for anything that runs thousands of times.
FAST = SearchConfig(samples=24, exact_tiles=12)
#: What the console runs after every recorded move - steady but still instant.
LIVE = SearchConfig(samples=48, exact_tiles=13)
#: The default: sub-second on a mid-hand position.
DEFAULT = SearchConfig()
#: For post-mortems - more imagined deals, exact play deeper into the hand.
DEEP = SearchConfig(samples=140, exact_tiles=17)


# ----------------------------------------------------------------------
# evaluation primitives
# ----------------------------------------------------------------------
def signed_points(result: HandResult, team: int) -> float:
    """Hand points from ``team``'s point of view (rivals' points count against)."""
    if result.winning_team is None:
        return 0.0
    return float(result.points) if result.winning_team == team else -float(result.points)


def static_eval(state: HandState, team: int) -> float:
    """Heuristic value of an unfinished position, in point-ish units.

    Three things decide an unfinished Dominican hand: weight (you want the
    heavy tiles on *their* side), tempo (fewer tiles left than the rivals) and
    control of the numbers showing at the ends.
    """
    rules = state.rules
    ours = [s for s in range(rules.players) if rules.team_of(s) == team]
    theirs = [s for s in range(rules.players) if rules.team_of(s) != team]
    pips = state.hand_pips()
    pip_diff = sum(pips[s] for s in theirs) - sum(pips[s] for s in ours)
    tile_diff = (sum(len(state.hands[s]) for s in theirs)
                 - sum(len(state.hands[s]) for s in ours))
    ends = [e for e in state.ends if e is not None]
    def answers(seats: list[int]) -> int:
        return sum(
            1
            for s in seats
            for t in state.hands[s]
            if any(t.has(e) for e in ends)
        )
    control = answers(ours) - answers(theirs)
    return 0.45 * pip_diff + 3.0 * tile_diff + 1.5 * control


# ----------------------------------------------------------------------
# rollouts
# ----------------------------------------------------------------------
def _move_score(state: HandState, move: Move, team: int) -> float:
    """One-ply value of a move for the side to move."""
    undo = state.apply(move)
    try:
        if state.is_over():
            value = signed_points(score_hand(state), team)
        else:
            value = static_eval(state, team)
    finally:
        state.undo(undo)
    return value


def greedy_move(state: HandState, rng: Optional[random.Random] = None) -> Move:
    """The rollout policy: best one-ply move for the side to move."""
    seat = state.turn
    team = state.rules.team_of(seat)
    moves = state.legal_moves(seat)
    if len(moves) == 1:
        return moves[0]
    best: list[Move] = []
    best_value = float("-inf")
    for move in moves:
        value = _move_score(state, move, team)
        if value > best_value + 1e-9:
            best_value, best = value, [move]
        elif value > best_value - 1e-9:
            best.append(move)
    if len(best) == 1 or rng is None:
        return best[0]
    return rng.choice(best)


def playout(state: HandState, rng: Optional[random.Random] = None) -> HandResult:
    """Play the position out with the greedy policy and score it."""
    while not state.is_over():
        state.apply(greedy_move(state, rng))
    return score_hand(state)


# ----------------------------------------------------------------------
# exact endgame solver
# ----------------------------------------------------------------------
EXACT, LOWER, UPPER = 0, 1, 2


def solve(state: HandState, team: int,
          alpha: float = float("-inf"),
          beta: float = float("inf"),
          cache: Optional[dict] = None) -> tuple[float, Optional[HandResult]]:
    """Exact alpha-beta value of the position for ``team``.

    Returns the value in signed hand points together with the terminal result
    of the principal line, so callers can also read off *how* the hand ends
    (dominó or tranque) under best play.
    """
    if state.is_over():
        result = score_hand(state)
        return signed_points(result, team), result
    cache = {} if cache is None else cache
    key = (
        tuple(frozenset(h) for h in state.hands),
        state.left_end,
        state.right_end,
        state.turn,
        state.passes_in_row,
    )
    alpha_orig, beta_orig = alpha, beta
    hit = cache.get(key)
    if hit is not None:
        value, result, flag = hit
        if flag == EXACT:
            return value, result
        if flag == LOWER and value >= beta:
            return value, result
        if flag == UPPER and value <= alpha:
            return value, result

    maximizing = state.rules.team_of(state.turn) == team
    best_value = float("-inf") if maximizing else float("inf")
    best_result: Optional[HandResult] = None
    moves = state.legal_moves()
    # Heavy tiles first: they cut more branches off early.
    moves.sort(key=lambda m: -(m.tile.pips if isinstance(m, Play) else 0))
    for move in moves:
        undo = state.apply(move)
        try:
            value, result = solve(state, team, alpha, beta, cache)
        finally:
            state.undo(undo)
        if maximizing:
            if value > best_value:
                best_value, best_result = value, result
            alpha = max(alpha, value)
        else:
            if value < best_value:
                best_value, best_result = value, result
            beta = min(beta, value)
        if alpha >= beta:
            break

    if best_value <= alpha_orig:
        flag = UPPER
    elif best_value >= beta_orig:
        flag = LOWER
    else:
        flag = EXACT
    cache[key] = (best_value, best_result, flag)
    return best_value, best_result


def resolve(state: HandState, team: int, config: SearchConfig,
            rng: Optional[random.Random] = None) -> tuple[float, HandResult]:
    """Value and terminal outcome of a determinized position.

    Exact once the position is small enough, a greedy playout before that.
    """
    if state.is_over():
        result = score_hand(state)
        return signed_points(result, team), result
    if state.tiles_left <= config.exact_tiles:
        value, result = solve(state.copy(), team)
        if result is not None:
            return value, result
    probe = state.copy()
    result = playout(probe, rng)
    return signed_points(result, team), result


# ----------------------------------------------------------------------
# move evaluation over sampled deals
# ----------------------------------------------------------------------
@dataclass
class MoveEval:
    """What the engine thinks of one candidate move."""

    move: Move
    ev_points: float = 0.0        # expected hand points for the mover's team
    win_prob: float = 0.0         # P(mover's pair takes the hand)
    tranque_prob: float = 0.0     # P(the hand ends blocked)
    tranque_win_prob: float = 0.0 # P(blocked *and* the pair wins the count)
    samples: int = 0              # deals in which this move was available
    availability: float = 1.0     # share of imagined deals allowing it
    choice_prob: float = 0.0      # share of deals in which it was the best move
    label: str = ""

    @property
    def tile(self) -> Optional[Tile]:
        return self.move.tile if isinstance(self.move, Play) else None

    def describe(self) -> str:
        head = (f"[{self.move.tile}] {self.move.end.value:5s}"
                if isinstance(self.move, Play) else "paso       ")
        line = (f"{head}  ev {self.ev_points:+6.1f}  win {self.win_prob:5.1%}"
                f"  tranque {self.tranque_prob:5.1%}"
                f" (gana {self.tranque_win_prob:5.1%})")
        if self.availability < 0.999:
            line += f"  disponible {self.availability:5.1%}"
        return line


def evaluate_moves(
    view: TableView,
    seat: Optional[int] = None,
    config: SearchConfig = DEFAULT,
    beliefs: Optional[Beliefs] = None,
    deals: Optional[Sequence[list[set[Tile]]]] = None,
    hypothetical: bool = False,
) -> list[MoveEval]:
    """Rank the moves available to ``seat`` (default: whoever is to play).

    Works for any seat: for a seat whose hand is known the candidate moves are
    that hand's legal plays; for an unknown seat the candidates are the plays
    that appear across the imagined deals, weighted by how often they are
    possible (``availability``) and how often they came out best (``choice_prob``).

    With ``hypothetical=True`` the seat is analysed as if it were its turn,
    which is how the engine answers "and what is the best move *they* have?"
    for the three seats that are not on play.
    """
    seat = view.turn if seat is None else seat
    rules = view.rules
    team = rules.team_of(seat)
    beliefs = beliefs or build_beliefs(view)
    rng = config.rng()
    deals = list(deals) if deals is not None else [
        beliefs.sample_deal(rng) for _ in range(config.samples)
    ]

    stats: dict[Move, dict[str, float]] = {}
    considered = 0
    for deal in deals:
        state = view.to_hand_state(deal)
        if state.is_over():
            continue
        if state.turn != seat:
            if not hypothetical:
                continue
            state.turn = seat
        considered += 1
        best_here: tuple[float, Optional[Move]] = (float("-inf"), None)
        for move in state.legal_moves(seat):
            undo = state.apply(move)
            try:
                value, result = resolve(state, team, config, rng)
            finally:
                state.undo(undo)
            bucket = stats.setdefault(
                move, {"n": 0.0, "ev": 0.0, "win": 0.0, "tr": 0.0, "trwin": 0.0})
            bucket["n"] += 1
            bucket["ev"] += value
            bucket["win"] += 1.0 if result.winning_team == team else 0.0
            blocked = result.kind in ("tranque", "void")
            bucket["tr"] += 1.0 if blocked else 0.0
            bucket["trwin"] += 1.0 if (blocked and result.winning_team == team) else 0.0
            if value > best_here[0]:
                best_here = (value, move)
        if best_here[1] is not None:
            chosen = stats[best_here[1]]
            chosen["chosen"] = chosen.get("chosen", 0.0) + 1.0

    evals = [
        MoveEval(
            move=move,
            ev_points=b["ev"] / b["n"],
            win_prob=b["win"] / b["n"],
            tranque_prob=b["tr"] / b["n"],
            tranque_win_prob=b["trwin"] / b["n"],
            samples=int(b["n"]),
            availability=b["n"] / considered if considered else 0.0,
            choice_prob=b.get("chosen", 0.0) / considered if considered else 0.0,
        )
        for move, b in stats.items()
        if b["n"]
    ]
    # A seat whose hand we hold is ranked by how good the move is; a seat we
    # are only guessing at is ranked by how often it turns out to be their
    # play, so the list reads as a prediction rather than as advice.
    if view.current_hand(seat) is not None:
        evals.sort(key=lambda e: (-e.ev_points, -e.win_prob))
        if evals:
            evals[0].label = "mejor jugada"
    else:
        evals.sort(key=lambda e: (-e.choice_prob, -e.ev_points))
        if evals:
            evals[0].label = "jugada más probable"
    return evals


def best_move(view: TableView, seat: Optional[int] = None,
              config: SearchConfig = DEFAULT,
              hypothetical: bool = False) -> Optional[MoveEval]:
    """The engine's pick for a seat, or ``None`` when it has nothing to play."""
    evals = evaluate_moves(view, seat, config, hypothetical=hypothetical)
    return evals[0] if evals else None
