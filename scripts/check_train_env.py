"""Is this Python ready to train on the GPU?  Used by train_gpu.bat.

Exit codes (the .bat branches on them):
  0  ready: numpy, and a torch that actually runs kernels on the CUDA card
  10 numpy missing (torch is fine)
  20 torch missing, CPU-only, or built without kernels for this card
     (a GTX 10xx is sm_61; recent CUDA 12.8+/13 wheels dropped it)
"""

from __future__ import annotations

import sys


def main() -> int:
    print(f"  Python {sys.version.split()[0]} at {sys.executable}")
    if sys.version_info < (3, 10):
        print("  !! Python 3.10 or newer is required")
        return 30
    try:
        import torch
    except ImportError:
        print("  torch: not installed")
        return 20
    print(f"  torch {torch.__version__} (CUDA build: {torch.version.cuda or 'none, CPU-only'})")
    if not torch.cuda.is_available():
        print("  torch cannot see a CUDA GPU")
        return 20
    name = torch.cuda.get_device_name(0)
    major, minor = torch.cuda.get_device_capability(0)
    print(f"  GPU: {name} (compute {major}.{minor}, {torch.cuda.get_device_properties(0).total_memory / 2**30:.1f} GB)")
    try:
        # A real kernel, not just is_available(): a wheel without sm_61 still
        # "sees" a GTX 1070 and only fails here ("no kernel image").
        x = torch.randn(256, 256, device="cuda")
        y = torch.nn.functional.relu(x @ x).sum().item()
        assert y == y
    except Exception as e:  # noqa: BLE001
        print(f"  !! the GPU is visible but torch cannot run on it: {str(e).splitlines()[0]}")
        print(f"     this torch build supports: {' '.join(torch.cuda.get_arch_list())}")
        return 20
    try:
        import numpy
    except ImportError:
        print("  numpy: not installed")
        return 10
    print(f"  numpy {numpy.__version__}")
    print("  ready to train on the GPU")
    return 0


if __name__ == "__main__":
    sys.exit(main())
