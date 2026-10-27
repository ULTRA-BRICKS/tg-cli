"""Rich-only HTML routing, normalization and conservative Telegram limits."""

import math
import re
from dataclasses import dataclass

from tgcli.common.js_string import JS_WHITESPACE_PATTERN
from tgcli.common.jsonio import js_stringify
from tgcli.render.html import strip_html_tags
from tgcli.util.regex import escape_reg_exp

RICH_ONLY_TAGS = [
    "h1",
    "h2",
    "h3",
    "h4",
    "h5",
    "h6",
    "p",
    "hr",
    "footer",
    "aside",
    "cite",
    "figure",
    "figcaption",
    "details",
    "summary",
    "ul",
    "ol",
    "li",
    "table",
    "caption",
    "tr",
    "th",
    "td",
    "mark",
    "sub",
    "sup",
    "br",
    "input",
    "tg-math",
    "tg-math-block",
    "tg-reference",
    "img",
    "video",
    "audio",
    "tg-map",
    "tg-collage",
    "tg-slideshow",
]


def _pattern(source: str, flags: int = 0) -> re.Pattern[str]:
    return re.compile(source.replace(r"\s", JS_WHITESPACE_PATTERN), flags | re.ASCII)


_RICH_TAG = _pattern(
    "</?(?:"
    + "|".join(escape_reg_exp(t) for t in sorted(RICH_ONLY_TAGS, key=len, reverse=True))
    + r")(?=\s|[/>]|$)",
    re.IGNORECASE,
)
_RICH_ANCHOR = _pattern(
    r"""<a\b[^>]*\b(?:name\s*=|href\s*=\s*["']?(?:#|mailto:|tel:))""", re.IGNORECASE
)
_SPAN = _pattern(r"<span\b([^>]*)>|</span>", re.IGNORECASE)
_SPOILER = _pattern(r"""(?:^|\s)class\s*=\s*["']tg-spoiler["']""", re.IGNORECASE)


def is_rich_html(text: str) -> bool:
    return _RICH_TAG.search(text) is not None or _RICH_ANCHOR.search(text) is not None


def normalize_rich_html(html: str) -> str:
    stack: list[bool] = []

    def rewrite(match: re.Match[str]) -> str:
        if match[1] is not None:
            spoiler = _SPOILER.search(match[1]) is not None
            stack.append(spoiler)
            return "<tg-spoiler>" if spoiler else match[0]
        spoiler = stack.pop() if stack else False
        return "</tg-spoiler>" if spoiler else match[0]

    return _SPAN.sub(rewrite, html)


@dataclass(frozen=True)
class RichLimits:
    max_chars: int = 32768
    max_blocks: int = 500
    max_nesting: int = 16
    max_media: int = 50
    max_table_columns: int = 20


RICH_LIMITS = RichLimits()
_BLOCK_TAGS = frozenset(
    [
        "h1",
        "h2",
        "h3",
        "h4",
        "h5",
        "h6",
        "p",
        "pre",
        "hr",
        "footer",
        "aside",
        "li",
        "tr",
        "table",
        "ul",
        "ol",
        "blockquote",
        "details",
        "figure",
        "tg-math-block",
        "img",
        "video",
        "audio",
        "tg-map",
        "tg-collage",
        "tg-slideshow",
    ]
)
_MEDIA_TAGS = frozenset(["img", "video", "audio"])
_VOID_TAGS = frozenset(["img", "hr", "br", "input", "tg-map", "tg-emoji"])
_ALT = _pattern(r"""\balt\s*=\s*"([^"]*)"|alt\s*=\s*'([^']*)'""", re.IGNORECASE)
_ENTITY_COUNT = _pattern(
    r"&(?:lt|gt|amp|quot|apos|nbsp|hellip|mdash|ndash|lsquo|rsquo|ldquo|rdquo);|&#(?:[0-9]+|x[0-9a-fA-F]+);"
)
_TAG = _pattern(r"<(/?)([a-zA-Z][a-zA-Z0-9-]*)\b([^>]*)>")
_SELF_CLOSE = _pattern(r"/\s*$")
_HTTP_SRC = _pattern(r"""\bsrc\s*=\s*["']?https?:""", re.IGNORECASE)
_COLSPAN = _pattern(r"""colspan\s*=\s*["']?([0-9]+)""", re.IGNORECASE)
_ROWSPAN = _pattern(r"""rowspan\s*=\s*["']?([0-9]+)""", re.IGNORECASE)


@dataclass(frozen=True)
class RichValidation:
    ok: bool
    error: str | None = None


@dataclass(frozen=True)
class _Rowspan:
    cols: float
    rows_left: float


def validate_rich(html: str) -> RichValidation:
    # Like TS [...text], Python iterates code points rather than UTF-16 units.
    alt_text = "".join(
        match[1] if match[1] is not None else match[2] for match in _ALT.finditer(html)
    )
    chars = len(_ENTITY_COUNT.sub("￼", strip_html_tags(html) + alt_text))
    if chars > RICH_LIMITS.max_chars:
        return RichValidation(
            False,
            f"rich message too long: {chars} chars (limit {RICH_LIMITS.max_chars}).",
        )
    blocks = media = depth = max_depth = in_table = 0
    cols = 0.0
    rowspans: list[_Rowspan] = []
    for match in _TAG.finditer(html):
        is_close = match[1] == "/"
        name = match[2].lower()
        attrs = match[3]
        self_closing = _SELF_CLOSE.search(attrs) is not None or name in _VOID_TAGS
        http_src = _HTTP_SRC.search(attrs) is not None
        if not is_close:
            if name in _BLOCK_TAGS and (name not in _MEDIA_TAGS or http_src):
                blocks += 1
            if name in _MEDIA_TAGS and http_src:
                media += 1
            if not self_closing:
                depth += 1
                max_depth = max(depth, max_depth)
            if name == "table":
                in_table += 1
                rowspans = []
            if name == "tr" and in_table > 0:
                cols = sum(row.cols for row in rowspans)
                rowspans = [
                    _Rowspan(row.cols, row.rows_left - 1) for row in rowspans if row.rows_left > 1
                ]
            if in_table > 0 and name in ("td", "th"):
                colspan = _COLSPAN.search(attrs)
                span = max(1.0, float(colspan[1])) if colspan else 1.0
                cols += span
                rowspan = _ROWSPAN.search(attrs)
                rs = max(1.0, float(rowspan[1])) if rowspan else 1.0
                if rs > 1:
                    rowspans.append(_Rowspan(span, rs - 1))
        else:
            if not self_closing and depth > 0:
                depth -= 1
            if name == "tr" and in_table > 0 and cols > RICH_LIMITS.max_table_columns:
                return RichValidation(
                    False,
                    f"table has {'Infinity' if math.isinf(cols) else js_stringify(cols)} columns "
                    f"(limit {RICH_LIMITS.max_table_columns}).",
                )
            if name == "table" and in_table > 0:
                in_table -= 1
    if blocks > RICH_LIMITS.max_blocks:
        return RichValidation(
            False, f"rich message has {blocks} blocks (limit {RICH_LIMITS.max_blocks})."
        )
    if media > RICH_LIMITS.max_media:
        return RichValidation(
            False,
            f"rich message has {media} media attachments (limit {RICH_LIMITS.max_media}).",
        )
    if max_depth > RICH_LIMITS.max_nesting:
        return RichValidation(
            False,
            f"rich message nested {max_depth} levels deep (limit {RICH_LIMITS.max_nesting}).",
        )
    return RichValidation(True)
