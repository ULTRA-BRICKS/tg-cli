"""Shared safe text truncation and human-readable age formatting."""

import math
import re

from tgcli.common.text import safe_slice_end as safe_slice_end
from tgcli.common.text import utf16_len, utf16_slice


def truncate_with_ellipsis(s: str, maximum: int) -> str:
    return s if utf16_len(s) <= maximum else utf16_slice(s, 0, safe_slice_end(s, maximum - 1)) + "…"


def has_unpaired_surrogate(s: str) -> bool:
    # Decoding valid explicit surrogate pairs also handles Python strings that came
    # from callers rather than JSON; astral code points are already well formed.
    normalized = s.encode("utf-16-le", "surrogatepass").decode("utf-16-le", "surrogatepass")
    return re.search(r"[\ud800-\udfff]", normalized) is not None


def format_age(ms: int | float) -> str:
    minutes = math.floor(ms / 60_000)
    if minutes < 60:
        return f"{minutes} min"
    hours = minutes // 60
    return f"{hours} h {minutes % 60} min" if hours < 24 else f"{hours // 24} d {hours % 24} h"
