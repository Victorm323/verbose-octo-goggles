"""Self-play training: CPU actors generate hands, the learner trains on the GPU.

    pip install -e ".[train]"
    python -m dominord.train --out runs/first --hours 12 --actors 12

Everything a run produces lives in ``--out``:

    current.pt            the network being trained (actors reload it)
    snapshots/*.pt        frozen past networks, the league opponents
    champion.pt           the best network so far, promoted only by a
                          duplicate-scored win whose 95% CI is above zero
    ladder.jsonl          every evaluation, appended (ROADMAP Phase 0)
    log.jsonl             throughput and losses
    dominord-net.json     the champion exported for web/engine.js

Use ``--resume`` to continue a run.  See docs/TRAINING.md.
"""

from __future__ import annotations

import argparse
import json
import os
import queue as queue_mod
import random
import time
from pathlib import Path

import numpy as np
import torch
import torch.multiprocessing as mp
from torch import nn

from . import model as M
from .features import ACTION_DIM, STATE_DIM
from .selfplay import Batch, Population, duplicate, generate


# ---------------------------------------------------------------- replay buffer
class Replay:
    """FIFO ring of recent decisions (Deep Monte-Carlo is near on-policy)."""

    def __init__(self, cap: int):
        self.cap = cap
        self.s = np.zeros((cap, STATE_DIM), np.float32)
        self.a = np.zeros((cap, ACTION_DIM), np.float32)
        self.g = np.zeros(cap, np.float32)
        self.b = np.full((cap, 28), -1, np.int64)
        self.o = np.zeros((cap, 3), np.float32)   # win, tranque, qmask
        self.n = 0
        self.i = 0

    def add(self, batch: Batch) -> None:
        k = len(batch)
        for start in range(0, k, self.cap):
            chunk = slice(start, min(k, start + self.cap))
            m = chunk.stop - chunk.start
            idx = (self.i + np.arange(m)) % self.cap
            self.s[idx] = batch.states[chunk]
            self.a[idx] = batch.actions[chunk]
            self.g[idx] = batch.returns[chunk]
            self.b[idx] = batch.beliefs[chunk]
            self.o[idx, 0] = batch.win[chunk]
            self.o[idx, 1] = batch.tranque[chunk]
            self.o[idx, 2] = batch.qmask[chunk]
            self.i = int((self.i + m) % self.cap)
            self.n = min(self.cap, self.n + m)

    def sample(self, size: int, rng: np.random.Generator):
        idx = rng.integers(0, self.n, size)
        return self.s[idx], self.a[idx], self.g[idx], self.b[idx], self.o[idx]


def loss_fn(net: M.DomNet, s, a, g, b, o, belief_weight: float):
    q, v, logits, aux = net(s, a)
    qmask = o[:, 2]
    # Q only on real decisions; observer rows train the other heads.
    lq = ((q - g) ** 2 * qmask).sum() / qmask.sum().clamp(min=1.0)
    lv = nn.functional.mse_loss(v, g)
    lb = nn.functional.cross_entropy(logits.reshape(-1, 4), b.reshape(-1), ignore_index=-1)
    la = nn.functional.binary_cross_entropy_with_logits(aux, o[:, :2])
    return lq + 0.5 * lv + belief_weight * lb + 0.5 * la, (lq.item(), lv.item(), lb.item(), la.item())


# ---------------------------------------------------------------- actors
def _load_snapshots(out: Path, cache: dict, keep: int) -> list[str]:
    paths = sorted((out / "snapshots").glob("*.pt"))[-keep:]
    champ = out / "champion.pt"
    if champ.exists():
        paths.append(champ)
    names = []
    for p in paths:
        try:
            key = p.stem if p.name != "champion.pt" else "champion@" + str(int(p.stat().st_mtime))
        except OSError:  # being replaced right now (Windows); next round
            continue
        if key not in cache:
            try:
                cache[key] = M.load(p)
            except Exception:  # half-written file; next round
                continue
        names.append(key)
    for k in [k for k in cache if k not in names and k != "current"]:
        del cache[k]
    return names


def actor_main(idx: int, out: str, pop: Population, q, stop, games: int, seed: int) -> None:
    torch.set_num_threads(1)
    out_p = Path(out)
    rng = random.Random(seed)
    cache: dict = {}
    mtime = 0.0
    while not stop.is_set():
        cur = out_p / "current.pt"
        try:
            mt = cur.stat().st_mtime
            if mt != mtime:
                cache["current"] = M.load(cur)
                mtime = mt
        except (OSError, RuntimeError, EOFError):   # OSError: mid-replace on Windows
            time.sleep(0.5)
            continue
        snaps = _load_snapshots(out_p, cache, keep=8)
        batch, n = generate(pop, cache, snaps, games, rng)
        q.put((batch, n))


# ---------------------------------------------------------------- learner
def _atomic_save(net: M.DomNet, path: Path, meta: dict) -> None:
    tmp = path.with_suffix(".tmp")
    M.save(net, tmp, meta)
    # Windows refuses to replace a file another process has open, and the
    # actors reload current.pt constantly; their reads are brief, so retry.
    for attempt in range(200):
        try:
            os.replace(tmp, path)
            return
        except PermissionError:
            if attempt == 199:
                raise
            time.sleep(0.05)


def evaluate(out: Path, net: M.DomNet, device, deals: int, seed: int, log) -> dict:
    """Duplicate matches: vs the patio heuristics and vs the champion."""
    cpu_net = M.DomNet(net.hidden, net.qhidden)
    cpu_net.load_state_dict({k: v.detach().cpu() for k, v in net.state_dict().items()})
    cpu_net.eval()
    models = {"current": cpu_net}
    res = {"t": time.time()}
    for rules in ("patio", "mano"):
        for bot in ("greedy", "heavy"):
            r = duplicate(models, ("net", "current"), ("bot", bot), rules, deals, seed)
            res[f"{rules}_vs_{bot}"] = r
    champ = out / "champion.pt"
    if champ.exists():
        models["champion"] = M.load(champ)
        for rules in ("patio", "mano"):
            res[f"{rules}_vs_champion"] = duplicate(models, ("net", "current"), ("net", "champion"),
                                                    rules, deals, seed + 7)
    log(res)
    return res


def main(argv=None) -> None:
    ap = argparse.ArgumentParser(prog="python -m dominord.train", description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--out", default="runs/default")
    ap.add_argument("--device", default="auto", help="auto | cuda | cuda:1 | mps | cpu")
    ap.add_argument("--hours", type=float, default=1.0)
    ap.add_argument("--max-hands", type=int, default=0, help="stop after this many hands (0 = no limit)")
    ap.add_argument("--actors", type=int, default=max(1, (os.cpu_count() or 2) - 1),
                    help="self-play processes; 0 plays in the learner process")
    ap.add_argument("--games", type=int, default=128, help="hands per actor round")
    ap.add_argument("--batch", type=int, default=2048)
    ap.add_argument("--lr", type=float, default=3e-4)
    ap.add_argument("--buffer", type=int, default=1_000_000)
    ap.add_argument("--min-buffer", type=int, default=20_000)
    ap.add_argument("--replay-ratio", type=float, default=4.0,
                    help="samples trained per new decision (keeps the GPU from outrunning the actors)")
    ap.add_argument("--hidden", type=int, default=256)
    ap.add_argument("--qhidden", type=int, default=128)
    ap.add_argument("--belief-weight", type=float, default=0.2)
    ap.add_argument("--rules", default="patio,formal,mano,mano_dormidas")
    ap.add_argument("--epsilon", type=float, default=0.02)
    ap.add_argument("--sync-sec", type=float, default=20.0)
    ap.add_argument("--snapshot-min", type=float, default=15.0)
    ap.add_argument("--eval-min", type=float, default=10.0)
    ap.add_argument("--eval-deals", type=int, default=600)
    ap.add_argument("--export", default="", help="also copy the exported champion here (e.g. web/models/dominord-net.json)")
    ap.add_argument("--resume", action="store_true")
    ap.add_argument("--init", default="", help="start from these weights (e.g. an older run's current.pt); new heads start fresh")
    ap.add_argument("--seed", type=int, default=1)
    args = ap.parse_args(argv)

    out = Path(args.out)
    (out / "snapshots").mkdir(parents=True, exist_ok=True)
    device = M.device_auto(args.device)
    if device.type == "cpu" and args.actors:
        # Leave the cores to the actors; a CPU learner with every thread starves them.
        torch.set_num_threads(max(1, (os.cpu_count() or 2) - args.actors))
    torch.manual_seed(args.seed)
    net = M.DomNet(args.hidden, args.qhidden)
    hands_total, steps, t_prev = 0, 0, 0.0
    if args.resume and (out / "current.pt").exists():
        ck = torch.load(out / "current.pt", map_location="cpu", weights_only=True)
        net = M.DomNet(ck["hidden"], ck["qhidden"])
        net.load_state_dict(ck["state"], strict=False)   # older runs lack newer heads
        hands_total = ck["meta"].get("hands", 0)
        steps = ck["meta"].get("steps", 0)
        t_prev = ck["meta"].get("seconds", 0.0)
    elif args.init:
        net = M.load(Path(args.init))
        print(f"initialised from {args.init}", flush=True)
    net.to(device)
    opt = torch.optim.Adam(net.parameters(), lr=args.lr)
    pop = Population(rules=args.rules.split(","), epsilon=args.epsilon)
    logf = open(out / "log.jsonl", "a", encoding="utf-8")
    ladder = open(out / "ladder.jsonl", "a", encoding="utf-8")

    def log(rec: dict) -> None:
        line = json.dumps(rec)
        print(line, flush=True)
        (ladder if "patio_vs_greedy" in rec else logf).write(line + "\n")
        (ladder if "patio_vs_greedy" in rec else logf).flush()

    def meta() -> dict:
        return {"hands": hands_total, "steps": steps, "seconds": t_prev + time.time() - t0,
                "rules": pop.rules, "hidden": net.hidden}

    t0 = time.time()
    _atomic_save(net, out / "current.pt", meta())
    print(f"device {device} · actors {args.actors} · out {out}", flush=True)

    ctx = mp.get_context("spawn")
    q = ctx.Queue(maxsize=max(4, 2 * args.actors))
    stop = ctx.Event()
    procs = [ctx.Process(target=actor_main, args=(i, str(out), pop, q, stop, args.games, args.seed * 1000 + i),
                         daemon=True) for i in range(args.actors)]
    for p in procs:
        p.start()
    local_models: dict = {"current": net}
    local_cache: dict = {}
    rng_py = random.Random(args.seed)
    rng_np = np.random.default_rng(args.seed)
    replay = Replay(args.buffer)
    owed = 0.0
    last_sync = last_snap = last_eval = last_log = time.time()
    new_dec = 0
    losses = []
    deadline = t0 + args.hours * 3600

    try:
        while time.time() < deadline and not (args.max_hands and hands_total >= args.max_hands):
            # 1. collect
            got = False
            if args.actors:
                try:
                    for _ in range(2 * args.actors):   # bounded: never starve the learner
                        batch, n = q.get(timeout=0.05 if replay.n >= args.min_buffer else 2.0)
                        replay.add(batch)
                        hands_total += n
                        owed += len(batch) * args.replay_ratio
                        new_dec += len(batch)
                        got = True
                        if q.empty():
                            break
                except queue_mod.Empty:
                    pass
            else:
                net.eval()
                snaps = _load_snapshots(out, local_cache, keep=8)
                models = dict(local_cache)
                models.update(local_models)
                batch, n = generate(pop, models, snaps, args.games, rng_py, device=device)
                replay.add(batch)
                hands_total += n
                owed += len(batch) * args.replay_ratio
                new_dec += len(batch)
                got = True
            # 2. learn
            # If the learner is slower than the actors, train less per sample
            # rather than fall ever further behind (data stays fresh).
            owed = min(owed, 64 * args.batch)
            if replay.n >= args.min_buffer:
                net.train()
                while owed >= args.batch:
                    s, a, g, b, o = replay.sample(args.batch, rng_np)
                    s, a = torch.from_numpy(s).to(device), torch.from_numpy(a).to(device)
                    g, b = torch.from_numpy(g).to(device), torch.from_numpy(b).to(device)
                    o = torch.from_numpy(o).to(device)
                    loss, parts = loss_fn(net, s, a, g, b, o, args.belief_weight)
                    opt.zero_grad(set_to_none=True)
                    loss.backward()
                    nn.utils.clip_grad_norm_(net.parameters(), 10.0)
                    opt.step()
                    steps += 1
                    owed -= args.batch
                    losses.append(parts)
                net.eval()
            now = time.time()
            # 3. publish weights to the actors
            if now - last_sync >= args.sync_sec:
                _atomic_save(net, out / "current.pt", meta())
                last_sync = now
            if now - last_log >= 30:
                lq, lv, lb, la = np.mean(losses, axis=0) if losses else (float("nan"),) * 4
                log({"t": round(now - t0), "hands": hands_total, "steps": steps, "buffer": replay.n,
                     "decisions_per_s": round(new_dec / (now - last_log)), "loss_q": round(float(lq), 4),
                     "loss_v": round(float(lv), 4), "loss_belief": round(float(lb), 4),
                     "loss_win_tranque": round(float(la), 4)})
                losses.clear()
                new_dec = 0
                last_log = now
            if now - last_snap >= args.snapshot_min * 60 and steps:
                _atomic_save(net, out / "snapshots" / f"s{steps:08d}.pt", meta())
                last_snap = now
            if now - last_eval >= args.eval_min * 60 and steps:
                res = evaluate(out, net, device, args.eval_deals, 4242, log)
                promote(out, net, res, meta(), args.export, log)
                last_eval = time.time()
            if not got and not args.actors:
                break
    finally:
        stop.set()
        _atomic_save(net, out / "current.pt", meta())
        res = evaluate(out, net, device, args.eval_deals, 4242, log)
        promote(out, net, res, meta(), args.export, log)
        for p in procs:
            p.terminate()
        logf.close()
        ladder.close()


def promote(out: Path, net: M.DomNet, res: dict, meta: dict, export: str, log) -> None:
    """Champion gate: must beat the champion (or, first time, the greedy player)
    on duplicate deals with the whole 95% interval above zero, in both formats."""
    champ = out / "champion.pt"
    keys = ("patio_vs_champion", "mano_vs_champion") if champ.exists() else ("patio_vs_greedy", "mano_vs_greedy")
    if all(res.get(k, {}).get("lo", -1) > 0 for k in keys):
        meta = dict(meta, promoted_on={k: res[k] for k in keys}, eval=res)
        _atomic_save(net, champ, meta)
        M.export_json(net, out / "dominord-net.json", meta)
        if export:
            M.export_json(net, Path(export), meta)
        log({"promoted": True, "by": {k: round(res[k]["margin"], 2) for k in keys}, "hands": meta["hands"]})


if __name__ == "__main__":
    main()
