"""Schema and privacy checks for tests/fixtures/render-corpus (Refs #815, #813).

Future table/tag fixtures load these files; they must stay well-formed and anonymised.
"""

import json
import re
from pathlib import Path

import pytest

CORPUS = Path(__file__).resolve().parents[1] / "fixtures" / "render-corpus"
KNOWN_DEFECTS = {
    "html_tags_visible_in_cells",
    "ragged_or_shifted_columns",
    "md_rows_left_raw",
    "md_table_not_recognised",
    "code_fence_leaks_into_output",
    "markdown_markup_visible_in_cells",
}
# Anything that would identify a person, host or secret. The corpus keeps markup, not identities.
IDENTITY_PATTERNS = {
    "email": re.compile(r"[\w.+-]+@[\w-]+\.[A-Za-z]{2,}"),
    "bot token": re.compile(r"\b\d{8,10}:[A-Za-z0-9_-]{30,}\b"),
    "github token": re.compile(r"\bgh[pousr]_[A-Za-z0-9]{20,}\b"),
    # 192.0.2.0/24 is the documentation block the anonymiser maps every address into.
    "ipv4 outside the documentation block": re.compile(
        r"\b(?!192\.0\.2\.\d{1,3}\b)\d{1,3}(?:\.\d{1,3}){3}\b"
    ),
    "real url": re.compile(r"https?://(?!example\.invalid)[^\s\"'<>]+"),
    "home path": re.compile(r"/(?:home|Users)/[A-Za-z]"),
}


def load(name: str) -> list[dict]:
    path = CORPUS / name
    return [
        json.loads(line) for line in path.read_text(encoding="utf-8").splitlines() if line.strip()
    ]


@pytest.fixture(scope="module")
def tables() -> list[dict]:
    return load("tables.jsonl")


@pytest.fixture(scope="module")
def leaks() -> list[dict]:
    return load("html-leaks.jsonl")


def test_table_rows_are_well_formed(tables: list[dict]) -> None:
    ids = [r["id"] for r in tables]
    assert len(ids) == len(set(ids))
    for r in tables:
        assert r["origin"] in {"real", "synthetic"}
        assert r["source"] in {"transcript", "mtproto_render", "reproduced"}
        assert r["modes"] and r["expect"]
        # exactly one of the two is set: authored (transcript) or rendered (chat)
        assert (r["authored"] is None) == (r["rendered_visible"] is not None)
        if r["authored"] is not None:
            assert set(r["today"]["defects"]) <= KNOWN_DEFECTS
            assert isinstance(r["today"]["tables_out"], int)


def test_table_corpus_has_enough_real_evidence(tables: list[dict]) -> None:
    real = [r for r in tables if r["origin"] == "real"]
    authored = [r for r in real if r["source"] == "transcript" and "html_table" not in r["modes"]]
    visible = [r for r in real if r["source"] == "mtproto_render"]
    assert len(authored) >= 20
    assert len(visible) >= 10
    assert any("pre_wrapped" in r["modes"] and r["today"]["defects"] for r in authored)
    assert any("label_glued_to_header" in r["modes"] for r in visible)


def test_every_requirement_context_has_a_fixture(tables: list[dict]) -> None:
    modes = {m for r in tables for m in r["modes"]}
    needed = {
        "pre_wrapped",
        "in_code_fence",
        "in_blockquote",
        "in_list",
        "html_paragraph_br_joined",
        "html_list_item",
        "escaped_pipe",
        "pipe_in_code_span",
        "br_in_cell",
        "md_next_to_real_html_table",
        "no_leading_pipe",
        "alignment_row",
        "crlf",
        "no_separator_row",
        "two_tables",
        "wide_glyph_cells",
        "over_4096_chars",
        "block_content_in_cell",
        "raw_pipes_visible_to_reader",
    }
    assert needed <= modes


def test_leak_rows_are_well_formed(leaks: list[dict]) -> None:
    ids = [r["id"] for r in leaks]
    assert len(ids) == len(set(ids))
    assert all(re.fullmatch(r"[A-H][0-9]?_.+", r["class"]) for r in leaks)
    classes = {r["class"][0] for r in leaks}
    assert {"A", "B", "C", "D", "E", "F", "G", "H"} <= classes
    for r in leaks:
        assert r["origin"] in {"real", "synthetic"}
        assert r["expect"]
        assert r["rendered_visible"] or r["host_authored"]


def corpus_files() -> list[Path]:
    files = sorted(CORPUS.glob("*.jsonl"))
    assert files, "the render corpus has no JSONL files"
    return files


def test_no_identity_survives_in_the_corpus() -> None:
    for path in corpus_files():
        text = path.read_text(encoding="utf-8")
        for label, pattern in IDENTITY_PATTERNS.items():
            assert not pattern.search(text), f"{path.name}: {label}"


def test_corpus_text_has_no_replacement_characters() -> None:
    for path in corpus_files():
        assert "\ufffd" not in path.read_text(encoding="utf-8"), path.name
