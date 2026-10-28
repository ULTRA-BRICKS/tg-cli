#!/usr/bin/env python3
"""Import older Telegram history into an ARCHIVE next to the live `tg replies` store.

Why an archive: the live file `tg-ctl.<botid>.history.jsonl` is trimmed to its last
MAX_HISTORY (5000) rows on every write (features/replies/history.ts), so anything imported
into it is dropped within a few sends. The archive uses the SAME row shape (HistoryRecord)
so `tg replies`-style readers can consume it, plus a few informational extras that readers
ignore: `source`, `importKey`, `kind`, `mtprotoId`, `entities`, `flags`, `sessionKey`.
`ts` is unix SECONDS everywhere (HistoryRecord.ts, MTProto `date`, transcript `ts`).

Sources (any combination, all read-only):
  --mtproto FILE      JSONL dump of the owner<->bot chat read over the owner's MTProto session
                      (fields id, date, out, text, raw_media, entities). Rendered text, so
                      sendRichMessage bodies are unreadable there and get a placeholder row.
  --transcripts FILE  rows from the harness-transcript extractor (the `tg` command of a session;
                      the body is recovered from heredoc/quoted argv). Authored markup.
  --history FILE      another host's/backup's tg-ctl history jsonl, copied row for row.

Guarantees: idempotent (importKey), deduplicated, chronological, secrets scrubbed, archive is
0600 and written atomically, the live file is never written. Refs tg-cli #815 / #813.
Only the MTProto source is cut at the live store's oldest row (its rendered text can never match
the live store's authored markup). Transcript and history rows are not cut: they are deduplicated
against the live store and the archive by (chat, direction, ts, scrubbed text) instead.
"""

import argparse
import contextlib
import fcntl
import hashlib
import json
import os
import re
import sys
import tempfile
from collections import Counter
from pathlib import Path


def _placeholder(name: str):
    return lambda m: f"<{name}>"


# Order matters: patterns run top to bottom. A placeholder starts with `<`, which no value class
# below accepts, so an already-scrubbed value is never scrubbed twice.
SECRET_PATTERNS = [
    (re.compile(r"\b\d{8,10}:[A-Za-z0-9_-]{30,}\b"), _placeholder("TG_BOT_TOKEN")),
    (
        re.compile(r"\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})\b"),
        _placeholder("GH_TOKEN"),
    ),
    (re.compile(r"\bglpat-[A-Za-z0-9_-]{16,}\b"), _placeholder("GL_TOKEN")),
    (re.compile(r"\b(?:sk|pk|rk)-[A-Za-z0-9_-]{16,}\b"), _placeholder("API_KEY")),
    (re.compile(r"\bxox[abposr]-[A-Za-z0-9-]{10,}\b"), _placeholder("SLACK")),
    (re.compile(r"\b(?:AKIA|ASIA)[0-9A-Z]{16}\b"), _placeholder("AWS_KEY")),
    (re.compile(r"\bAIza[0-9A-Za-z_-]{30,}\b"), _placeholder("GOOGLE_KEY")),
    (
        re.compile(r"\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b"),
        _placeholder("JWT"),
    ),
    (
        re.compile(
            r"-----BEGIN [A-Z ]*PRIVATE KEY-----.*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)", re.S
        ),
        _placeholder("PRIVATE_KEY"),
    ),
    (re.compile(r"(?<=://)[^\s/:@]+:[^\s/@]+(?=@)"), _placeholder("URL_CREDS")),
    (
        re.compile(r"(?i)\b(bearer|token)\s+[A-Za-z0-9._~+/=-]{20,}"),
        lambda m: m.group(1) + " <BEARER>",
    ),
    (
        re.compile(
            r"(?i)\b(authorization\s*[:=]\s*)"
            r"(?:basic|bearer|digest|negotiate|ntlm|token|aws4-hmac-sha256)\s+[A-Za-z0-9+/._~=-]{4,}"
        ),
        lambda m: m.group(1) + "<AUTH_CREDENTIAL>",
    ),
    (
        re.compile(
            # AUTH is a keyword on its own (BASIC_AUTH=, OAUTH=) but not inside the words AUTHOR /
            # AUTHENTIC..., which are prose; AUTHORIZATION is its own keyword.
            r"(?i)\b([A-Z0-9_]*(?:TOKEN|SECRET|PASSWORD|PASSWD|API_?KEY|AUTHORIZATION|CREDENTIAL"
            r"|AUTH(?!OR|ENTIC))[A-Z0-9_]*)"
            r"\s*[=:]\s*[\"']?[^\s\"'<>|&;]{6,}"
        ),
        lambda m: m.group(1) + "=<ASSIGNED_SECRET>",
    ),
    (re.compile(r"\b[0-9a-f]{40,}\b"), _placeholder("HEX_SECRET")),
    (re.compile(r"\b[A-Za-z0-9+/_-]{48,}={0,2}\b"), _placeholder("B64_SECRET")),
]


def scrub(text: str) -> str:
    """Replace anything token-, key- or password-shaped with a typed placeholder."""
    for rx, repl in SECRET_PATTERNS:
        text = rx.sub(repl, text)
    return text


HEREDOC = re.compile(r"<<-?\s*['\"]?(\w+)['\"]?[^\n]*\n(.*?)\n[ \t]*\1[ \t]*(?:\n|$|\)|\")", re.S)
QUOTED = re.compile(r"\"((?:[^\"\\]|\\.)*)\"|'([^']*)'", re.S)
TG_MARK = "# --- tg command ---"


def extract_tg_body(command: str) -> str:
    """Best-effort message body of a `tg` shell command: heredoc, else longest quoted argv."""
    command = command.split(TG_MARK)[-1]
    best = ""
    for m in HEREDOC.finditer(command):
        if len(m.group(2)) > len(best):
            best = m.group(2)
    if best:
        return best
    for m in QUOTED.finditer(command):
        value = m.group(1) if m.group(1) is not None else m.group(2)
        if len(value) > len(best):
            best = value
    return best or command


def key_of(*parts: object) -> str:
    # 80 bits of SHA-1 is ample for an archive of tens of thousands of rows; it is an id, not a MAC.
    return hashlib.sha1("\x1f".join(str(p) for p in parts).encode()).hexdigest()[:20]


def read_jsonl(path: Path) -> list[dict]:
    rows: list[dict] = []
    for line in path.read_text(encoding="utf-8", errors="replace").splitlines():
        if not line.strip():
            continue
        try:
            value = json.loads(line)
        except json.JSONDecodeError:
            continue
        if isinstance(value, dict):
            rows.append(value)
    return rows


def is_int(value: object) -> bool:
    return isinstance(value, int) and not isinstance(value, bool)


def is_row(r: dict) -> bool:
    """A usable history row: integer-seconds ts and a text."""
    return is_int(r.get("ts")) and isinstance(r.get("text"), str)


def base_row(ts: int, chat_id: int, direction: str, sender: str, text: str) -> dict:
    return {
        "ts": ts,
        "message_id": None,
        "chat_id": chat_id,
        "direction": direction,
        "from": sender,
        "text": scrub(text),
        "pane": None,
    }


def mtproto_text(r: dict) -> tuple[str, str] | None:
    """(text, kind) for one dump row, a placeholder for media-only rows, None to skip."""
    text = r.get("text")
    if isinstance(text, str) and text:
        return text, "rendered"
    media = r.get("raw_media") or r.get("media")
    placeholders = {
        "MessageMediaUnsupported": (
            "[rich message: content unreadable over MTProto]",
            "rich-unreadable",
        ),
        "MessageMediaPhoto": ("[photo]", "rendered"),
        "MessageMediaDocument": ("[document]", "rendered"),
    }
    return placeholders.get(media) if isinstance(media, str) else None


def mtproto_row(r: dict, chat_id: int, owner: str) -> dict | None:
    ts = r.get("date")
    message_id = r.get("id")
    found = mtproto_text(r)
    # Without an integer id the import key is not unique: every such row would collapse into one.
    if not is_int(ts) or not is_int(message_id) or found is None:
        return None
    text, kind = found
    outgoing = r.get("out") is True
    row = base_row(
        ts, chat_id, "user" if outgoing else "agent", owner if outgoing else "agent", text
    )
    row.update(
        {
            "source": "mtproto",
            "kind": kind,
            "mtprotoId": r.get("id"),
            "importKey": key_of("mtproto", chat_id, r.get("id")),
        }
    )
    if r.get("entities"):
        row["entities"] = r["entities"]
    return row


def mtproto_rows(path: Path, chat_id: int, owner: str, live_min_ts: int | None) -> list[dict]:
    rows = (mtproto_row(r, chat_id, owner) for r in read_jsonl(path))
    # The live store holds its own window with the authored markup, so skip that window here.
    return [
        row for row in rows if row is not None and (live_min_ts is None or row["ts"] < live_min_ts)
    ]


def transcript_rows(path: Path, chat_id: int) -> list[dict]:
    out: list[dict] = []
    for r in read_jsonl(path):
        ts = r.get("ts")
        command = r.get("command")
        if not is_int(ts) or not isinstance(command, str):
            continue
        row = base_row(ts, chat_id, "agent", "agent", extract_tg_body(command))
        row.update(
            {
                "source": f"transcript:{r.get('host')}:{r.get('harness')}",
                "kind": "authored",
                "flags": r.get("flags") or [],
                "importKey": key_of(
                    "transcript", r.get("host"), r.get("file"), r.get("line"), ts, command
                ),
            }
        )
        if r.get("session"):
            row["sessionKey"] = f"{r.get('harness')}:{r['session']}"
        out.append(row)
    return out


def history_rows(path: Path, chat_id: int) -> list[dict]:
    out: list[dict] = []
    occurrences: Counter[tuple] = Counter()
    for r in read_jsonl(path):
        if not is_row(r) or r.get("direction") not in ("user", "agent"):
            continue
        row = {k: v for k, v in r.items() if k != "importKey"}
        row["text"] = scrub(row["text"])
        row.setdefault("chat_id", chat_id)
        row["source"] = "history:" + path.name
        # Same-second identical messages are distinct rows: number the occurrences.
        ident = (row["direction"], row["ts"], row.get("message_id"), row["text"])
        occurrences[ident] += 1
        row["importKey"] = key_of("history", *ident, occurrences[ident])
        out.append(row)
    return out


def content_key(row: dict) -> str:
    # Scrub here too: live-store rows are raw, incoming rows are already scrubbed.
    return key_of(
        "content", row.get("chat_id"), row.get("direction"), row.get("ts"), scrub(row["text"])
    )


def write_private(path: Path, rows: list[dict]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, tmp = tempfile.mkstemp(dir=path.parent, prefix=path.name + ".")
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as handle:
            for row in rows:
                handle.write(json.dumps(row, ensure_ascii=False) + "\n")
            handle.flush()
            os.fsync(handle.fileno())
        os.chmod(tmp, 0o600)  # mkstemp is already 0600; stated so the mode survives a refactor
        os.replace(tmp, path)
    except BaseException:
        Path(tmp).unlink(missing_ok=True)
        raise


def parse(argv: list[str]) -> argparse.Namespace:
    p = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter
    )
    p.add_argument("--archive", required=True, type=Path, help="archive JSONL to create/extend")
    p.add_argument(
        "--live-history", required=True, type=Path, help="live tg-ctl history (read only)"
    )
    p.add_argument("--chat-id", required=True, type=int)
    p.add_argument(
        "--owner-name", default="Alex", help="`from` of the owner's rows (live store: Alex)"
    )
    p.add_argument("--mtproto", action="append", default=[], type=Path)
    p.add_argument("--transcripts", action="append", default=[], type=Path)
    p.add_argument("--history", action="append", default=[], type=Path)
    p.add_argument("--dry-run", action="store_true")
    return p.parse_args(argv)


def load_incoming(args: argparse.Namespace, live_min: int | None) -> list[dict]:
    incoming: list[dict] = []
    for path in args.mtproto:
        incoming += mtproto_rows(path, args.chat_id, args.owner_name, live_min)
    for path in args.transcripts:
        incoming += transcript_rows(path, args.chat_id)
    for path in args.history:
        incoming += history_rows(path, args.chat_id)
    return incoming


def new_rows(incoming: list[dict], existing: list[dict], live_rows: list[dict]) -> list[dict]:
    """Rows unknown by import key and, against the archive and live store, by content.

    Content is NOT deduplicated inside one incoming batch: two identical same-second messages are
    two rows (their import keys differ).
    """
    seen_keys = {r.get("importKey") for r in existing}
    known_content = {content_key(r) for r in existing} | {content_key(r) for r in live_rows}
    added: list[dict] = []
    for row in incoming:
        if row["importKey"] in seen_keys or content_key(row) in known_content:
            continue
        seen_keys.add(row["importKey"])
        added.append(row)
    return added


def lock_path(archive: Path) -> Path:
    """The lock file of one archive, named from its resolved path so every spelling shares it."""
    resolved = archive.resolve()
    return resolved.with_name(resolved.name + ".lock")


@contextlib.contextmanager
def archive_lock(archive: Path):
    """One importer at a time per archive: a second concurrent run would lose rows."""
    lock = lock_path(archive)
    lock.parent.mkdir(parents=True, exist_ok=True)
    fd = os.open(lock, os.O_RDWR | os.O_CREAT, 0o600)
    with os.fdopen(fd, "w") as handle:
        fcntl.flock(handle, fcntl.LOCK_EX)
        yield


def split_rows(path: Path) -> tuple[list[dict], list[dict]]:
    """(usable rows, foreign rows) of a JSONL file; a missing file is empty."""
    stored = read_jsonl(path) if path.exists() else []
    return [r for r in stored if is_row(r)], [r for r in stored if not is_row(r)]


def main(argv: list[str]) -> int:
    args = parse(argv)
    if args.archive.resolve() == args.live_history.resolve():
        raise SystemExit("refusing: the archive must not be the live history file")
    for source in (*args.mtproto, *args.transcripts, *args.history):
        if not source.is_file():
            raise SystemExit(f"refusing: no such source file: {source}")
    # A dry run writes nothing, so it takes no lock and creates no archive directory.
    with contextlib.nullcontext() if args.dry_run else archive_lock(args.archive):
        existing, foreign = split_rows(args.archive)  # hand-edited rows are kept, at the end
        live_rows, _ = split_rows(args.live_history)
        stamps = [r["ts"] for r in live_rows]
        incoming = load_incoming(args, min(stamps) if stamps else None)
        added = new_rows(incoming, existing, live_rows)
        merged = sorted(existing + added, key=lambda r: r["ts"]) + foreign  # stable on ties
        report = {
            "dry_run": args.dry_run,
            "incoming": len(incoming),
            "added": len(added),
            "total": len(merged),
            "by_source": dict(Counter(r["source"] for r in added)),
        }
        if not args.dry_run and added:
            write_private(args.archive, merged)
    print(json.dumps(report, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
