"""Pure call preparation shared by every one-shot frontdoor.

IDs are references, never inferred from cwd/PID. Text is data, never a shell command.
"""
import os
from .core import ClientError

KINDS = {"report": "Отчёт", "question": "Вопрос", "problem": "Проблема"}
REFERENCE_NAMES = ("agent", "task", "project", "session")


def prepare(args, env=None):
    env = os.environ if env is None else env
    kind = getattr(args, "kind", None) or "report"
    if kind not in KINDS:
        raise ClientError("CALL_KIND_INVALID")
    token = getattr(args, "idempotency_key", None)
    if token is not None and (not token or len(token) > 200 or any(ord(c) < 32 for c in token)):
        raise ClientError("CALL_TOKEN_INVALID")
    refs = {}
    for name in REFERENCE_NAMES:
        fallback = env.get("RIG_AGENT_ID") if name == "agent" else env.get("TG_SESSION") if name == "session" else None
        refs[name] = {
            "id": getattr(args, name, None) or fallback or None,
            "title": getattr(args, name + "_title", None) or None,
            "url": getattr(args, name + "_url", None) or None,
        }
        for value in refs[name].values():
            if value and (len(value) > 512 or any(ord(c) < 32 for c in value)):
                raise ClientError("CALL_REFERENCE_INVALID")
        url = refs[name]["url"]
        if url and not url.startswith(("https://", "http://")):
            raise ClientError("CALL_REFERENCE_INVALID")
    def label(name):
        ref = refs[name]
        return ref["title"] or ref["id"]
    agent = label("agent") or "Агент неизвестен"
    task = label("task") or ("неизвестной задачей" if kind == "problem" else "неизвестной задаче")
    connector = "с" if kind == "problem" else "по"
    intro = f"Привет! {agent}. {KINDS[kind]} {connector} {task}."
    if label("project"):
        intro += f" Проект {label('project')}."
    audio = getattr(args, "audio", None)
    source = getattr(args, "say", None)
    transcript = getattr(args, "transcript", None)
    if audio is None and (source is None or not source.strip()):
        raise ClientError("TEXT_EMPTY")
    if audio is None and len(source) > 1000:
        raise ClientError("TEXT_TOO_LONG")
    if transcript is not None and len(transcript) > 100_000:
        raise ClientError("TEXT_TOO_LONG")
    if audio is not None:
        spoken = intro + (" Далее аудио; текст предоставлен отправителем." if transcript else " Далее аудио; содержание неизвестно.")
        transcript_kind = "sender_provided_unverified" if transcript else "unknown"
    else:
        spoken = intro + " " + source
        transcript_kind = "tts_input"
    return {"kind": kind, "references": refs, "intro": intro, "spoken_text": spoken,
            "source_text": source, "audio_transcript": transcript,
            "transcript_kind": transcript_kind, "audio_recorded": False,
            "recipient_replies_captured": False}
