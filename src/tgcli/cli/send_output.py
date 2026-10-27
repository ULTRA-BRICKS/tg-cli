"""The stable stdout receipt after successful sends, in wire order."""


def format_send_output(ids: list[int]) -> str:
    refs = [
        f"tg#{int(value)}"
        for value in ids
        if type(value) in (int, float) and value > 0 and value % 1 == 0
    ]
    return "OK " + " ".join(refs) if refs else "OK"
