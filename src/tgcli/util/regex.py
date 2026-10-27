"""Literal escaping for the complete ECMAScript regex metacharacter set."""

import re


def escape_reg_exp(s: str) -> str:
    return re.sub(r"[.*+?^${}()|\[\]\\-]", lambda m: "\\" + m[0], s)
