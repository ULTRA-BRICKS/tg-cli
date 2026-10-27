"""Canonical mutable branding maps shared by renderers and runtime overrides."""

import re
from typing import TypedDict

EMBEDDABLE_EMOJI_MAP = {
    "hyperide": "5274191514178723918",
    "codex": "5273797309195393626",
    "openai": "5273797309195393626",
    "claude": "5274170649227600531",
    "anthropic": "5274170649227600531",
    "gemini": "5274254027427716477",
    "google": "5274254027427716477",
    "deepseek": "5274018976752511967",
    "qwen": "5274109179655661197",
    "alibaba": "5274109179655661197",
    "kimi": "5273889053991805596",
    "moonshot": "5273889053991805596",
    "o3": "5273797309195393626",
    "o1": "5273797309195393626",
    "gpt4": "5273797309195393626",
    "gpt3": "5273797309195393626",
    "llama": "5274259902942977093",
    "meta": "5274259902942977093",
    "ollama": "5273886056104634966",
    "mistral": "5273823740424134905",
    "grok": "5273973737861981852",
    "xai": "5273973737861981852",
    "copilot": "5274136375388580049",
    "github": "5274136375388580049",
    "perplexity": "5273733846758631156",
    "cursor": "5273731871073672487",
    "windsurf": "5273875761068025296",
    "devin": "5274170649227600531",
    "cognition": "5274170649227600531",
    "aider": "5274170649227600531",
    "continue": "5274170649227600531",
    "gpt": "5273797309195393626",
    "omp": "5274170649227600531",
}

MODEL_EMOJI_MAP = {
    "claude": "✳️",
    "anthropic": "✳️",
    "codex": "👐",
    "openai": "👐",
    "o3": "👐",
    "o1": "👐",
    "gpt4": "👐",
    "gpt3": "👐",
    "gemini": "♊️",
    "google": "♊️",
    "deepseek": "🐳",
    "qwen": "🟣",
    "alibaba": "🟣",
    "kimi": "🌙",
    "moonshot": "🌙",
    "glm": "🗂",
    "chatglm": "🗂",
    "llama": "🦙",
    "meta": "🦙",
    "ollama": "🦙",
    "mistral": "Ⓜ️",
    "grok": "🤘",
    "xai": "🤘",
    "copilot": "🦾",
    "github": "🦾",
    "perplexity": "🔮",
    "cursor": "👆",
    "windsurf": "🏄",
    "devin": "🧑\u200d💻",
    "cognition": "🧑\u200d💻",
    "aider": "🤝",
    "continue": "⏩",
    "omp": "🥧",
    "hyperide": "🚁",
    "fireworks": "🎆",
    "gpt": "⚡",
}

TAG_PILL_DOT = {"ANSWER": "🔵", "DECISION": "🟠", "PROBLEM": "🔴", "REPORT": "🟢"}

TAG_PILL_FALLBACK = {
    "ANSWER": "🔵 ANSWER",
    "DECISION": "🟠 DECISION",
    "PROBLEM": "🔴 PROBLEM",
    "REPORT": "🟢 REPORT",
}

TAG_PILL_IDS = {
    "ANSWER": ["5294303944082762041", "5294414440706382789", "5294185480294808567"],
    "DECISION": ["5294395852087926650", "5294110472985944747", "5294433613440395921"],
    "PROBLEM": ["5294376430245817725", "5294542383487164540", "5294432754446935044"],
    "REPORT": ["5294525981007062296", "5294382683718200108", "5294436190420770975"],
}

TAG_PILL_NEUTRAL_DOT = "▫️"

TAG_PILL_PLACEHOLDER = "PLACEHOLDER"

UNICODE_EMOJI_MAP = {
    "claude": "✳️",
    "anthropic": "✳️",
    "codex": "👐",
    "openai": "👐",
    "o3": "👐",
    "o1": "👐",
    "gpt4": "👐",
    "gpt3": "👐",
    "gpt": "⚡",
    "gemini": "♊️",
    "google": "♊️",
    "deepseek": "🐳",
    "qwen": "🟣",
    "alibaba": "🟣",
    "kimi": "🌙",
    "moonshot": "🌙",
    "glm": "🗂",
    "chatglm": "🗂",
    "llama": "🦙",
    "meta": "🦙",
    "ollama": "🦙",
    "mistral": "Ⓜ️",
    "grok": "🤘",
    "xai": "🤘",
    "copilot": "🦾",
    "github": "🦾",
    "perplexity": "🔮",
    "cursor": "👆",
    "windsurf": "🏄",
    "devin": "🧑\u200d💻",
    "cognition": "🧑\u200d💻",
    "aider": "🤝",
    "continue": "⏩",
    "omp": "🥧",
    "hyperide": "🚁",
    "fireworks": "🎆",
}

SUBSTRING_FALLBACK_EXCLUDED_KEYS = frozenset({"omp"})


class EmojiEntity(TypedDict):
    type: str
    offset: int
    length: int
    custom_emoji_id: str


class ParsedText(TypedDict):
    text: str
    entities: list[EmojiEntity]


def cell_dots_for(color_dot: str, cell_count: int) -> list[str]:
    if not color_dot or cell_count <= 0:
        return []
    return [color_dot] + [TAG_PILL_NEUTRAL_DOT] * (cell_count - 1)


def tag_pill_cell_dots(canonical_tag: str) -> list[str]:
    return cell_dots_for(
        TAG_PILL_DOT.get(canonical_tag, ""), len(TAG_PILL_IDS.get(canonical_tag, []))
    )


def has_real_pill_ids(canonical_tag: str) -> bool:
    ids = TAG_PILL_IDS.get(canonical_tag, [])
    return bool(ids) and all(re.fullmatch(r"[0-9]{15,}", value) is not None for value in ids)


def extract_base_model(model_name: str) -> str:
    lower = model_name.lower()
    if lower in MODEL_EMOJI_MAP or lower in EMBEDDABLE_EMOJI_MAP:
        return lower
    parts = re.split("[-_]", lower)
    for count in range(len(parts), 0, -1):
        prefix = "-".join(parts[:count])
        if prefix in MODEL_EMOJI_MAP or prefix in EMBEDDABLE_EMOJI_MAP:
            return prefix
    return lower
