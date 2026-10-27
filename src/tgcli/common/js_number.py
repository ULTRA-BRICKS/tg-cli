"""Binary64 conversion for the Number/Number.isInteger sites ported from JS."""

import math
import re

from tgcli.common.js_string import js_trim

_DECIMAL = re.compile(r"[+-]?(?:[0-9]+(?:\.[0-9]*)?|\.[0-9]+)(?:[eE][+-]?[0-9]+)?")
_BASES = ((r"0[xX][0-9a-fA-F]+", 16), (r"0[oO][0-7]+", 8), (r"0[bB][01]+", 2))


def js_number(value: str | float) -> float:
    """Convert supported string/numeric inputs as JS Number does, never via decimal int()."""
    if isinstance(value, str):
        text = js_trim(value)
        if not text:
            return 0.0
        if text in {"Infinity", "+Infinity", "-Infinity"}:
            return -math.inf if text.startswith("-") else math.inf
        if _DECIMAL.fullmatch(text):
            return float(text)
        for pattern, base in _BASES:
            if re.fullmatch(pattern, text):
                try:
                    return float(int(text, base))
                except OverflowError:
                    return math.inf
        return math.nan
    try:
        return float(value)
    except OverflowError:
        return -math.inf if value < 0 else math.inf


def js_integer(value: object) -> float | None:
    """Number.isInteger after representing a Python numeric value as JS binary64."""
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return None
    number = js_number(value)
    return number if math.isfinite(number) and number.is_integer() else None
