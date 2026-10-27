from tgcli.common.text import safe_slice_end, utf16_len, utf16_slice
from tgcli.tg_ctl import text_util

EMOJI = "\ud83d\ude00"


def test_utf16_len() -> None:
    assert utf16_len("я😀") == 3
    assert utf16_len("\ud800") == 1


def test_safe_slice_end_basics() -> None:
    assert safe_slice_end("hello", 10) == 5
    assert safe_slice_end("hello world", 5) == 5
    assert safe_slice_end("hi", -3) == 0
    assert safe_slice_end("hi", 99) == 2


def test_utf16_slice_never_splits_pair() -> None:
    s = "ab😀cd"
    assert utf16_slice(s, 0, 3) == "ab"
    assert utf16_slice(s, 0, 4) == "ab😀"
    assert utf16_slice(s, 4) == "cd"


def test_utf16_slice_unpaired_high_run() -> None:
    s = "ab\ud83d\ud83d\ude00cd"
    assert safe_slice_end(s, 4) == 2
    assert utf16_slice(s, 0, 4) == "ab"


def test_tg_ctl_text_util_reexports() -> None:
    assert text_util.safe_slice_end is safe_slice_end


def test_utf16_slice_negative_indices_like_js() -> None:
    assert utf16_slice("abc", 0, -1) == "ab"
    assert utf16_slice("hello", -3) == "llo"
    assert utf16_slice("hello", -99, 2) == "he"
    assert utf16_slice("hello", 1, -99) == ""
    assert utf16_slice("hello", 9) == ""
    assert utf16_slice("ab😀cd", 0, -3) == "ab"
    assert utf16_slice("ab😀cd", -2) == "cd"
