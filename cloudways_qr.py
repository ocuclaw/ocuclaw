"""A terminal QR code for a link, drawn with OcuClaw's own QR encoder (#3483).

Step 5 prints Tailscale's approval link. Typing it into a phone by hand is the
slow part (Tailscale's own ``--qr`` prints nothing on Cloudways), so the step
draws it as a code the phone's camera can open.

No third-party Python QR library. The module matrix comes from the SAME encoder
the pairing QR uses, ``domain/pairing/qr-matrix`` in the OcuClaw plugin, which
ships in this bundle as ``dist-cjs/domain/pairing/qr-matrix.cjs`` and runs on
the Node the runtime already needs. The half-block drawing below is a line for
line port of ``renderMatrix`` in ``qr-terminal.ts`` (not exported there), with
the same glyphs, the same orientation rule and the same light padding row.

Everything here fails closed to "no code": a missing Node, a missing module, a
terminal that cannot show UTF-8, or one too small for the code. The caller then
prints the plain link, which always works. A code that wraps or garbles is
worse than none: the wearer would keep trying to photograph it.

Never used for a model sign-in. That link and code are Hermes's to print.
"""
from __future__ import annotations

import math
import shutil
import subprocess
from pathlib import Path
from typing import Any, Callable, List, Mapping, Optional, Sequence, Tuple

BUNDLE_DIR = Path(__file__).resolve().parent
QR_MATRIX_RELATIVE = Path("dist-cjs") / "domain" / "pairing" / "qr-matrix.cjs"

#: Where the encoder is: inside an installed bundle, then beside it in a repo
#: checkout (``extensions/ocuclaw-hermes`` next to ``extensions/ocuclaw``).
QR_MATRIX_CANDIDATES = (
    BUNDLE_DIR / QR_MATRIX_RELATIVE,
    BUNDLE_DIR.parent / "ocuclaw" / QR_MATRIX_RELATIVE,
)

NODE_TIMEOUT_S = 10.0

#: Reads the text from stdin (never argv: a process list is readable by other
#: users) and prints one row of 0/1 per module row.
_NODE_SCRIPT = (
    'const { qrMatrix } = require(process.argv[1]);'
    'let text = "";'
    'process.stdin.setEncoding("utf8");'
    'process.stdin.on("data", (chunk) => { text += chunk; });'
    'process.stdin.on("end", () => {'
    '  const m = qrMatrix(text);'
    '  process.stdout.write(m.map((row) => row.map((d) => (d ? "1" : "0")).join("")).join("\\n"));'
    '});'
)

#: Same glyphs as ``QR_TERMINAL_GLYPHS`` in qr-terminal.ts.
GLYPH_FULL = "█"
GLYPH_UPPER = "▀"
GLYPH_LOWER = "▄"
GLYPH_BLANK = " "

#: The smallest and largest matrices a real QR can have, quiet zone included.
_MIN_SIDE = 21 + 8
_MAX_SIDE = 177 + 8

Matrix = List[List[bool]]


def qr_matrix_module() -> Optional[Path]:
    for candidate in QR_MATRIX_CANDIDATES:
        if candidate.is_file():
            return candidate
    return None


def find_node() -> Optional[str]:
    try:
        from hermes_constants import find_node_executable

        found = find_node_executable("node")
        if found:
            return found
    except Exception:  # noqa: BLE001 - Hermes-version-sensitive helper
        pass
    return shutil.which("node")


def qr_matrix(
    text: str,
    *,
    runner: Optional[Callable[..., Any]] = None,
    node: Optional[str] = None,
    module: Optional[Path] = None,
    timeout_s: float = NODE_TIMEOUT_S,
) -> Optional[Matrix]:
    """The module matrix for ``text``, quiet zone included, or ``None``."""
    node = node or find_node()
    module = module or qr_matrix_module()
    if not node or module is None:
        return None
    run = subprocess.run if runner is None else runner
    try:
        completed = run(
            [node, "-e", _NODE_SCRIPT, str(module)],
            input=text,
            capture_output=True,
            text=True,
            timeout=timeout_s,
            check=False,
        )
    except Exception:  # noqa: BLE001 - no Node, a hang: no code, the link still works
        return None
    if getattr(completed, "returncode", 1) != 0:
        return None
    return _parse_matrix(str(getattr(completed, "stdout", "") or ""))


def _parse_matrix(output: str) -> Optional[Matrix]:
    rows = [row for row in output.strip().split("\n") if row]
    side = len(rows)
    if not (_MIN_SIDE <= side <= _MAX_SIDE):
        return None
    if any(len(row) != side or set(row) - {"0", "1"} for row in rows):
        return None
    return [[cell == "1" for cell in row] for row in rows]


def render_half_blocks(matrix: Sequence[Sequence[bool]], *, invert: bool = True) -> str:
    """``renderMatrix`` from qr-terminal.ts: two module rows per text row.

    ``invert`` True (the default) is the dark-background orientation: a LIGHT
    module is ink, so the printed code reads dark-on-light on a dark terminal.
    An odd-height matrix is padded with a LIGHT row, extending the quiet zone.
    """
    if not matrix:
        return ""
    width = len(matrix[0])
    lines: List[str] = []
    for r in range(0, len(matrix), 2):
        top = matrix[r]
        bottom = matrix[r + 1] if r + 1 < len(matrix) else None
        line = []
        for c in range(width):
            top_dark = c < len(top) and top[c] is True
            bottom_dark = bottom is not None and c < len(bottom) and bottom[c] is True
            top_ink = (not top_dark) if invert else top_dark
            bottom_ink = (not bottom_dark) if invert else bottom_dark
            if top_ink and bottom_ink:
                line.append(GLYPH_FULL)
            elif top_ink:
                line.append(GLYPH_UPPER)
            elif bottom_ink:
                line.append(GLYPH_LOWER)
            else:
                line.append(GLYPH_BLANK)
        lines.append("".join(line))
    return "\n".join(lines)


def fits(
    code: str,
    *,
    columns: int,
    rows: int,
    prefix_lines: Sequence[str] = (),
) -> bool:
    """``fits`` from pairing-bootstrap-presenter.ts, except unknown width is No.

    The presenter reserves the rows above the code (each wrapped at the
    terminal width) plus one line after it and the cursor row. An unknown
    width here means no code: the plain link that follows is always usable.
    """
    lines = code.split("\n")
    code_columns = len(lines[0]) if lines else 0
    if columns <= 0 or code_columns > columns:
        return False
    if rows <= 0:
        return True
    prefix_rows = sum(max(1, math.ceil(len(line) / columns)) for line in prefix_lines)
    return prefix_rows + len(lines) + 2 <= rows


def _terminal_size() -> Tuple[int, int]:
    try:
        size = shutil.get_terminal_size(fallback=(0, 0))
        return int(size.columns), int(size.lines)
    except Exception:  # noqa: BLE001 - unmeasurable is unknown
        return 0, 0


def _unicode_ok(stream_out: Any, stream_in: Any, env: Optional[Mapping[str, str]]) -> bool:
    # The pairing ceremony's own answer (#2505): the terminal is asked, and only
    # when it will not answer does the locale decide. Unknown is No.
    from .pairing import terminal_supports_unicode

    try:
        return bool(terminal_supports_unicode(stream_out, env, stream_in))
    except Exception:  # noqa: BLE001
        return False


def terminal_qr(
    text: str,
    *,
    stream_out: Any,
    stream_in: Any = None,
    env: Optional[Mapping[str, str]] = None,
    light_terminal: bool = False,
    prefix_lines: Sequence[str] = (),
    matrix_fn: Callable[[str], Optional[Matrix]] = qr_matrix,
    size_fn: Callable[[], Tuple[int, int]] = _terminal_size,
    unicode_fn: Optional[Callable[[], bool]] = None,
) -> Optional[str]:
    """The code for ``text`` if THIS terminal can show it whole, else ``None``."""
    try:
        if not bool(stream_out.isatty()):
            return None
    except Exception:  # noqa: BLE001 - an unaskable stream is not a terminal
        return None
    columns, rows = size_fn()
    if columns <= 0:
        return None
    ok = unicode_fn() if unicode_fn is not None else _unicode_ok(stream_out, stream_in, env)
    if not ok:
        return None
    matrix = matrix_fn(text)
    if not matrix:
        return None
    code = render_half_blocks(matrix, invert=not light_terminal)
    if not fits(code, columns=columns, rows=rows, prefix_lines=prefix_lines):
        return None
    return code


__all__ = [
    "QR_MATRIX_CANDIDATES",
    "fits",
    "qr_matrix",
    "qr_matrix_module",
    "render_half_blocks",
    "terminal_qr",
]
