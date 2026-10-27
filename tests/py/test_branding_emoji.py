"""Pure branding cases from emoji_map.test.ts; sender effects stay in parity."""

import re

import pytest

from tgcli.branding import emoji


def test_embeddable_map_unique_ids_and_expected_models():
    assert len(set(emoji.EMBEDDABLE_EMOJI_MAP.values())) == 15
    expected = [
        "hyperide",
        "codex",
        "openai",
        "claude",
        "anthropic",
        "gemini",
        "google",
        "deepseek",
        "qwen",
        "alibaba",
        "kimi",
        "moonshot",
        "o3",
        "o1",
        "gpt4",
        "gpt3",
        "gpt",
        "llama",
        "meta",
        "ollama",
        "mistral",
        "grok",
        "xai",
        "copilot",
        "github",
        "perplexity",
        "cursor",
        "windsurf",
        "devin",
        "cognition",
        "aider",
        "continue",
        "omp",
    ]
    assert set(expected) <= emoji.EMBEDDABLE_EMOJI_MAP.keys()
    assert all(re.fullmatch(r"[0-9]{19}", value) for value in emoji.EMBEDDABLE_EMOJI_MAP.values())


def test_map_structure_and_all_custom_keys_have_unicode_fallback():
    assert all(key == key.lower() and value for key, value in emoji.EMBEDDABLE_EMOJI_MAP.items())
    assert emoji.EMBEDDABLE_EMOJI_MAP.keys() <= emoji.UNICODE_EMOJI_MAP.keys()


@pytest.mark.parametrize("key, value", [("glm", "🗂"), ("chatglm", "🗂"), ("fireworks", "🎆")])
def test_unicode_only_helpers(key, value):
    assert emoji.UNICODE_EMOJI_MAP[key] == value
    assert key not in emoji.EMBEDDABLE_EMOJI_MAP


def test_gpt_alias_has_distinct_unicode_and_shared_custom_brand():
    assert emoji.UNICODE_EMOJI_MAP["gpt"] == "⚡"
    assert emoji.EMBEDDABLE_EMOJI_MAP["gpt"] == "5273797309195393626"


@pytest.mark.parametrize(
    "group",
    [
        "codex openai o3 o1 gpt4 gpt3 gpt",
        "claude anthropic devin cognition aider continue omp",
        "gemini google",
        "qwen alibaba",
        "kimi moonshot",
        "llama meta",
        "grok xai",
        "copilot github",
    ],
)
def test_alias_pairs_share_ids(group):
    assert len({emoji.EMBEDDABLE_EMOJI_MAP[key] for key in group.split()}) == 1


def test_substring_exclusions_stay_in_sync_with_maps():
    assert {"omp"} == emoji.SUBSTRING_FALLBACK_EXCLUDED_KEYS
    assert emoji.EMBEDDABLE_EMOJI_MAP.keys() >= emoji.SUBSTRING_FALLBACK_EXCLUDED_KEYS
    assert emoji.MODEL_EMOJI_MAP.keys() >= emoji.SUBSTRING_FALLBACK_EXCLUDED_KEYS


@pytest.mark.parametrize(
    "model, expected",
    [
        ("CLAUDE-opus-4", "claude"),
        ("omp_1.2", "omp"),
        ("omp2", "omp2"),
        ("constructor", "constructor"),
        ("constructor-foo", "constructor-foo"),
        ("computer-use-preview", "computer-use-preview"),
        ("TOSTRING", "tostring"),
    ],
)
def test_base_model_boundaries(model, expected):
    assert emoji.extract_base_model(model) == expected


@pytest.mark.parametrize(
    "ids, expected",
    [
        ([], False),
        (["PLACEHOLDER"], False),
        (["123456789012345", "PLACEHOLDER"], False),
        (["123456789012345"], True),
        (["12345678901234"], False),
        (["１２３４５６７８９０１２３４５"], False),
    ],
)
def test_real_pill_id_guards(ids, expected, monkeypatch):
    monkeypatch.setitem(emoji.TAG_PILL_IDS, "TEST", ids)
    assert emoji.has_real_pill_ids("TEST") is expected


def test_pill_cell_fallbacks_follow_live_cell_count(monkeypatch):
    monkeypatch.setitem(emoji.TAG_PILL_IDS, "ANSWER", ["a", "b", "c", "d"])
    assert emoji.tag_pill_cell_dots("ANSWER") == ["🔵", "▫️", "▫️", "▫️"]
    assert emoji.tag_pill_cell_dots("unknown") == []
    assert emoji.cell_dots_for("", 3) == []
    assert emoji.cell_dots_for("🔵", 0) == []
    assert emoji.cell_dots_for("🔵", 1) == ["🔵"]
