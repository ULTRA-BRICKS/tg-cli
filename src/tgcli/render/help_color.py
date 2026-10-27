"""Minimal terminal coloring without changing help text."""

import os
import re
import sys

from tgcli.common.js_string import JS_WHITESPACE_PATTERN

RESET = "\x1b[0m"
BOLD = "\x1b[1m"
CYAN = "\x1b[36m"
GREEN = "\x1b[32m"
_WS = JS_WHITESPACE_PATTERN
_SECTION_HEADER = re.compile(
    r"^(\S[^\n]*:)(\s*)$".replace(r"\S", f"[^{_WS[1:-1]}]").replace(r"\s", _WS)
)
_OPTION_LEAD = re.compile(
    r"^(\s+)((?:-{1,2}[A-Za-z][\w-]*)(?:,\s+-{1,2}[A-Za-z][\w-]*)*)(?![\w-])".replace(r"\s", _WS),
    re.ASCII,
)


def should_colorize(*, is_tty: bool | None = None, no_color: bool | None = None) -> bool:
    tty = sys.stdout.isatty() if is_tty is None else is_tty
    no = bool(os.environ.get("NO_COLOR")) if no_color is None else no_color
    return tty and not no


def colorize_help(text: str, enabled: bool) -> str:
    if not enabled:
        return text
    out = []
    for line in text.split("\n"):
        header = _SECTION_HEADER.match(line)
        option = _OPTION_LEAD.match(line)
        if header:
            out.append(f"{BOLD}{CYAN}{header[1]}{RESET}{header[2]}")
        elif option:
            out.append(f"{option[1]}{GREEN}{option[2]}{RESET}{line[option.end() :]}")
        else:
            out.append(line)
    return "\n".join(out)
