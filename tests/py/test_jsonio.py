import pytest

from tgcli.common.jsonio import js_stringify


def test_js_stringify_key_order() -> None:
    assert js_stringify({"b": 1, "2": 2, "a": 3, "1": 4}) == '{"1":4,"2":2,"b":1,"a":3}'
    assert js_stringify({"01": 1, "4294967295": 2, "4294967294": 3}) == (
        '{"4294967294":3,"01":1,"4294967295":2}'
    )


@pytest.mark.parametrize(
    ("value", "compact"),
    [
        ({}, "{}"),
        ([], "[]"),
        (None, "null"),
        (True, "true"),
        (False, "false"),
        (7, "7"),
        (-3, "-3"),
        (1.0, "1"),
        (1.5, "1.5"),
        (1e16, "10000000000000000"),
        (1e-7, "1e-7"),
        (1e-6, "0.000001"),
        (1e21, "1e+21"),
        (1.5e300, "1.5e+300"),
        (float("nan"), "null"),
        (float("inf"), "null"),
        (-0.0, "0"),
        (2.0**60, "1152921504606847000"),
        ("Привет 😀", '"Привет 😀"'),
        ("\ud800", '"\\ud800"'),
        ("\ud83d\ude00", '"😀"'),
        ('a"b\\c\n\t\x01\x7f', '"a\\"b\\\\c\\n\\t\\u0001\x7f"'),
        ({"a": [1, {"b": None}], "c": {}}, '{"a":[1,{"b":null}],"c":{}}'),
        ((1, 2), "[1,2]"),
    ],
)
def test_js_stringify_matches_js(value: object, compact: str) -> None:
    assert js_stringify(value) == compact


def test_js_stringify_indent() -> None:
    value = {"a": [1, {"b": "я"}], "c": {}, "d": []}
    assert js_stringify(value, indent=2) == (
        '{\n  "a": [\n    1,\n    {\n      "b": "я"\n    }\n  ],\n  "c": {},\n  "d": []\n}'
    )


def test_js_stringify_rejects_unknown_types() -> None:
    with pytest.raises(TypeError):
        js_stringify(object())
    with pytest.raises(TypeError):
        js_stringify({1: "x"})


@pytest.mark.parametrize(
    ("value", "expected"),
    [
        (2**53, "9007199254740992"),
        (2**53 + 1, "9007199254740992"),
        (2**60, "1152921504606847000"),
        (-(2**60), "-1152921504606847000"),
        (10**21, "1e+21"),
        (10**400, "null"),
        (9007199254740991, "9007199254740991"),
    ],
)
def test_js_stringify_large_ints_like_js(value: int, expected: str) -> None:
    assert js_stringify(value) == expected


def test_js_stringify_rejects_bytes() -> None:
    with pytest.raises(TypeError):
        js_stringify(b"ab")
    with pytest.raises(TypeError):
        js_stringify({"a": bytearray(b"x")})
    with pytest.raises(TypeError):
        js_stringify([memoryview(b"x")])


@pytest.mark.parametrize(
    ("indent", "expected"),
    [
        (0, '{"x":[1]}'),
        (-3, '{"x":[1]}'),
        (20, '{\n          "x": [\n                    1\n          ]\n}'),
    ],
)
def test_js_stringify_indent_uses_js_gap_limits(indent: int, expected: str) -> None:
    assert js_stringify({"x": [1]}, indent=indent) == expected


def test_js_stringify_long_numeric_key_is_not_an_array_index() -> None:
    key = "1" * 5000
    assert js_stringify({key: 1}) == '"'.join(["{", key, ":1}"])
