"""The training environment and the network plumbing agree with everything else.

* dominord/train/env.py plays exactly like dominord.state.HandState and scores
  like dominord.scoring (2v2 presets);
* its rule presets are the ones in web/engine.js;
* features.py and engine.js encode every decision identically, across every
  preset including 1v1 with drawing;
* an exported network gives the same Q in JS as in numpy.

The JS checks need ``node``; the feature/network checks need numpy/torch.
"""

from __future__ import annotations

import json
import random
import shutil
import subprocess
from pathlib import Path

import pytest

from dominord.rules import PRESETS as PY_PRESETS
from dominord.scoring import score_hand
from dominord.state import End, HandState, Pass, Play
from dominord.tiles import Tile
from dominord.train import env as E

ROOT = Path(__file__).resolve().parents[1]
ENGINE = ROOT / "web" / "engine.js"
node = shutil.which("node")


def _to_py(m: int, player: int):
    if m == E.PASS:
        return Pass(player)
    t = m >> 1
    return Play(player, Tile(E.LOW[t], E.HIGH[t]), End.RIGHT if m & 1 else End.LEFT)


@pytest.mark.parametrize("preset", ["patio", "formal"])
def test_env_plays_and_scores_like_the_python_engine(preset):
    rng = random.Random(7)
    rules_js = E.make_rules(preset)
    for _ in range(300):
        g = E.new_game(rules_js, rng)
        deal = [{Tile(E.LOW[t], E.HIGH[t]) for t in E.bits(h)} for h in g.hands[:4]]
        st = HandState.from_deal(deal, PY_PRESETS[preset], opener=g.opener)
        if g.forced >= 0:
            st.force_open_tile(Tile(E.LOW[g.forced], E.HIGH[g.forced]))
        while not g.is_over():
            legal = g.legal()
            want = [_to_py(m, g.turn) for m in legal]
            assert [str(m) for m in st.legal_moves()] == [str(m) for m in want]
            m = rng.choice(legal)
            g.step(m)
            st.apply(_to_py(m, st.turn))
        assert st.is_over()
        res = score_hand(st)
        value, kind, team = g.result()
        signed = 0 if res.winning_team is None else (res.points if res.winning_team == 0 else -res.points)
        assert value == signed
        assert kind == res.kind


def _node(script: str, payload) -> object:
    out = subprocess.run([node, "-e", script], input=json.dumps(payload), capture_output=True,
                         text=True, check=True, cwd=ROOT)
    return json.loads(out.stdout)


@pytest.mark.skipif(node is None, reason="node not installed")
def test_rule_presets_match_the_browser_engine():
    js = _node("const D=require('./web/engine.js');process.stdout.write(JSON.stringify(D.PRESETS))", None)
    for name, rules in E.PRESETS.items():
        assert js[name] == E.make_rules(name), name


def _trajectories(n_games: int, seed: int):
    rng = random.Random(seed)
    out = []
    for i in range(n_games):
        name = list(E.PRESETS)[i % len(E.PRESETS)]
        rules = E.make_rules(name)
        g = E.new_game(rules, rng)
        rec = {"preset": name, "hands": g.hands[:g.n], "pozo": g.pozo, "opener": g.opener,
               "forced": g.forced, "steps": []}
        while not g.is_over():
            legal = g.legal()
            m = rng.choice(legal)
            rec["steps"].append({"legal": legal, "move": m})
            g.step(m)
        rec["result"] = g.result()[0]
        out.append(rec)
    return out


JS_REPLAY = r"""
const D = require('./web/engine.js');
const recs = JSON.parse(require('fs').readFileSync(0, 'utf8'));
const out = [];
for (const r of recs) {
  const st = new D.State(D.makeRules(r.preset));
  r.hands.forEach((h, s) => { st.hands[s] = h; });
  st.pozo.set(r.pozo); st.pozoLen = r.pozo.length;
  st.turn = st.opener = r.opener; st.forced = r.forced; st.rehash();
  const sf = new Float32Array(D.STATE_DIM), af = new Float32Array(D.ACTION_DIM);
  const steps = [];
  for (const s of r.steps) {
    const legal = st.moves();
    steps.push({ legal, state: Array.from(D.stateFeatures(st, st.turn, sf)),
                 actions: s.legal.map((m) => Array.from(D.actionFeatures(st, m, af))) });
    st.apply(s.move);
    if (st.chainLen === 1 && st.forced >= 0) st.forced = -1;
  }
  out.push({ steps, over: st.isOver(), result: D.terminalValue(st) });
}
process.stdout.write(JSON.stringify(out));
"""


@pytest.mark.skipif(node is None, reason="node not installed")
def test_features_are_identical_in_python_and_javascript():
    np = pytest.importorskip("numpy")
    from dominord.train.features import action_features, state_features

    recs = _trajectories(60, 11)
    js = _node(JS_REPLAY, recs)
    rng = random.Random(11)
    decisions = 0
    for rec, jr in zip(recs, js):
        g = E.Game(E.make_rules(rec["preset"]), rec["hands"], rec["pozo"], rec["opener"], rec["forced"])
        for step, jstep in zip(rec["steps"], jr["steps"]):
            assert jstep["legal"] == step["legal"]
            np.testing.assert_allclose(jstep["state"], state_features(g, g.turn), atol=1e-6)
            for m, ja in zip(step["legal"], jstep["actions"]):
                np.testing.assert_allclose(ja, action_features(g, m), atol=1e-6)
            g.step(step["move"])
            decisions += 1
        assert jr["over"] and jr["result"] == rec["result"]
    assert decisions > 1000
    del rng


@pytest.mark.skipif(node is None, reason="node not installed")
def test_exported_network_gives_the_same_q_in_javascript(tmp_path):
    pytest.importorskip("torch")
    import numpy as np
    import torch

    from dominord.train import model as M
    from dominord.train.features import action_features, state_features

    torch.manual_seed(3)
    net = M.DomNet(64, 32)
    path = tmp_path / "net.json"
    M.export_json(net, path)
    doc = json.loads(path.read_text())
    rec = _trajectories(1, 5)[0]
    g = E.Game(E.make_rules(rec["preset"]), rec["hands"], rec["pozo"], rec["opener"], rec["forced"])
    cases = []
    for step in rec["steps"][:12]:
        s = state_features(g, g.turn)
        for m in step["legal"]:
            a = action_features(g, m)
            with torch.no_grad():
                tq = net.q_values(torch.from_numpy(s[None]), torch.from_numpy(a[None]), torch.tensor([0])).item()
            cases.append({"s": s.tolist(), "a": a.tolist(), "q": M.numpy_q(doc, s, a), "torch": tq})
        g.step(step["move"])
    script = r"""
const D = require('./web/engine.js');
const {doc, cases} = JSON.parse(require('fs').readFileSync(0, 'utf8'));
const net = new D.Net(doc);
process.stdout.write(JSON.stringify(cases.map((c) => { net.trunk(Float32Array.from(c.s)); return net.q(Float32Array.from(c.a)) / net.scale; })));
"""
    js = _node(script, {"doc": doc, "cases": cases})
    for c, q in zip(cases, js):
        assert abs(c["q"] - c["torch"]) < 1e-4
        assert abs(q - c["q"]) < 1e-4
    assert np.isfinite(js).all()


@pytest.mark.skipif(node is None, reason="node not installed")
def test_every_head_matches_in_javascript(tmp_path):
    """V, P(win), P(tranque) and the belief logits: torch vs web/engine.js."""
    pytest.importorskip("torch")
    import torch

    from dominord.train import model as M
    from dominord.train.features import state_features

    torch.manual_seed(4)
    net = M.DomNet(64, 32).eval()
    path = tmp_path / "net.json"
    M.export_json(net, path)
    doc = json.loads(path.read_text())
    rec = _trajectories(2, 9)[1]
    g = E.Game(E.make_rules(rec["preset"]), rec["hands"], rec["pozo"], rec["opener"], rec["forced"])
    cases = []
    for step in rec["steps"][:10]:
        s = state_features(g, (g.turn + 1) % g.n)
        with torch.no_grad():
            h = net.trunk(torch.from_numpy(s[None]))
            cases.append({"s": s.tolist(), "v": net.v(h).item() * M.VALUE_SCALE,
                          "aux": torch.sigmoid(net.aux(h))[0].tolist(), "belief": net.belief(h)[0].tolist()})
        g.step(step["move"])
    script = r"""
const D = require('./web/engine.js');
const {doc, cases} = JSON.parse(require('fs').readFileSync(0, 'utf8'));
const net = new D.Net(doc);
process.stdout.write(JSON.stringify(cases.map((c) => {
  net.trunk(Float32Array.from(c.s));
  return { v: net.value(), aux: net.aux(), belief: Array.from(net.beliefLogits()) };
})));
"""
    js = _node(script, {"doc": doc, "cases": cases})
    for c, j in zip(cases, js):
        assert abs(c["v"] - j["v"]) < 1e-3
        assert max(abs(x - y) for x, y in zip(c["aux"], j["aux"])) < 1e-5
        assert max(abs(x - y) for x, y in zip(c["belief"], j["belief"])) < 1e-4
