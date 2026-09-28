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
On a terminal that allows colour the code is drawn in explicit colours instead
(#3741), a port of ``renderMatrixColour``: a gap the terminal leaves between
rows then fills with the cell background, where plain glyphs would let the
terminal's own background stripe the code so it will not scan.

Everything here fails closed to "no code": a missing Node, a missing module, a
terminal that cannot show UTF-8, or one too small for the code. The caller then
prints the plain link, which always works. A code that wraps or garbles is
worse than none: the wearer would keep trying to photograph it.

Never used for a model sign-in. That link and code are Hermes's to print.
"""
from __future__ import annotations

import math
import os
import re
import shutil
import subprocess
import sys
from dataclasses import dataclass
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

#: Same SGR codes as ``QR_TERMINAL_ANSI`` / ``QR_TERMINAL_ANSI_INK`` in
#: qr-terminal.ts: explicit black and bright white, never the theme's colours.
ANSI_BACK_LIGHT = "\x1b[107m"
ANSI_BACK_DARK = "\x1b[40m"
ANSI_INK_LIGHT = "\x1b[97m"
ANSI_INK_DARK = "\x1b[30m"
ANSI_RESET = "\x1b[0m"

#: Same as ``QR_COLOUR_GLYPH_MODULE``: the glyph draws the lower module and the
#: cell background (which fills any row gap) the upper one. macOS Terminal puts
#: the gap above the glyph; the #3741 spike scanned only this form there.
COLOUR_GLYPH_MODULE = "lower"

_SGR = re.compile(r"\x1b\[[0-9;]*m")

#: The smallest and largest matrices a real QR can have, quiet zone included.
_MIN_SIDE = 21 + 8
_MAX_SIDE = 177 + 8

Matrix = List[List[bool]]

#: #3743. Which zoom-out keys the hint names. Shared with the OpenClaw side
#: word for word (the `zoom` capability the pairing ``create`` request sends).
ZOOM_MAC = "mac"
ZOOM_PC = "pc"
ZOOM_ANY = "any"

#: #3743. The hint shown in place of "QR cannot fit in this terminal." when the
#: code will be drawn by itself once the window is big enough. Exact strings,
#: the same on both engines.
HINT_NEED_TEMPLATE = "QR needs a {need_columns}x{need_rows} window; this one is {columns}x{rows}."
HINT_NEED_UNKNOWN_TEMPLATE = "QR needs a {need_columns}x{need_rows} window."
HINT_BIGGER_LINE = "Make the window bigger or zoom out, and the code will appear here."
HINT_ZOOM_LINES = {
    ZOOM_ANY: "Zoom out: Cmd+minus on Mac, Ctrl+minus on Windows and Linux.",
    ZOOM_MAC: "Zoom out: Cmd+minus.",
    ZOOM_PC: "Zoom out: Ctrl+minus.",
}

#: #3743. Rows a redrawn code needs beyond its own: the lead line above it,
#: one line after it and the cursor row.
REDRAW_EXTRA_ROWS = 3

#: #3743. The window is measured at least this often while a redraw waits.
REDRAW_TICK_S = 0.5


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


def render_half_blocks_colour(matrix: Sequence[Sequence[bool]]) -> str:
    """``renderMatrixColour`` from qr-terminal.ts (#3741).

    The size of :func:`render_half_blocks`. Every cell states both colours, so
    no orientation flag. Colour is restated only when it changes and reset at
    the end of every row. An odd height pads with a LIGHT row.
    """
    if not matrix:
        return ""
    width = len(matrix[0])
    upper = COLOUR_GLYPH_MODULE == "upper"
    glyph = GLYPH_UPPER if upper else GLYPH_LOWER
    lines: List[str] = []
    for r in range(0, len(matrix), 2):
        top = matrix[r]
        bottom = matrix[r + 1] if r + 1 < len(matrix) else None
        line: List[str] = []
        ink: Optional[str] = None
        back: Optional[str] = None
        for c in range(width):
            top_dark = c < len(top) and top[c] is True
            bottom_dark = bottom is not None and c < len(bottom) and bottom[c] is True
            glyph_dark = top_dark if upper else bottom_dark
            back_dark = bottom_dark if upper else top_dark
            next_back = ANSI_BACK_DARK if back_dark else ANSI_BACK_LIGHT
            # Both modules alike: a coloured space, no glyph edge to seam.
            same = glyph_dark == back_dark
            if not same:
                next_ink = ANSI_INK_DARK if glyph_dark else ANSI_INK_LIGHT
                if next_ink != ink:
                    line.append(next_ink)
                    ink = next_ink
            if next_back != back:
                line.append(next_back)
                back = next_back
            line.append(GLYPH_BLANK if same else glyph)
        line.append(ANSI_RESET)
        lines.append("".join(line))
    return "\n".join(lines)


def _visible_width(line: str) -> int:
    return len(_SGR.sub("", line))


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
    code_columns = _visible_width(lines[0]) if lines else 0
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


#: The window as ``(columns, rows)``; ``0`` is unknown. Public for callers that
#: watch the window while a redraw waits (#3743).
terminal_size = _terminal_size


def encoder_available() -> bool:
    """Whether a code can be drawn here at all: Node and the encoder module."""
    return qr_matrix_module() is not None and bool(find_node())


def zoom_key(env: Optional[Mapping[str, str]] = None, platform: Optional[str] = None) -> str:
    """#3743. Which zoom-out keys to name, from THIS process's environment.

    In order: a Mac terminal says so; Windows Terminal says so; over SSH the
    viewer's OS is unknown; then the platform itself; else both.
    """
    env = os.environ if env is None else env
    platform = sys.platform if platform is None else platform
    if env.get("TERM_PROGRAM") in ("Apple_Terminal", "iTerm.app"):
        return ZOOM_MAC
    if env.get("WT_SESSION"):
        return ZOOM_PC
    if any(name in env for name in ("SSH_CONNECTION", "SSH_CLIENT", "SSH_TTY")):
        return ZOOM_ANY
    if platform == "darwin":
        return ZOOM_MAC
    if platform == "win32":
        return ZOOM_PC
    if platform.startswith("linux") and ("DISPLAY" in env or "WAYLAND_DISPLAY" in env):
        return ZOOM_PC
    return ZOOM_ANY


def code_size(code: str) -> Tuple[int, int]:
    """``(columns, rows)`` a drawn code takes; escape codes take no columns."""
    if not code:
        return 0, 0
    lines = code.split("\n")
    return _visible_width(lines[0]), len(lines)


def hint_lines(
    code_columns: int, code_rows: int, columns: int, rows: int, zoom: str
) -> List[str]:
    """#3743. NEED, BIGGER, ZOOM, unindented. The window is what was measured."""
    need_rows = code_rows + REDRAW_EXTRA_ROWS
    if columns <= 0 or rows <= 0:
        need = HINT_NEED_UNKNOWN_TEMPLATE.format(need_columns=code_columns, need_rows=need_rows)
    else:
        need = HINT_NEED_TEMPLATE.format(
            need_columns=code_columns, need_rows=need_rows, columns=columns, rows=rows
        )
    return [need, HINT_BIGGER_LINE, HINT_ZOOM_LINES.get(zoom, HINT_ZOOM_LINES[ZOOM_ANY])]


def redraw_fits(code_columns: int, code_rows: int, columns: int, rows: int) -> bool:
    """#3743's fit rule for a redraw: the code, a lead line, one after, the cursor.

    Unknown columns never fit (a code that wraps will not scan); unknown rows
    do, as :func:`fits` treats them.
    """
    if columns <= 0 or code_columns > columns:
        return False
    return rows <= 0 or code_rows + REDRAW_EXTRA_ROWS <= rows


def render_code(matrix: Sequence[Sequence[bool]], *, colour: bool, light_terminal: bool) -> str:
    """The pairing presenter's choice: explicit colours, else plain half-blocks."""
    if colour:
        return render_half_blocks_colour(matrix)
    return render_half_blocks(matrix, invert=not light_terminal)


@dataclass
class PendingQr:
    """#3743. A code that was drawn but withheld because the window is too small.

    ``fits`` is the first draw's answer (with the rows it shares the screen
    with); ``columns`` / ``rows`` are the window measured then. The caller
    shows :meth:`hint_lines`, then :func:`sleep_watching` redraws it once the
    window grows.
    """

    code: str
    fits: bool
    columns: int
    rows: int
    size_fn: Callable[[], Tuple[int, int]] = _terminal_size
    zoom: str = ZOOM_ANY

    @property
    def code_columns(self) -> int:
        return code_size(self.code)[0]

    @property
    def code_rows(self) -> int:
        return code_size(self.code)[1]

    def hint_lines(self) -> List[str]:
        return hint_lines(self.code_columns, self.code_rows, self.columns, self.rows, self.zoom)

    def fits_now(self) -> bool:
        """Fits by the redraw rule AND the window changed since it was withheld.

        The first draw's check is stricter (it counts the rows around the
        code), so an unchanged window can pass the redraw rule at once; nobody
        resized, so nothing is redrawn.
        """
        try:
            columns, rows = self.size_fn()
            columns, rows = int(columns), int(rows)
        except Exception:  # noqa: BLE001 - unmeasurable is unknown, never a fit
            return False
        if (columns, rows) == (self.columns, self.rows):
            return False
        return redraw_fits(self.code_columns, self.code_rows, columns, rows)


def sleep_watching(
    seconds: float,
    pending: Optional[PendingQr],
    *,
    sleep_fn: Callable[[float], None],
    draw_fn: Callable[[PendingQr], None],
    tick_s: float = REDRAW_TICK_S,
) -> Optional[PendingQr]:
    """Sleep ``seconds``, measuring the window every ``tick_s`` while a code waits.

    On the first tick that fits, ``draw_fn`` prints it and the rest of the
    sleep runs in one piece. Returns what still waits: ``None`` once drawn.
    Never reads the keyboard, so whatever ends the caller's wait still does.
    """
    if pending is None:
        sleep_fn(seconds)
        return None
    remaining = max(0.0, float(seconds))
    while True:
        tick = min(tick_s, remaining)
        sleep_fn(tick)
        remaining -= tick
        if pending.fits_now():
            draw_fn(pending)
            if remaining > 0:
                sleep_fn(remaining)
            return None
        if remaining <= 0:
            return pending


def _unicode_ok(stream_out: Any, stream_in: Any, env: Optional[Mapping[str, str]]) -> bool:
    # The pairing ceremony's own answer (#2505): the terminal is asked, and only
    # when it will not answer does the locale decide. Unknown is No.
    from .pairing import terminal_supports_unicode

    try:
        return bool(terminal_supports_unicode(stream_out, env, stream_in))
    except Exception:  # noqa: BLE001
        return False


def _color_ok(stream_out: Any, env: Optional[Mapping[str, str]]) -> bool:
    # The pairing ceremony's answer, so NO_COLOR and TERM=dumb are honoured.
    from .pairing import terminal_supports_color

    try:
        return bool(terminal_supports_color(stream_out, env))
    except Exception:  # noqa: BLE001
        return False


def prepare_terminal_qr(
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
    color_fn: Optional[Callable[[], bool]] = None,
    platform: Optional[str] = None,
) -> Optional[PendingQr]:
    """The drawn code for ``text`` and whether it fits now (#3743).

    ``None`` means no code can be shown here at all: not a terminal, no UTF-8,
    no encoder. A result with ``fits`` False was withheld for SIZE only (an
    unknown width included), which is the one case worth redrawing.
    """
    try:
        if not bool(stream_out.isatty()):
            return None
    except Exception:  # noqa: BLE001 - an unaskable stream is not a terminal
        return None
    ok = unicode_fn() if unicode_fn is not None else _unicode_ok(stream_out, stream_in, env)
    if not ok:
        return None
    matrix = matrix_fn(text)
    if not matrix:
        return None
    color = color_fn() if color_fn is not None else _color_ok(stream_out, env)
    code = render_code(matrix, colour=color, light_terminal=light_terminal)
    columns, rows = size_fn()
    return PendingQr(
        code=code,
        fits=fits(code, columns=columns, rows=rows, prefix_lines=prefix_lines),
        columns=columns,
        rows=rows,
        size_fn=size_fn,
        zoom=zoom_key(env, platform),
    )


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
    color_fn: Optional[Callable[[], bool]] = None,
) -> Optional[str]:
    """The code for ``text`` if THIS terminal can show it whole, else ``None``."""
    try:
        if not bool(stream_out.isatty()):
            return None
    except Exception:  # noqa: BLE001 - an unaskable stream is not a terminal
        return None
    columns, _rows = size_fn()
    if columns <= 0:
        return None
    prepared = prepare_terminal_qr(
        text,
        stream_out=stream_out,
        stream_in=stream_in,
        env=env,
        light_terminal=light_terminal,
        prefix_lines=prefix_lines,
        matrix_fn=matrix_fn,
        size_fn=size_fn,
        unicode_fn=unicode_fn,
        color_fn=color_fn,
    )
    if prepared is None or not prepared.fits:
        return None
    return prepared.code


__all__ = [
    "HINT_BIGGER_LINE",
    "PendingQr",
    "QR_MATRIX_CANDIDATES",
    "REDRAW_TICK_S",
    "code_size",
    "encoder_available",
    "fits",
    "hint_lines",
    "prepare_terminal_qr",
    "qr_matrix",
    "qr_matrix_module",
    "redraw_fits",
    "render_code",
    "render_half_blocks",
    "render_half_blocks_colour",
    "sleep_watching",
    "terminal_qr",
    "terminal_size",
    "zoom_key",
]
