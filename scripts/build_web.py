"""Bundle web/ into one self-contained HTML file.

    python3 scripts/build_web.py

Writes two files:

* ``dist/dominord-mesa.html`` - a complete page; open it straight from disk,
  host it anywhere, or send it to someone.  No server, no network except the
  Google Fonts stylesheet (it falls back to system fonts offline).
* ``dist/dominord-mesa.fragment.html`` - the same page without the
  doctype/html/head/body wrapper, for hosts that add their own skeleton.

The engine is inlined as ``<script id="engine-src">`` so the page can both run
it and hand its source to a Web Worker.
"""

from __future__ import annotations

import re
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
WEB = ROOT / "web"
DIST = ROOT / "dist"


def _script(text: str, name: str) -> str:
    if "</script" in text.lower():
        raise SystemExit(f"{name} contains '</script' and cannot be inlined")
    return text


def build() -> tuple[Path, Path]:
    html = (WEB / "index.html").read_text(encoding="utf-8")
    css = (WEB / "style.css").read_text(encoding="utf-8")
    engine = _script((WEB / "engine.js").read_text(encoding="utf-8"), "engine.js")
    app = _script((WEB / "app.js").read_text(encoding="utf-8"), "app.js")

    html = html.replace('<link rel="stylesheet" href="style.css">', f"<style>\n{css}</style>")
    html = html.replace('<script src="engine.js" id="engine-file"></script>',
                        f'<script id="engine-src">\n{engine}</script>')
    html = html.replace('<script src="app.js"></script>', f"<script>\n{app}</script>")
    for needle in ('href="style.css"', 'src="engine.js"', 'src="app.js"'):
        if needle in html:
            raise SystemExit(f"build left an external reference: {needle}")

    DIST.mkdir(exist_ok=True)
    full = DIST / "dominord-mesa.html"
    full.write_text(html, encoding="utf-8")

    # Fragment: head contents (minus charset/viewport) followed by the body.
    head = re.search(r"<head>(.*?)</head>", html, re.S).group(1)
    head = re.sub(r'<meta charset="utf-8">\s*', "", head)
    head = re.sub(r'<meta name="viewport"[^>]*>\s*', "", head)
    body = re.search(r"<body>(.*?)</body>", html, re.S).group(1)
    frag = DIST / "dominord-mesa.fragment.html"
    frag.write_text(head.strip() + "\n" + body.strip() + "\n", encoding="utf-8")
    return full, frag


if __name__ == "__main__":
    for path in build():
        print(f"{path.relative_to(ROOT)}  {path.stat().st_size / 1024:.0f} KB")
