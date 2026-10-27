"""Branded sender header composition, with a newline before the body."""

from dataclasses import dataclass

from tgcli.branding import emoji
from tgcli.common.js_string import js_trim
from tgcli.prefix_style.style import style_task_title, style_window_name, to_bold_italic
from tgcli.render.html import escape_html
from tgcli.render.tag import resolve_tag


@dataclass(frozen=True)
class PrefixParts:
    html: str
    plain: str
    present: bool
    force_html: bool


def build_prefix(
    *,
    ai_emoji: str,
    model: str,
    tmux_window: str,
    agent_label: str | None = None,
    tag: str | None = None,
    title: str | None = None,
) -> PrefixParts:
    html = ""
    plain = ""
    force_html = False
    if ai_emoji:
        base = emoji.extract_base_model(model)
        emoji_id = emoji.EMBEDDABLE_EMOJI_MAP.get(base)
        if not isinstance(emoji_id, str):
            emoji_id = None
        if not emoji_id:
            for key, value in emoji.EMBEDDABLE_EMOJI_MAP.items():
                if key not in emoji.SUBSTRING_FALLBACK_EXCLUDED_KEYS and key in base:
                    emoji_id = value
                    break
        if emoji_id:
            html += f'<tg-emoji emoji-id="{emoji_id}">{ai_emoji}</tg-emoji>'
            force_html = True
        else:
            html += escape_html(ai_emoji)
        plain += ai_emoji
    for label in [tmux_window, agent_label]:
        if label:
            if plain:
                html += " "
                plain += " "
            styled = style_window_name(label)
            html += f"[{styled.html}]"
            plain += f"[{styled.plain}]"
            force_html = force_html or styled.tag
    if tag and js_trim(tag):
        resolved = resolve_tag(tag)
        sep = " " if plain else ""
        if resolved.known and emoji.has_real_pill_ids(resolved.word):
            html += sep + "".join(
                f'<tg-emoji emoji-id="{value}">'
                f"{
                    escape_html(
                        resolved.cell_dots[i] if i < len(resolved.cell_dots) else resolved.dot
                    )
                }"
                "</tg-emoji>"
                for i, value in enumerate(emoji.TAG_PILL_IDS[resolved.word])
            )
            plain += sep + resolved.fallback
            force_html = True
        else:
            badge = resolved.fallback if resolved.known else f"[{resolved.word}]"
            html += sep + escape_html(badge)
            plain += sep + badge
    if title and js_trim(title):
        raw = js_trim(title)
        sep = (" — " if tag and js_trim(tag) else " ") if plain else ""
        html += sep + style_task_title(raw)
        styled_title = to_bold_italic(raw)
        plain += sep + (raw if styled_title is None else styled_title)
        force_html = force_html or styled_title is None
    if not plain and not html:
        return PrefixParts("", "", False, False)
    return PrefixParts(html + "\n", plain + "\n", True, force_html)
