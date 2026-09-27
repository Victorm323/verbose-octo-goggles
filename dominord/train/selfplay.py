"""Batched self-play: many hands stepped in lockstep, one forward pass per round.

Each seat of each hand is played by an *agent*: ``("net", key)`` for a
network (``"current"`` is the one being trained, other keys are frozen
snapshots) or ``("bot", name)`` for a heuristic from :mod:`.bots`.  Every
decision point of every network seat in the same round is batched into one
forward pass, which is what keeps a GPU busy.
"""

from __future__ import annotations

import random
from dataclasses import dataclass, field

import numpy as np
import torch

from . import bots
from .env import Game, make_rules, new_game
from .features import ACTION_DIM, STATE_DIM, action_features, belief_targets, state_features
from .model import VALUE_SCALE

Agent = tuple[str, str]


@dataclass
class Population:
    """How each training hand is seated (ROADMAP Phase 2, population training)."""

    rules: list[str] = field(default_factory=lambda: ["patio", "formal", "mano", "mano_dormidas"])
    p_self: float = 0.45          # rivals = the current net (pure self-play)
    p_snapshot: float = 0.30      # rivals = a frozen past network
    # the remainder: rivals = heuristic players (patio styles)
    p_bot_partner: float = 0.15   # our partner is a heuristic (robustness to a weak partner)
    epsilon: float = 0.02         # exploration: random legal move
    styles: tuple[str, ...] = tuple(bots.HEURISTICS)

    def seat(self, rng: random.Random, rules_name: str, snapshots: list[str]) -> tuple[dict, list[Agent]]:
        rules = make_rules(rules_name)
        n = rules["players"]
        ours = rng.randrange(2)
        agents: list[Agent] = [("net", "current")] * n
        x = rng.random()
        if x < self.p_self:
            rival: list[Agent] | None = None
        elif x < self.p_self + self.p_snapshot and snapshots:
            snap = rng.choice(snapshots)
            rival = [("net", snap)]
        else:
            rival = [("bot", rng.choice(self.styles)) for _ in range(2)]
        for s in range(n):
            if s % 2 != ours and rival is not None:
                agents[s] = rival[(s // 2) % len(rival)]
        if n == 4 and rng.random() < self.p_bot_partner:
            partner = [s for s in range(n) if s % 2 == ours][rng.randrange(2)]
            agents[partner] = ("bot", rng.choice(self.styles))
        return rules, agents


@dataclass
class Batch:
    states: np.ndarray
    actions: np.ndarray
    returns: np.ndarray
    beliefs: np.ndarray
    win: np.ndarray       # 1 = this seat's pair took the hand, 0 = lost, 0.5 = void
    tranque: np.ndarray   # 1 = the hand ended blocked
    qmask: np.ndarray     # 1 = a real decision (trains Q); 0 = an observer row

    def __len__(self) -> int:
        return len(self.returns)


def play(games: list[Game], agents: list[list[Agent]], models: dict, rng: random.Random,
         epsilon: float = 0.0, record: tuple[str, ...] = ("current",),
         device: torch.device | str = "cpu") -> Batch:
    """Play every game to the end; return the recorded network decisions."""
    rec_game: list[int] = []
    rec_seat: list[int] = []
    rec_s: list[np.ndarray] = []
    rec_a: list[np.ndarray] = []
    rec_b: list[np.ndarray] = []
    rec_q: list[float] = []
    zero_a = np.zeros(ACTION_DIM, np.float32)
    active = list(range(len(games)))
    while active:
        pending: dict[str, list[tuple[int, int, list[int]]]] = {}
        still = []
        for gi in active:
            g = games[gi]
            while not g.is_over():
                legal = g.legal()
                ag = agents[gi][g.turn]
                if len(legal) == 1:
                    g.step(legal[0])
                    continue
                if ag[0] == "bot":
                    g.step(bots.choose(ag[1], g, legal, rng))
                    continue
                pending.setdefault(ag[1], []).append((gi, g.turn, legal))
                break
            if not g.is_over():
                still.append(gi)
        for key, items in pending.items():
            S = np.stack([state_features(games[gi], seat) for gi, seat, _ in items])
            A_rows, idx = [], []
            for j, (gi, _seat, legal) in enumerate(items):
                for m in legal:
                    A_rows.append(action_features(games[gi], m))
                    idx.append(j)
            A = np.stack(A_rows)
            with torch.no_grad():
                q = models[key].q_values(torch.from_numpy(S).to(device), torch.from_numpy(A).to(device),
                                         torch.tensor(idx, device=device)).float().cpu().numpy()
            pos = 0
            for j, (gi, seat, legal) in enumerate(items):
                qs = q[pos:pos + len(legal)]
                k = rng.randrange(len(legal)) if epsilon and rng.random() < epsilon else int(np.argmax(qs))
                if key in record:
                    g = games[gi]
                    rec_game.append(gi)
                    rec_seat.append(seat)
                    rec_s.append(S[j])
                    rec_a.append(A[pos + k])
                    rec_b.append(belief_targets(g, seat))
                    rec_q.append(1.0)
                    # An observer row: the same moment from another seat, so the
                    # value/win/tranque/belief heads also learn off-turn positions
                    # (the UI asks "how do we stand?" whoever is to play).
                    other = (seat + 1 + rng.randrange(g.n - 1)) % g.n
                    rec_game.append(gi)
                    rec_seat.append(other)
                    rec_s.append(state_features(g, other))
                    rec_a.append(zero_a)
                    rec_b.append(belief_targets(g, other))
                    rec_q.append(0.0)
                pos += len(legal)
                games[gi].step(legal[k])
        active = still
    results = [g.result() for g in games]
    returns = np.array([results[gi][0] * (1 if seat % 2 == 0 else -1) for gi, seat in zip(rec_game, rec_seat)],
                       dtype=np.float32) / VALUE_SCALE
    win = np.array([0.5 if results[gi][2] is None else float(results[gi][2] == seat % 2)
                    for gi, seat in zip(rec_game, rec_seat)], dtype=np.float32)
    tranque = np.array([float(results[gi][1] != "domino") for gi in rec_game], dtype=np.float32)
    if not rec_s:
        e = np.zeros(0, np.float32)
        return Batch(np.zeros((0, STATE_DIM), np.float32), np.zeros((0, ACTION_DIM), np.float32),
                     returns, np.zeros((0, 28), np.int64), e, e, e)
    return Batch(np.stack(rec_s), np.stack(rec_a), returns, np.stack(rec_b), win, tranque,
                 np.array(rec_q, dtype=np.float32))


def generate(pop: Population, models: dict, snapshots: list[str], n_games: int,
             rng: random.Random, device="cpu") -> tuple[Batch, int]:
    games, agents = [], []
    for _ in range(n_games):
        rules, ag = pop.seat(rng, rng.choice(pop.rules), snapshots)
        games.append(new_game(rules, rng))
        agents.append(ag)
    return play(games, agents, models, rng, pop.epsilon, device=device), n_games


def duplicate(models: dict, a: Agent, b: Agent, rules_name: str, deals: int, seed: int,
              device="cpu") -> dict:
    """Duplicate-scored match: every deal twice, the two agents swapping pairs.

    Returns A's mean paired margin in hand points with a 95% CI.
    """
    rng = random.Random(seed)
    rules = make_rules(rules_name)
    n = rules["players"]
    games, agents = [], []
    for _ in range(deals):
        g = new_game(rules, rng)
        for flip in (0, 1):
            twin = Game(rules, g.hands[:n], g.pozo, g.opener, g.forced)
            games.append(twin)
            agents.append([a if (s % 2 == 0) != bool(flip) else b for s in range(n)])
    play(games, agents, models, random.Random(seed + 1), 0.0, record=(), device=device)
    margins = []
    for i in range(0, len(games), 2):
        v0 = games[i].result()[0]        # A was team 0
        v1 = -games[i + 1].result()[0]   # A was team 1
        margins.append((v0 + v1) / 2)
    m = np.array(margins, dtype=np.float64)
    mean, sd = float(m.mean()), float(m.std(ddof=1)) if len(m) > 1 else 0.0
    half = 1.96 * sd / max(1.0, len(m)) ** 0.5
    return {"rules": rules_name, "deals": deals, "margin": mean, "lo": mean - half, "hi": mean + half, "sd": sd}
