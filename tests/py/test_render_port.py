"""Exact golden replay of the TypeScript render white-box cases at 218a7a4.

Each original callback ran successfully against Bun; every helper invocation is
compared in full, including the live singleton maps seen at that invocation.
The fixture retains original test names; no Bun runtime is needed by pytest.
"""

import dataclasses
import importlib
import json
import re
from pathlib import Path

import pytest

FIXTURES = Path(__file__).parent / "fixtures" / "render"
VECTORS = json.loads((FIXTURES / "ts_vectors.json").read_bytes())


def snake(value):
    return (
        re.sub(r"([a-z0-9])([A-Z])", lambda m: m[1] + "_" + m[2], value).lower().replace("-", "_")
    )


def comparable(value):
    if dataclasses.is_dataclass(value):
        return {
            re.sub(r"_([a-z])", lambda m: m[1].upper(), f.name): comparable(getattr(value, f.name))
            for f in dataclasses.fields(value)
            if f.name != "error" or getattr(value, f.name) is not None
        }
    if isinstance(value, dict):
        return {k: comparable(v) for k, v in value.items()}
    if isinstance(value, (list, tuple, set, frozenset)):
        return [comparable(v) for v in value]
    return value


@pytest.fixture
def restore_branding():
    import copy

    from tgcli.branding import emoji

    originals = {
        name: copy.deepcopy(getattr(emoji, name))
        for name in ("TAG_PILL_IDS", "EMBEDDABLE_EMOJI_MAP", "UNICODE_EMOJI_MAP")
    }
    yield
    for name, original in originals.items():
        mapping = getattr(emoji, name)
        mapping.clear()
        mapping.update(original)


def assert_constants():
    for module, names in VECTORS["constants"].items():
        target = importlib.import_module("tgcli." + module)
        for name, value in names.items():
            assert comparable(getattr(target, name)) == value


@pytest.mark.parametrize(
    "case", VECTORS["cases"], ids=lambda case: case["suite"] + ": " + case["name"]
)
def test_typescript_whitebox_case(case, restore_branding):
    from tgcli.branding import emoji

    assert_constants()
    for call in case["calls"]:
        state = VECTORS["states"][call["state"]]
        for name, key in [
            ("TAG_PILL_IDS", "pills"),
            ("EMBEDDABLE_EMOJI_MAP", "embeddable"),
            ("UNICODE_EMOJI_MAP", "unicode"),
        ]:
            mapping = getattr(emoji, name)
            mapping.clear()
            mapping.update(state[key])
        module = importlib.import_module(
            "tgcli." + call["module"].replace("/", ".").replace("-", "_")
        )
        function = getattr(
            module,
            "validate_rich" if call["fn"] == "validateRichHtml" else snake(call["fn"]),
        )
        args = call["args"][:1] if call["fn"] == "escapeRegExp" else call["args"]
        if call["fn"] in ("buildPrefix", "shouldColorize"):
            result = function(**{snake(k): v for k, v in args[0].items()})
        elif call["fn"] == "pipeTableToHtml" and len(args) > 1:
            from tgcli.render.html import escape_html
            from tgcli.render.table import escape_cell

            callback = escape_html if args[1]["callback"].endswith("&#39;") else escape_cell
            result = function(args[0], callback)
        else:
            result = function(*args)
        assert comparable(result) == call["out"], call["fn"]


def test_format_help_identical():
    from tgcli.render.format_help import format_help

    stdout = json.loads((FIXTURES / "format_help_stdout.json").read_bytes())["stdout"]
    assert (format_help() + "\n").encode() == stdout.encode()
