"""Strength check: the engine pair against the plain 'heaviest tile' pair.

    python scripts/benchmark.py --matches 10

Pair 0 (seats 0 and 2) uses the full evaluation stack; pair 1 plays the patio
default of dropping the heaviest legal tile.
"""

from __future__ import annotations

import argparse
import random
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from dominord.rules import preset
from dominord.search import FAST, SearchConfig
from dominord.selfplay import engine_chooser, greedy_chooser, play_match


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--matches", type=int, default=10)
    parser.add_argument("--samples", type=int, default=FAST.samples)
    parser.add_argument("--rules", default="patio")
    parser.add_argument("--seed", type=int, default=0)
    args = parser.parse_args()

    rules = preset(args.rules)
    config = SearchConfig(samples=args.samples, exact_tiles=FAST.exact_tiles)
    rng = random.Random(args.seed)
    wins = [0, 0]
    points = [0, 0]
    started = time.time()
    for i in range(args.matches):
        choosers = [
            engine_chooser(config), greedy_chooser(args.seed + i),
            engine_chooser(config), greedy_chooser(args.seed + i + 977),
        ]
        match = play_match(rules=rules, choosers=choosers, rng=rng)
        champion = match.winner()
        if champion is not None:
            wins[champion] += 1
        for team in (0, 1):
            points[team] += match.scores[team]
        print(f"{i + 1:>3}: {match.summary()}")
    elapsed = time.time() - started
    print(f"\nmotor {wins[0]} - {wins[1]} simple   "
          f"(puntos {points[0]} - {points[1]}, {elapsed:.1f}s)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
