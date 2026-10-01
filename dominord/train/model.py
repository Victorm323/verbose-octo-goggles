"""The network: Q(infoset, move), V(infoset) and a belief head.

Deep Monte-Carlo (DouZero's method): Q is regressed straight onto the final
hand return of the move actually played, so there is no bootstrapping to go
unstable, and the policy is simply argmax Q.  The belief head predicts, for
every tile the acting seat cannot see, who holds it; it is trained on the true
deal and only shapes the shared trunk (it teaches the net to read passes and
choices), which is the cheapest way to make the Q head inference-aware.

The shape is deliberately small (≈150k weights) so the browser can run it
thousands of times inside a search; ``export_json`` writes the format
``web/engine.js`` loads.
"""

from __future__ import annotations

import base64
import json
from pathlib import Path

import numpy as np
import torch
from torch import nn

from .features import ACTION_DIM, STATE_DIM

#: Hand points are divided by this before regression (a hand is worth 0–200).
VALUE_SCALE = 50.0


class DomNet(nn.Module):
    def __init__(self, hidden: int = 256, qhidden: int = 128):
        super().__init__()
        self.hidden, self.qhidden = hidden, qhidden
        self.trunk = nn.Sequential(
            nn.Linear(STATE_DIM, hidden), nn.ReLU(),
            nn.Linear(hidden, hidden), nn.ReLU(),
        )
        self.q = nn.Sequential(nn.Linear(hidden + ACTION_DIM, qhidden), nn.ReLU(), nn.Linear(qhidden, 1))
        self.v = nn.Sequential(nn.Linear(hidden, 64), nn.ReLU(), nn.Linear(64, 1))
        self.belief = nn.Linear(hidden, 28 * 4)
        # P(our pair takes the hand), P(the hand ends in a tranque) — logits.
        self.aux = nn.Sequential(nn.Linear(hidden, 64), nn.ReLU(), nn.Linear(64, 2))

    def q_values(self, states: torch.Tensor, actions: torch.Tensor, idx: torch.Tensor) -> torch.Tensor:
        """Q for each action row; ``idx[i]`` is the state row action i belongs to."""
        h = self.trunk(states)
        return self.q(torch.cat([h[idx], actions], dim=1)).squeeze(1)

    def forward(self, states, actions):
        h = self.trunk(states)
        q = self.q(torch.cat([h, actions], dim=1)).squeeze(1)
        v = self.v(h).squeeze(1)
        b = self.belief(h).view(-1, 28, 4)
        return q, v, b, self.aux(h)


def device_auto(name: str = "auto") -> torch.device:
    if name != "auto":
        return torch.device(name)
    if torch.cuda.is_available():
        return torch.device("cuda")
    if getattr(torch.backends, "mps", None) and torch.backends.mps.is_available():
        return torch.device("mps")
    return torch.device("cpu")


def save(model: DomNet, path: Path, meta: dict | None = None) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    torch.save({"hidden": model.hidden, "qhidden": model.qhidden,
                "state": {k: v.detach().cpu() for k, v in model.state_dict().items()},
                "meta": meta or {}}, path)


def load(path: Path, device: torch.device | str = "cpu") -> DomNet:
    ck = torch.load(path, map_location="cpu", weights_only=True)
    m = DomNet(ck["hidden"], ck["qhidden"])
    # strict=False: checkpoints from before a head was added still load; the
    # new head starts untrained (see --init).
    m.load_state_dict(ck["state"], strict=False)
    return m.to(device).eval()


def export_json(model: DomNet, path: Path, meta: dict | None = None) -> None:
    """Weights for web/engine.js: float32 little-endian, base64, row-major [out, in].

    Every head is exported: Q (move values), V (expected points), aux (P win,
    P tranque) and belief (who holds each unseen tile).  ``temperature`` turns
    Q into move probabilities in the browser: softmax(Q / temperature).
    """
    layers = {}
    for name, t in model.state_dict().items():
        arr = t.detach().cpu().numpy().astype("<f4")
        layers[name] = {"shape": list(arr.shape), "data": base64.b64encode(arr.tobytes()).decode()}
    doc = {"format": "dominord-net/1", "stateDim": STATE_DIM, "actionDim": ACTION_DIM,
           "valueScale": VALUE_SCALE, "hidden": model.hidden, "qhidden": model.qhidden,
           "temperature": (meta or {}).get("temperature", 3.0),
           "layers": layers, "meta": meta or {}}
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(doc), encoding="utf-8")


def numpy_q(model_doc: dict, s: np.ndarray, a: np.ndarray) -> float:
    """Reference forward pass from an exported JSON (used by the JS test)."""
    L = {k: np.frombuffer(base64.b64decode(v["data"]), dtype="<f4").reshape(v["shape"])
         for k, v in model_doc["layers"].items()}
    relu = lambda x: np.maximum(x, 0)  # noqa: E731
    h = relu(L["trunk.0.weight"] @ s + L["trunk.0.bias"])
    h = relu(L["trunk.2.weight"] @ h + L["trunk.2.bias"])
    z = relu(L["q.0.weight"] @ np.concatenate([h, a]) + L["q.0.bias"])
    return float((L["q.2.weight"] @ z + L["q.2.bias"])[0])
