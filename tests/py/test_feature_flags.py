import pytest

from tgcli.auto_attach.feature_flags import (
    DEFAULT_FEATURES,
    FeatureOverrides,
    apply_feature_flags,
    parse_feature_config,
    resolve_features,
)


@pytest.mark.parametrize(
    ("text", "expected"),
    [
        (
            "features:\n  md-as-pdf: true\n  other: false\n",
            {"md-as-pdf": True, "other": False},
        ),
        ("", {}),
        ("# just a comment\n", {}),
        ("features:\n  # c\n  md-as-pdf: false\n", {"md-as-pdf": False}),
        (
            "features:\n  a: yes\n  b: no\n  c: on\n  d: off\n  e: 1\n  f: 0\n",
            {"a": True, "b": False, "c": True, "d": False, "e": True, "f": False},
        ),
        ('features:\n  "a": TRUE # c\n  b: maybe\nother:\n  c: on\n', {"a": True}),
    ],
)
def test_parse_feature_config(text, expected):
    assert parse_feature_config(text) == expected


def test_resolve_feature_defaults_and_overrides():
    r = resolve_features({}, FeatureOverrides([], []))
    for name in [
        "md-as-pdf",
        "cjk-guard",
        "screenshot-guard",
        "file-mention-guard",
        "autolink-msgref-preview",
    ]:
        assert r[name] is True
    assert "auto-attach" not in DEFAULT_FEATURES
    assert "recursive-attach" not in DEFAULT_FEATURES
    assert resolve_features({"md-as-pdf": False}, FeatureOverrides([], []))["md-as-pdf"] is False
    assert (
        resolve_features({"md-as-pdf": False}, FeatureOverrides(["md-as-pdf"], []))["md-as-pdf"]
        is True
    )
    assert resolve_features({}, FeatureOverrides([], ["md-as-pdf"]))["md-as-pdf"] is False
    assert resolve_features({}, FeatureOverrides(["x"], ["x"]))["x"] is False
    assert (
        resolve_features({}, FeatureOverrides([], ["autolink-msgref-preview"]))[
            "autolink-msgref-preview"
        ]
        is False
    )
    assert (
        resolve_features(
            parse_feature_config("features:\n  autolink-msgref-preview: false\n"),
            FeatureOverrides([], []),
        )["autolink-msgref-preview"]
        is False
    )


def test_apply_feature_flags():
    r = apply_feature_flags(["--feature", "md-as-pdf", "hi", "--no-feature", "x"])
    assert (r.enable, r.disable, r.rest, r.error) == (
        ["md-as-pdf"],
        ["x"],
        ["hi"],
        None,
    )
    r = apply_feature_flags(["--format", "html", "msg"])
    assert (r.enable, r.disable, r.rest, r.error) == (
        [],
        [],
        ["--format", "html", "msg"],
        None,
    )


@pytest.mark.parametrize(
    "args",
    [["--feature"], ["--no-feature"], ["--feature", ""], ["--no-feature", "--format"]],
)
def test_apply_feature_missing_value(args):
    assert apply_feature_flags(args).error == args[0] + " requires a feature name"


@pytest.mark.parametrize(
    ("text", "expected"),
    [
        ("features:\n\ufeffhooks:\ufeffyes\n", {"hooks": True}),
        ("features:\n  hooks: yes\ufeff#comment\n", {"hooks": True}),
        ("features:\n  hooks: yes\x85#comment\n", {}),
        ("features:\n  hooks: yes #comment\r\n", {}),
        ("features:\u2028metadata\n  hooks: true\n", {}),
        ("features:\n\x85hooks: true\n", {}),
    ],
)
def test_features_ecmascript_whitespace_and_comment_boundaries(text, expected):
    assert parse_feature_config(text) == expected
