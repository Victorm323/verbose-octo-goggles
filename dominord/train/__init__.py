"""Self-play training for dominord (optional; needs ``pip install -e ".[train]"``).

``env`` and ``bots`` are pure Python; ``features`` needs numpy; ``model``,
``selfplay`` and ``train`` need PyTorch.  Nothing in the core package imports
this one, so the engine itself stays dependency-free (CLAUDE.md invariant 7).
"""
