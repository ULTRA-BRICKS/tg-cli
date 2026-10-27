import pytest

from tgcli.common.text import utf16_slice
from tgcli.tg_ctl.guards import is_record
from tgcli.tg_ctl.text_util import (
    format_age,
    has_unpaired_surrogate,
    safe_slice_end,
    truncate_with_ellipsis,
)


@pytest.mark.parametrize(
    ("text", "end", "expected"),
    [
        ("hello", 10, 5),
        ("hello", 5, 5),
        ("hello world", 5, 5),
        ("ab😀cd", 3, 2),
        ("ab😀cd", 4, 4),
        ("ab\ud83d\ud83d\ude00cd", 4, 2),
        ("hi", -3, 0),
        ("hi", 99, 2),
    ],
)
def test_safe_slice_end(text, end, expected):
    assert safe_slice_end(text, end) == expected


@pytest.mark.parametrize(
    ("text", "maximum", "expected"),
    [
        ("hello", 10, "hello"),
        ("hello", 5, "hello"),
        ("hello world", 5, "hell…"),
        ("ab😀cd", 3, "ab…"),
        ("ab😀cd", 5, "ab😀…"),
        ("😀xyz", 1, "…"),
        ("😀xyz", 0, "…"),
    ],
)
def test_truncate_with_ellipsis(text, maximum, expected):
    assert truncate_with_ellipsis(text, maximum) == expected
    assert not has_unpaired_surrogate(expected)


@pytest.mark.parametrize(
    ("text", "expected"),
    [
        ("plain ascii", False),
        ("a😀b", False),
        ("😀😀", False),
        ("a\ud83db", True),
        ("a\ude00b", True),
        ("\ud83d\ud83d\ude00", True),
        ("\ud83d\ude00", False),
    ],
)
def test_has_unpaired_surrogate(text, expected):
    assert has_unpaired_surrogate(text) is expected


def test_truncate_offset_sweep():
    text = "x" * 50 + "😀" + "y" * 50
    for maximum in range(40, 61):
        assert not has_unpaired_surrogate(truncate_with_ellipsis(text, maximum))
    assert utf16_slice("ab😀cd", 0, safe_slice_end("ab😀cd", 3)) == "ab"


@pytest.mark.parametrize(
    ("ms", "expected"),
    [
        (0, "0 min"),
        (59999, "0 min"),
        (300000, "5 min"),
        (3600000, "1 h 0 min"),
        (3900000, "1 h 5 min"),
        (93600000, "1 d 2 h"),
        (-1, "-1 min"),
    ],
)
def test_format_age(ms, expected):
    assert format_age(ms) == expected


@pytest.mark.parametrize(
    ("value", "expected"),
    [
        ({}, True),
        ({"a": 1}, True),
        ([], False),
        (None, False),
        ("a", False),
        (1, False),
        (True, False),
    ],
)
def test_is_record(value, expected):
    assert is_record(value) is expected
