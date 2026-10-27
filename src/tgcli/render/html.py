"""Pure Telegram HTML escaping, detection, and emoji entity rendering."""

import re

from tgcli.branding import emoji
from tgcli.branding.emoji import EmojiEntity, ParsedText
from tgcli.common.text import utf16_len


def escape_html(s: str) -> str:
    return (
        s.replace("&", "&amp;")
        .replace("<", "&lt;")
        .replace(">", "&gt;")
        .replace('"', "&quot;")
        .replace("'", "&#39;")
    )


def strip_html_tags(s: str) -> str:
    return re.sub(r"<[^>]*>|<[/!A-Za-z][^>]*\Z", "", s)


_HTML_ENTITIES = {
    "&amp;": "&",
    "&lt;": "<",
    "&gt;": ">",
    "&quot;": '"',
    "&#39;": "'",
    "&apos;": "'",
}


def decode_html_entities(s: str) -> str:
    return re.sub(r"&(?:amp|lt|gt|quot|apos|#39);", lambda m: _HTML_ENTITIES[m[0]], s)


def detect_html_tags(text: str) -> bool:
    return (
        re.search(
            r"<(b|strong|i|em|u|ins|s|strike|del|span|tg-spoiler|a|tg-emoji|tg-time|code|pre|blockquote)\b",
            text,
            re.IGNORECASE | re.ASCII,
        )
        is not None
    )


def parse_mode_for(format_value: str) -> str | None:
    return "HTML" if format_value == "html" else None


def _js_slice(s: str, start: int, end: int | None = None) -> str:
    """Raw JS slice: entity offsets may intentionally bisect a surrogate pair.

    Unlike safe_slice_end, String.slice never repairs an entity boundary.
    """
    raw = s.encode("utf-16-le", "surrogatepass")
    size = len(raw) // 2

    def bound(value: int) -> int:
        return min(value, size) if value >= 0 else max(size + value, 0)

    return raw[bound(start) * 2 : (size if end is None else bound(end)) * 2].decode(
        "utf-16-le", "surrogatepass"
    )


def convert_entities_to_html(text: str, entities: list[EmojiEntity], escape: bool = False) -> str:
    out = []
    cursor = 0
    for entity in sorted(entities, key=lambda e: e["offset"]):
        gap = _js_slice(text, cursor, entity["offset"])
        out.append(escape_html(gap) if escape else gap)
        content = _js_slice(text, entity["offset"], entity["offset"] + entity["length"])
        out.append(f'<tg-emoji emoji-id="{entity["custom_emoji_id"]}">{content}</tg-emoji>')
        cursor = entity["offset"] + entity["length"]
    tail = _js_slice(text, cursor)
    out.append(escape_html(tail) if escape else tail)
    return "".join(out)


def parse_emoji_helpers(text: str) -> ParsedText:
    result = ""
    entities: list[EmojiEntity] = []
    cursor = 0
    for match in re.finditer(r":([a-zA-Z0-9_-]+):", text):
        name = match[1].lower()
        emoji_id = emoji.EMBEDDABLE_EMOJI_MAP.get(name)
        unicode = emoji.UNICODE_EMOJI_MAP.get(name)
        result += text[cursor : match.start()]
        if emoji_id:
            placeholder = unicode or "🤖"
            entities.append(
                {
                    "type": "custom_emoji",
                    "offset": utf16_len(result),
                    "length": utf16_len(placeholder),
                    "custom_emoji_id": emoji_id,
                }
            )
            result += placeholder
        else:
            result += unicode or match[0]
        cursor = match.end()
    return {"text": result + text[cursor:], "entities": entities}
