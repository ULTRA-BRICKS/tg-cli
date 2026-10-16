"""Exact-recipient private-chat mirror, injected client; no bot fallback.

The status anchor is small; every transcript chunk replies to it. Telegram parse mode is
explicitly disabled so hostile text is literal. A partial mirror never permits ringing.
"""
import asyncio
from .core import ClientError


def chunks(text, limit=3500):
    current, size = [], 0
    for char in text:
        width = len(char.encode("utf-16-le")) // 2
        if size + width > limit:
            yield "".join(current)
            current, size = [], 0
        current.append(char)
        size += width
    if current:
        yield "".join(current)


STATUS_LABELS = {
    "подготовка": "Подготовка звонка", "intent": "Запланирован",
    "resolved": "Получатель проверен", "mirroring": "Отправляется текст",
    "mirrored": "Текст отправлен", "synthesizing": "Готовится голос",
    "prepared": "Голос подготовлен", "attempting": "Набор номера",
    "audio_stream_ended": "Аудиопоток завершён", "cancelled": "Отменён",
    "timeout": "Истекло время ожидания", "failed": "Ошибка",
}


def anchor_text(record, status):
    refs = record["references"]
    def reference(name):
        ref = refs[name]
        label = ref.get("title") or ref.get("id")
        if not label:
            return "неизвестно"
        if ref.get("title") and ref.get("id"):
            label += f" ({ref['id']})"
        return label[:200] + (f" — {ref['url'][:200]}" if ref.get("url") else "")
    kinds = {"report": "Отчёт", "question": "Вопрос", "problem": "Проблема"}
    lines = [f"Звонок {record['call_id']}",
             f"{reference('agent')} · {kinds.get(record['kind'], record['kind'])}",
             f"Задача: {reference('task')}", f"Время: {record.get('created_at', 'неизвестно')}",
             f"Статус: {STATUS_LABELS.get(status, status)}"]
    for name, title in (("project", "Проект"), ("session", "Сессия")):
        if any(refs[name].values()):
            lines.append(f"{title}: {reference(name)}")
    if record.get("caller_id") is not None:
        lines.append(f"Вызывающий аккаунт: {record['caller_id']}")
    if record.get("recipient_id") is not None:
        lines.append(f"Получатель: {record['recipient_id']}")
    if record.get("failure"):
        lines.append(f"Ошибка: {record['failure']}")
    lines.append("Исходящий текст; прослушивание не подтверждено.")
    return "\n".join(lines)


async def mirror(app, recipient, record, save, parse_mode, reply_to=None):
    ids = []
    async def send(text, reply):
        message = await asyncio.wait_for(app.send_message(
            recipient, text, parse_mode=parse_mode, reply_to_message_id=reply,
            disable_web_page_preview=True), 20)
        if message.chat.id != recipient or not isinstance(message.id, int) or message.id <= 0:
            raise ClientError("CALL_MIRROR_RECIPIENT_MISMATCH")
        ids.append(message.id)
        save(list(ids))
        return message.id
    anchor = await send(anchor_text(record, "подготовка"), reply_to)
    body = "Расшифровка исходящего сообщения:\n" + record["spoken_text"]
    if record["transcript_kind"] != "tts_input":
        body += "\nАудио: " + ("текст отправителя, не проверен: " + record["audio_transcript"] if record["audio_transcript"] else "содержание неизвестно; не транскрибировано")
    for chunk in chunks(body):
        await send(chunk, anchor)
    return ids


async def finish(app, recipient, record, parse_mode):
    message = await asyncio.wait_for(app.edit_message_text(
        recipient, record["mirror_ids"][0], anchor_text(record, record["status"]),
        parse_mode=parse_mode, disable_web_page_preview=True), 20)
    if message.chat.id != recipient or message.id != record["mirror_ids"][0]:
        raise ClientError("CALL_MIRROR_RECIPIENT_MISMATCH")
