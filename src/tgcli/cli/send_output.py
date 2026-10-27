"""The stable stdout receipt after successful sends, in wire order."""

from tgcli.common.js_number import js_integer
from tgcli.common.jsonio import js_stringify


def format_send_output(ids: list[int]) -> str:
    refs: list[str] = []
    for value in ids:
        integer = js_integer(value)
        if integer is not None and integer > 0:
            refs.append("tg#" + js_stringify(integer))
    return "OK " + " ".join(refs) if refs else "OK"
