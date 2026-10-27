"""Validated English message tags and canonical badge resolution."""

from dataclasses import dataclass

from tgcli.branding import emoji
from tgcli.common.js_string import js_trim

CANONICAL_TAGS = ["ANSWER", "DECISION", "PROBLEM", "REPORT"]
ESCALATION_TAGS = ["decision"]
ACCEPTED_TAGS = [tag.lower() for tag in CANONICAL_TAGS]
ACCEPTED_TAGS_LIST = ", ".join(ACCEPTED_TAGS)
REMOVED_QUESTION_TAG_HINT = (
    "--tag question was removed: an open question is a decision request — "
    "use --tag decision in the decision-request format"
)


def is_escalation_tag(tag: str) -> bool:
    return tag in ESCALATION_TAGS


def validate_tag(raw: str) -> str | None:
    value = js_trim(raw)
    if value in ACCEPTED_TAGS:
        return None
    if value == "question":
        return REMOVED_QUESTION_TAG_HINT
    return (
        f"invalid --tag '{value}': tags must be lowercase english. Use one of: {ACCEPTED_TAGS_LIST}"
    )


@dataclass(frozen=True)
class ResolvedTag:
    fallback: str
    dot: str
    cell_dots: list[str]
    word: str
    known: bool


def resolve_tag(raw: str) -> ResolvedTag:
    key = js_trim(raw).upper()
    if key in CANONICAL_TAGS:
        return ResolvedTag(
            emoji.TAG_PILL_FALLBACK[key],
            emoji.TAG_PILL_DOT[key],
            emoji.tag_pill_cell_dots(key),
            key,
            True,
        )
    return ResolvedTag("", "", [], key, False)
