"""Verify the complete frozen JS Letter predicate, including non-letter gaps."""

import hashlib
import json
from pathlib import Path

from tgcli.prefix_style._unicode_letters import is_bun_letter


def test_full_bun_letter_membership_digest():
    expected = json.loads(
        (Path(__file__).parent / "fixtures/render/unicode_letters.json").read_bytes()
    )
    membership = bytes(is_bun_letter(chr(cp)) for cp in range(expected["codepoint_count"]))
    assert sum(membership) == expected["letter_count"]
    assert hashlib.sha256(membership).hexdigest() == expected["membership_sha256"]


def test_letter_range_boundaries_and_surrogates():
    assert not is_bun_letter("@")
    assert is_bun_letter("A")
    assert is_bun_letter("Z")
    assert not is_bun_letter("[")
    assert is_bun_letter("\u1c89")
    assert not is_bun_letter("\ud800")
    assert not is_bun_letter("\udfff")
    assert not is_bun_letter("\U0010ffff")
