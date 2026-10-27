"""Decode exactly the four literal escapes supported in tg captions."""

import re


def decode_text_escapes(s: str) -> str:
    replacements = {"n": "\n", "r": "\r", "t": "\t", "\\": "\\"}
    return re.sub(r"\\([nrt\\])", lambda match: replacements[match[1]], s)
