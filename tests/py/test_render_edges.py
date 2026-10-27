"""Port-specific boundary cases checked against Bun String/Number semantics."""

import pytest


def test_pill_id_end_anchor_matches_javascript(monkeypatch):
    from tgcli.branding import emoji

    monkeypatch.setitem(emoji.TAG_PILL_IDS, "TEST", ["123456789012345\n"])
    assert not emoji.has_real_pill_ids("TEST")


@pytest.mark.parametrize(
    "digits, count",
    [
        ("9" * 22, "1e+22"),
        ("9" * 400, "Infinity"),
        ("9007199254740993", "9007199254740992"),
    ],
)
def test_rich_colspan_uses_javascript_number(digits, count):
    from tgcli.render.rich import validate_rich

    result = validate_rich(f'<table><tr><td colspan="{digits}">x</td></tr></table>')
    assert not result.ok
    assert result.error == f"table has {count} columns (limit 20)."


def test_emoji_offsets_count_utf16_and_observe_live_maps(monkeypatch):
    from tgcli.branding import emoji
    from tgcli.render.html import parse_emoji_helpers

    monkeypatch.setitem(emoji.EMBEDDABLE_EMOJI_MAP, "custom", "123")
    monkeypatch.setitem(emoji.UNICODE_EMOJI_MAP, "custom", "😀")
    parsed = parse_emoji_helpers("😀x :CUSTOM: :custom:")
    assert parsed["text"] == "😀x 😀 😀"
    assert [e["offset"] for e in parsed["entities"]] == [4, 7]
    assert [e["length"] for e in parsed["entities"]] == [2, 2]


def test_entities_keep_raw_string_slice_boundaries():
    from tgcli.render.html import convert_entities_to_html

    assert (
        convert_entities_to_html(
            "😀",
            [
                {
                    "type": "custom_emoji",
                    "offset": 0,
                    "length": 1,
                    "custom_emoji_id": "1",
                }
            ],
        )
        == '<tg-emoji emoji-id="1">\ud83d</tg-emoji>\ude00'
    )


@pytest.mark.parametrize("whitespace", ["\ufeff", "\u00a0", "\u2028", "\u2029"])
def test_javascript_whitespace_is_trimmed(whitespace):
    from tgcli.render.table import parse_table_rows
    from tgcli.render.tag import validate_tag

    assert validate_tag(whitespace + "answer" + whitespace) is None
    assert parse_table_rows(whitespace + "a" + whitespace + "|b").rows == [["a", "b"]]


@pytest.mark.parametrize("literal", ["\x1c", "\x85"])
def test_python_only_whitespace_is_kept(literal):
    from tgcli.render.table import detect_table_kind, parse_table_rows
    from tgcli.render.tag import validate_tag

    assert validate_tag(literal + "answer") is not None
    assert parse_table_rows(literal + "a|b").rows == [[literal + "a", "b"]]
    assert detect_table_kind("<table" + literal + ">") == "none"


def test_blank_rows_and_astral_table_padding():
    from tgcli.render.table import render_table

    assert render_table([[]]) == "┌┐\n│  │\n└┘"
    assert (
        render_table([["😀", "x"], ["aa", "y"]])
        == "┌────┬───┐\n│ 😀 │ x │\n├────┼───┤\n│ aa │ y │\n└────┴───┘"
    )


def test_new_unicode_letter_uses_whole_window_fallback():
    from tgcli.prefix_style.style import style_window_name, to_sans_bold

    name = "api\u1c89"
    assert to_sans_bold(name) is None
    styled = style_window_name(name)
    assert (styled.html, styled.plain, styled.tag) == ("<b>apiᲉ</b>", "apiᲉ", True)


def test_new_unicode_letter_uses_whole_title_fallback():
    from tgcli.prefix_style.style import style_task_title, to_bold_italic

    title = "api\u1c89"
    assert to_bold_italic(title) is None
    assert style_task_title(title) == "<i>apiᲉ</i>"
