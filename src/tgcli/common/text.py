"""UTF-16 length and slicing, so cuts land where JS `String.slice` and `.length` would."""

_UNIT = 2


def _encode(s: str) -> bytes:
    # surrogatepass keeps a lone surrogate as its own unit, exactly as a JS string holds it.
    return s.encode("utf-16-le", "surrogatepass")


def _unit(data: bytes, index: int) -> int:
    return data[index * _UNIT] | (data[index * _UNIT + 1] << 8)


def utf16_len(s: str) -> int:
    return len(_encode(s)) // _UNIT


def _safe_end(data: bytes, end: int) -> int:
    length = len(data) // _UNIT
    clamped = max(0, min(end, length))
    # A high surrogate as the last included unit would orphan its partner: back up over the
    # WHOLE run (malformed text can carry consecutive highs), as safeSliceEnd does.
    while 0 < clamped < length and 0xD800 <= _unit(data, clamped - 1) <= 0xDBFF:
        clamped -= 1
    return clamped


def safe_slice_end(s: str, end: int) -> int:
    """Port of `safeSliceEnd` (features/tg-ctl/text-util.ts): `end` in UTF-16 units that never
    leaves a high surrogate as the last included unit."""
    return _safe_end(_encode(s), end)


def utf16_slice(s: str, start: int, end: int | None = None) -> str:
    """`s.slice(start, end)` in UTF-16 units (negative indices count from the end), with the
    end adjusted by `safe_slice_end`."""
    data = _encode(s)
    length = len(data) // _UNIT
    begin = max(0, length + start) if start < 0 else min(start, length)
    stop = length if end is None else _safe_end(data, max(0, length + end) if end < 0 else end)
    return data[begin * _UNIT : stop * _UNIT].decode("utf-16-le", "surrogatepass")
