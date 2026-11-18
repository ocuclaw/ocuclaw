"""The page check Hermes runs before a watched-page Task (#5039 trap D).

Hermes compares a monitor source's exact output on every tick, and runs the
model only when it changed. Raw HTML differs on each load (nonces, session
ids, build hashes), so OcuClaw gives Hermes this script instead of the URL. It
fetches the page and prints only its visible text, so the comparison sees what
a person sees.

``task_page_watch`` copies this file into ``<HERMES_HOME>/scripts`` and
Hermes runs it with no arguments in the Task's own folder, which holds:

* ``url.txt``: the page to watch (written by OcuClaw).
* ``current.txt`` / ``prior.txt``: this check's text and the one before, so
  OcuClaw can put Hermes's snapshot back when a model run fails (trap F).
* ``state.json``: the last check's outcome, so a dead link shows its real
  reason instead of Hermes's model-timeout copy (trap E).

Standard library only: Hermes runs it with its own Python.

Only public addresses (DeepSec finding_5c829641ac22e1ce). A watched page is
any web link, so the check must not become a way into the Hermes host's own
network. Every connection, the first and each redirect hop, resolves its host
once, refuses it when any answer is loopback, private, link-local, shared,
reserved or multicast, and connects to the address it checked, so a DNS answer
that changes between the check and the connect cannot reach a private
service. Proxies from the environment are not used: through a proxy the
address this script checks is the proxy's, not the page's. An operator who
really wants a page on their own network watched sets
``OCUCLAW_PAGE_WATCH_PRIVATE=allow`` in the Hermes environment.
"""

from __future__ import annotations

import http.client
import ipaddress
import json
import os
import socket
import ssl
import sys
import tempfile
import time
import urllib.error
import urllib.request
from html.parser import HTMLParser

URL_FILENAME = "url.txt"
CURRENT_FILENAME = "current.txt"
PRIOR_FILENAME = "prior.txt"
STATE_FILENAME = "state.json"

TIMEOUT_SECONDS = 30
#: Big pages put their text after a lot of markup; Hermes's own URL fetch cut at 256 KiB.
MAX_BYTES = 2 * 1024 * 1024
MAX_TEXT_CHARS = 100_000
USER_AGENT = "Mozilla/5.0 (compatible; OcuClaw page watch)"

# Never visible: their text is code, styles or drawing metadata.
_SKIP = {"script", "style", "noscript", "template", "svg", "math", "iframe", "object", "canvas", "select"}
# Text that a person reads as a separate line.
_BLOCK = {
    "address", "article", "aside", "blockquote", "br", "dd", "div", "dl", "dt", "fieldset",
    "figcaption", "figure", "footer", "form", "h1", "h2", "h3", "h4", "h5", "h6", "header",
    "hr", "li", "main", "nav", "ol", "p", "pre", "section", "table", "td", "th", "title",
    "tr", "ul",
}
_VOID = {"area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta", "param",
         "source", "track", "wbr"}


class _Text(HTMLParser):
    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.lines = [[]]
        # Open tags inside a hidden part; text shows again once its first tag closes.
        self.skip = []

    def _break(self):
        if self.lines[-1]:
            self.lines.append([])

    def handle_starttag(self, tag, attrs):
        if self.skip or tag in _SKIP or any(name == "hidden" for name, _ in attrs):
            if tag not in _VOID:
                self.skip.append(tag)
            return
        if tag in _BLOCK:
            self._break()

    def handle_startendtag(self, tag, attrs):
        if not self.skip and tag in _BLOCK:
            self._break()

    def handle_endtag(self, tag):
        if self.skip:
            # An unclosed tag inside a hidden part must not hide the rest of the page.
            if tag in self.skip:
                while self.skip.pop() != tag:
                    pass
            return
        if tag in _BLOCK:
            self._break()

    def handle_data(self, data):
        if not self.skip:
            self.lines[-1].extend(data.split())

    def text(self):
        return "\n".join(" ".join(words) for words in self.lines if words)


def page_text(body: bytes, content_type: str = "") -> str:
    """What a person reads on the page: visible text, one block per line.

    JSON is printed with sorted keys so a key order change is not a change.
    Other non-HTML text is kept with its whitespace collapsed per line.
    """
    kind, charset = _content_type(content_type)
    text = body.decode(charset or _sniff_charset(body) or "utf-8", errors="replace")
    if kind.endswith("json"):
        try:
            return _clip(json.dumps(json.loads(text), sort_keys=True, indent=1, ensure_ascii=False))
        except ValueError:
            pass
    if "html" in kind or "xml" in kind or (not kind and text.lstrip()[:1] == "<"):
        parser = _Text()
        try:
            parser.feed(text)
            parser.close()
        except Exception:
            pass
        return _clip(parser.text())
    return _clip("\n".join(" ".join(line.split()) for line in text.splitlines() if line.strip()))


def _clip(text: str) -> str:
    return text if len(text) <= MAX_TEXT_CHARS else text[:MAX_TEXT_CHARS]


def _content_type(value: str):
    parts = [part.strip() for part in (value or "").split(";")]
    kind = parts[0].lower() if parts else ""
    charset = None
    for part in parts[1:]:
        if part.lower().startswith("charset="):
            charset = part.split("=", 1)[1].strip().strip("\"'") or None
    if charset:
        try:
            "".encode(charset)
        except LookupError:
            charset = None
    return kind, charset


def _sniff_charset(body: bytes):
    head = body[:2048].decode("ascii", errors="ignore").lower()
    at = head.find("charset=")
    if at < 0:
        return None
    name = head[at + 8:].lstrip("\"' ")
    name = name[: next((i for i, ch in enumerate(name) if not (ch.isalnum() or ch in "-_")), len(name))]
    try:
        "".encode(name)
    except LookupError:
        return None
    return name or None


def failure_reason(exc: BaseException) -> str:
    """Why the page could not be read, in words a wearer can act on."""
    if isinstance(exc, urllib.error.HTTPError):
        return f"the site answered {exc.code}{' ' + exc.reason if isinstance(exc.reason, str) and exc.reason else ''}"
    cause = exc.reason if isinstance(exc, urllib.error.URLError) else exc
    if isinstance(cause, PrivateAddressError):
        return "the page is on a private or local address, which OcuClaw does not watch"
    if isinstance(cause, ConnectionRefusedError):
        return "the site refused the connection"
    if isinstance(cause, socket.gaierror):
        return "the site's address was not found"
    if isinstance(cause, (socket.timeout, TimeoutError)):
        return "the site took too long to answer"
    if isinstance(cause, ssl.SSLError):
        return "the site's security certificate did not check out"
    if isinstance(cause, (ConnectionResetError, ConnectionAbortedError)):
        return "the site closed the connection"
    if isinstance(exc, ValueError):
        return "the page link is not valid"
    return "the page could not be loaded"


#: Set to ``allow`` in the Hermes environment to watch pages on the host's own network.
PRIVATE_ENV = "OCUCLAW_PAGE_WATCH_PRIVATE"
MAX_REDIRECTS = 5


class PrivateAddressError(OSError):
    """The page, or a page it redirected to, is on a private or local address."""


def address_allowed(ip: str) -> bool:
    """True only for a public unicast address (IPv4-mapped IPv6 is judged as its IPv4)."""
    try:
        address = ipaddress.ip_address(str(ip).split("%", 1)[0])
    except ValueError:
        return False
    if isinstance(address, ipaddress.IPv6Address) and address.ipv4_mapped is not None:
        address = address.ipv4_mapped
    return bool(address.is_global and not (address.is_multicast or address.is_reserved
                                           or address.is_loopback or address.is_link_local
                                           or address.is_private or address.is_unspecified))


def _private_allowed() -> bool:
    return os.environ.get(PRIVATE_ENV, "").strip().lower() == "allow"


def _checked_connection(address, timeout=socket._GLOBAL_DEFAULT_TIMEOUT, source_address=None, *args, **kwargs):
    """Resolve once, refuse any private answer, then connect to an address that was checked."""
    host, port = address[0], address[1]
    answers = socket.getaddrinfo(host, port, 0, socket.SOCK_STREAM)
    ips = [info[4][0] for info in answers]
    if not ips:
        raise socket.gaierror(socket.EAI_NONAME, "no address")
    if not _private_allowed() and not all(address_allowed(ip) for ip in ips):
        raise PrivateAddressError(f"refused a private or local address for {host}")
    last = None
    for ip in dict.fromkeys(ips):
        try:
            return socket.create_connection((ip, port), timeout, source_address)
        except OSError as exc:
            last = exc
    raise last


class _CheckedHTTPConnection(http.client.HTTPConnection):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, **kwargs)
        self._create_connection = _checked_connection


class _CheckedHTTPSConnection(http.client.HTTPSConnection):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, **kwargs)
        self._create_connection = _checked_connection


class _CheckedHTTPHandler(urllib.request.HTTPHandler):
    def http_open(self, req):
        return self.do_open(_CheckedHTTPConnection, req)


class _CheckedHTTPSHandler(urllib.request.HTTPSHandler):
    def https_open(self, req):
        return self.do_open(_CheckedHTTPSConnection, req, context=self._context)


class _Redirects(urllib.request.HTTPRedirectHandler):
    max_redirections = MAX_REDIRECTS


def _opener():
    # Built by hand, not build_opener: no ProxyHandler (a proxy hides the page's
    # address), no file: or ftp: handlers. Each redirect hop opens through the
    # same checked handlers, so every hop's address is checked before it connects.
    opener = urllib.request.OpenerDirector()
    for handler in (urllib.request.UnknownHandler(), _CheckedHTTPHandler(), _CheckedHTTPSHandler(),
                    urllib.request.HTTPDefaultErrorHandler(), _Redirects(),
                    urllib.request.HTTPErrorProcessor()):
        opener.add_handler(handler)
    return opener


def fetch(url: str):
    if not url.lower().startswith(("http://", "https://")):
        raise ValueError("not http(s)")
    request = urllib.request.Request(url, headers={"User-Agent": USER_AGENT,
                                                   "Accept": "text/html,application/json;q=0.9,*/*;q=0.5"})
    with _opener().open(request, timeout=TIMEOUT_SECONDS) as response:  # nosec B310: scheme and address checked
        body = response.read(MAX_BYTES + 1)[:MAX_BYTES]
        return body, response.headers.get("Content-Type", "")


def _write(path: str, text: str) -> None:
    folder = os.path.dirname(os.path.abspath(path))
    fd, tmp = tempfile.mkstemp(prefix=".page-watch.", dir=folder)
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as handle:
            handle.write(text)
        os.replace(tmp, path)
    except BaseException:
        try:
            os.unlink(tmp)
        except OSError:
            pass
        raise


def _read(path: str):
    try:
        with open(path, encoding="utf-8") as handle:
            return handle.read()
    except OSError:
        return None


def run(folder: str = ".", *, fetcher=fetch, now=time.time) -> int:
    try:
        url = (_read(os.path.join(folder, URL_FILENAME)) or "").strip()
        body, content_type = fetcher(url)
        text = page_text(body, content_type)
    except Exception as exc:
        reason = failure_reason(exc)
        _write(os.path.join(folder, STATE_FILENAME), json.dumps({"ok": False, "error": reason, "at": now()}))
        sys.stderr.write(f"Watched page unavailable: {reason}\n")
        return 1
    previous = _read(os.path.join(folder, CURRENT_FILENAME))
    if previous is not None:
        _write(os.path.join(folder, PRIOR_FILENAME), previous)
    _write(os.path.join(folder, CURRENT_FILENAME), text)
    _write(os.path.join(folder, STATE_FILENAME), json.dumps({"ok": True, "error": None, "at": now()}))
    sys.stdout.write(text)
    return 0


if __name__ == "__main__":
    sys.exit(run())
