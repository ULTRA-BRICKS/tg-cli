import pytest

from tgcli.cli.send_output import format_send_output
from tgcli.cli.text_escapes import decode_text_escapes


@pytest.mark.parametrize(
    ("ids", "expected"),
    [
        ([], "OK"),
        ([123], "OK tg#123"),
        ([123, 124, 126], "OK tg#123 tg#124 tg#126"),
        ([0, 9, 9, -1, 10.5, 10], "OK tg#9 tg#9 tg#10"),
        ([True, False, float("nan")], "OK"),
    ],
)
def test_format_send_output(ids, expected):
    assert format_send_output(ids) == expected


@pytest.mark.parametrize(
    ("text", "expected"),
    [
        (r"a\nb\rc\td\\e", "a\nb\rc\td\\e"),
        (r"\q\u1234", r"\q\u1234"),
        (r"\\n", r"\n"),
        ("plain я😀", "plain я😀"),
        ("ending\\", "ending\\"),
    ],
)
def test_decode_text_escapes(text, expected):
    assert decode_text_escapes(text) == expected


@pytest.mark.parametrize(
    ("ids", "expected"),
    [
        ([10**21], "OK tg#1e+21"),
        ([1e21], "OK tg#1e+21"),
        ([9007199254740993], "OK tg#9007199254740992"),
        ([10**5000], "OK"),
    ],
)
def test_send_receipt_formats_js_numbers(ids, expected):
    assert format_send_output(ids) == expected
