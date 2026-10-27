"""Unicode mathematical prefix styles with whole-token HTML fallbacks."""

from dataclasses import dataclass

from tgcli.prefix_style._unicode_letters import is_bun_letter


def escape_html(s: str) -> str:
    return s.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")


def _style_latin(
    s: str, upper_base: int, lower_base: int, digit_base: int | None = None
) -> str | None:
    if any(not ("a" <= ch <= "z" or "A" <= ch <= "Z") and is_bun_letter(ch) for ch in s):
        return None
    out = []
    for ch in s:
        if "A" <= ch <= "Z":
            out.append(chr(upper_base + ord(ch) - 65))
        elif "a" <= ch <= "z":
            out.append(chr(lower_base + ord(ch) - 97))
        elif digit_base is not None and "0" <= ch <= "9":
            out.append(chr(digit_base + ord(ch) - 48))
        else:
            out.append(ch)
    return "".join(out)


def to_sans_bold(s: str) -> str | None:
    return _style_latin(s, 0x1D5D4, 0x1D5EE, 0x1D7EC)


def to_bold_italic(s: str) -> str | None:
    return _style_latin(s, 0x1D468, 0x1D482)


@dataclass(frozen=True)
class StyledToken:
    html: str
    plain: str
    tag: bool


def style_window_name(name: str) -> StyledToken:
    uni = to_sans_bold(name)
    if uni is not None:
        return StyledToken(escape_html(uni), uni, False)
    return StyledToken(f"<b>{escape_html(name)}</b>", name, True)


def style_task_title(raw: str) -> str:
    uni = to_bold_italic(raw)
    return escape_html(uni) if uni is not None else f"<i>{escape_html(raw)}</i>"
