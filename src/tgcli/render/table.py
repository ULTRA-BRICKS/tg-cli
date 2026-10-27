"""Delimited monospace grids and markdown pipe tables for Telegram."""

import re
from collections.abc import Callable, Sequence
from dataclasses import dataclass
from typing import Literal

from tgcli.common.js_string import JS_WHITESPACE_PATTERN, js_trim
from tgcli.common.text import utf16_len

TableKind = Literal["html", "boxed", "pipe", "none"]
_WIDE = re.compile(
    "[\U0001f000-\U0001faff\u2600-\u27bf\u2190-\u21ff\u2300-\u23ff\u3000-\u303f\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uac00-\ud7af]"
)
_SEPARATOR = re.compile("^[" + JS_WHITESPACE_PATTERN[1:-1] + "|:-]+$")
_HTML_TABLE = re.compile("<table(?:" + JS_WHITESPACE_PATTERN + "|>)", re.IGNORECASE | re.ASCII)


@dataclass(frozen=True)
class ParsedTable:
    rows: list[list[str]]
    has_wide: bool


@dataclass(frozen=True)
class TablePre:
    html: str
    has_wide: bool


@dataclass(frozen=True)
class PipeTable:
    html: str
    converted: bool


def escape_cell(s: str) -> str:
    return s.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")


def has_wide_glyph(s: str) -> bool:
    return _WIDE.search(s) is not None


def parse_table_rows(input: str) -> ParsedTable:
    rows = []
    has_wide = False
    for raw in input.split("\n"):
        line = raw.removesuffix("\r")
        if not js_trim(line):
            continue
        delimiter = "\t" if "\t" in line else "|" if "|" in line else None
        cells = [js_trim(c) for c in (line.split(delimiter) if delimiter else [line])]
        has_wide = has_wide or any(has_wide_glyph(c) for c in cells)
        rows.append(cells)
    return ParsedTable(rows, has_wide)


def render_table(rows: Sequence[Sequence[str]]) -> str:
    if not rows:
        return ""
    cols = max(len(row) for row in rows)
    grid = [list(row) + [""] * (cols - len(row)) for row in rows]
    widths = [max(1, *(utf16_len(row[c]) for row in grid)) for c in range(cols)]

    def bar(left: str, middle: str, right: str) -> str:
        return left + middle.join("─" * (w + 2) for w in widths) + right

    def line(cells: list[str]) -> str:
        return (
            "│ "
            + " │ ".join(cell + " " * (widths[c] - utf16_len(cell)) for c, cell in enumerate(cells))
            + " │"
        )

    out = [bar("┌", "┬", "┐"), line(grid[0])]
    if len(grid) > 1:
        out.append(bar("├", "┼", "┤"))
    out.extend(line(row) for row in grid[1:])
    out.append(bar("└", "┴", "┘"))
    return "\n".join(out)


def to_table_pre(input: str) -> TablePre:
    parsed = parse_table_rows(input)
    return TablePre(f"<pre>{escape_cell(render_table(parsed.rows))}</pre>", parsed.has_wide)


def _separator(line: str) -> bool:
    return "-" in line and "|" in line and _SEPARATOR.fullmatch(line) is not None


def detect_table_kind(body: str) -> TableKind:
    if not body:
        return "none"
    if _HTML_TABLE.search(body):
        return "html"
    if re.search("[┌┬┐└┴┘]", body):
        return "boxed"
    lines = body.split("\n")
    if sum("|" in line for line in lines) >= 2 and any(_separator(line) for line in lines):
        return "pipe"
    return "none"


def _pipe_row(line: str) -> list[str]:
    cells = [js_trim(c) for c in line.split("|")]
    if cells and cells[0] == "":
        cells.pop(0)
    if cells and cells[-1] == "":
        cells.pop()
    return cells


def _render_html_table(rows: list[list[str]]) -> str:
    return (
        "<table>"
        + "".join(
            "<tr>" + "".join(f"<{tag}>{escape_cell(cell)}</{tag}>" for cell in row) + "</tr>"
            for i, row in enumerate(rows)
            for tag in ["th" if i == 0 else "td"]
        )
        + "</table>"
    )


def pipe_table_to_html(body: str, escape_text: Callable[[str], str] = lambda s: s) -> PipeTable:
    if detect_table_kind(body) != "pipe":
        return PipeTable(escape_text(body), False)
    out: list[str] = []
    block: list[str] = []
    prose: list[str] = []
    converted = False

    def flush_prose(lines: list[str]) -> None:
        if lines:
            out.append(escape_text("\n".join(lines)))

    def flush_block() -> None:
        nonlocal converted
        if not block:
            return
        index = next((i for i, line in enumerate(block) if _separator(line)), -1)
        if index >= 1:
            flush_prose(block[: index - 1])
            rows = [block[index - 1]] + [
                line for line in block[index + 1 :] if not _separator(line)
            ]
            out.append(_render_html_table([_pipe_row(line) for line in rows]))
            converted = True
        else:
            flush_prose(block)
        block.clear()

    for raw in body.split("\n"):
        line = raw.removesuffix("\r")
        if "|" in line:
            flush_prose(prose)
            prose.clear()
            block.append(line)
        else:
            flush_block()
            prose.append(line)
    flush_block()
    flush_prose(prose)
    return PipeTable("\n".join(out), converted)
