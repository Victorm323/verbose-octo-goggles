"""dominord - a Dominican domino engine.

Reconstruct a physical game on a virtual board, track what every seat can
still be holding, and evaluate the position: best move for each player, an
advantage bar, and the odds around a tranque.
"""

from .evaluation import PositionEval, TranqueReport, advantage_bar, evaluate_position
from .inference import Beliefs, build_beliefs
from .match import Match
from .rules import (DOMINICAN_FORMAL, DOMINICAN_PATIO, RuleSet, preset)
from .scoring import HandResult, score_hand, score_totals
from .search import DEEP, DEFAULT, FAST, LIVE, MoveEval, SearchConfig, best_move, evaluate_moves
from .session import Session
from .state import End, HandState, Move, Pass, Play
from .table import TableView
from .tiles import FULL_SET, Tile, parse_tiles

__all__ = [
    "Beliefs", "DEEP", "DEFAULT", "DOMINICAN_FORMAL", "DOMINICAN_PATIO",
    "End", "FAST", "FULL_SET", "LIVE", "HandResult", "HandState", "Match", "Move",
    "MoveEval", "Pass", "Play", "PositionEval", "RuleSet", "SearchConfig",
    "Session", "TableView", "Tile", "TranqueReport", "advantage_bar",
    "best_move", "build_beliefs", "evaluate_moves", "evaluate_position",
    "parse_tiles", "preset", "score_hand", "score_totals",
]
__version__ = "0.1.0"
