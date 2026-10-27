"""JS `JSON.stringify` output, byte for byte (spec §3)."""

import math
import re
from collections.abc import Mapping, Sequence
from decimal import Decimal

_INDEX_KEY = re.compile(r"(?:0|[1-9][0-9]*)")
_MAX_INDEX = 4294967294
# Beyond 2**53 not every integer is an exact double, so JS prints the nearest one.
_EXACT_DOUBLE_LIMIT = 2**53
_ESCAPES = {
    '"': '\\"',
    "\\": "\\\\",
    "\b": "\\b",
    "\f": "\\f",
    "\n": "\\n",
    "\r": "\\r",
    "\t": "\\t",
}


def _is_index(key: str) -> bool:
    return len(key) <= 10 and _INDEX_KEY.fullmatch(key) is not None and int(key) <= _MAX_INDEX


def _ordered_keys(keys: Sequence[str]) -> list[str]:
    """Integer-index keys first, ascending, then the rest in insertion order."""
    indexes = sorted((k for k in keys if _is_index(k)), key=int)
    return indexes + [k for k in keys if not _is_index(k)]


def _quote(s: str) -> str:
    if any("\ud800" <= ch <= "\udfff" for ch in s):
        # A JS string pairs adjacent surrogates; a Python str holds them as separate code points.
        s = s.encode("utf-16-le", "surrogatepass").decode("utf-16-le", "surrogatepass")
    out = ['"']
    for ch in s:
        if ch in _ESCAPES:
            out.append(_ESCAPES[ch])
        elif ch < " " or "\ud800" <= ch <= "\udfff":
            out.append(f"\\u{ord(ch):04x}")
        else:
            out.append(ch)
    out.append('"')
    return "".join(out)


def _number(x: float) -> str:
    """ECMAScript Number::toString."""
    if not math.isfinite(x):
        return "null"
    if x == 0:
        return "0"
    sign, digits, exp = Decimal(repr(abs(x))).as_tuple()
    assert isinstance(exp, int)
    text = "".join(map(str, digits)).rstrip("0")
    exp += len(digits) - len(text)  # digits dropped from the end
    k = len(text)
    n = k + exp  # decimal point position
    prefix = "-" if x < 0 else ""
    if k <= n <= 21:
        body = text + "0" * (n - k)
    elif 0 < n <= 21:
        body = f"{text[:n]}.{text[n:]}"
    elif -6 < n <= 0:
        body = f"0.{'0' * -n}{text}"
    else:
        e = n - 1
        mantissa = text if k == 1 else f"{text[0]}.{text[1:]}"
        body = f"{mantissa}e{'+' if e >= 0 else '-'}{abs(e)}"
    return prefix + body


def _integer(value: int) -> str:
    """JS numbers are doubles: integers beyond 2**53 print as their nearest double."""
    if abs(value) <= _EXACT_DOUBLE_LIMIT:
        return str(value)
    try:
        return _number(float(value))
    except OverflowError:
        # Too large for a double: JS reads it as Infinity, which JSON.stringify writes as null.
        return "null"


def _dump(value: object, indent: int | None, level: int) -> str:
    if value is None:
        return "null"
    if value is True:
        return "true"
    if value is False:
        return "false"
    if isinstance(value, int):
        return _integer(value)
    if isinstance(value, float):
        return _number(value)
    if isinstance(value, str):
        return _quote(value)
    if isinstance(value, Mapping):
        items = _members(value)
        return _container(
            "{",
            "}",
            [
                f"{_quote(k)}:{'' if indent is None else ' '}{_dump(v, indent, level + 1)}"
                for k, v in items
            ],
            indent,
            level,
        )
    if isinstance(value, Sequence) and not isinstance(value, bytes | bytearray | memoryview):
        return _container("[", "]", [_dump(v, indent, level + 1) for v in value], indent, level)
    raise TypeError(f"not JSON serialisable: {type(value).__name__}")


def _members(value: Mapping[object, object]) -> list[tuple[str, object]]:
    for key in value:
        if not isinstance(key, str):
            raise TypeError(f"object keys must be str, got {type(key).__name__}")
    keys = [k for k in value if isinstance(k, str)]
    return [(k, value[k]) for k in _ordered_keys(keys)]


def _container(open_: str, close: str, parts: list[str], indent: int | None, level: int) -> str:
    if not parts:
        return open_ + close
    if indent is None:
        return open_ + ",".join(parts) + close
    inner = "\n" + " " * (indent * (level + 1))
    outer = "\n" + " " * (indent * level)
    return open_ + inner + ("," + inner).join(parts) + outer + close


def js_stringify(value: object, indent: int | None = None) -> str:
    gap = min(indent, 10) if indent is not None and indent > 0 else None
    return _dump(value, gap, 0)
