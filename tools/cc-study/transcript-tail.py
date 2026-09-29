#!/usr/bin/env python3
"""Print a compact view of the last N records of a Claude Code session JSONL.

One line per record: index, type, and the fields that identify the record
(uuid/parentUuid prefixes, timestamp, message role, content block types with
tool names / tool_use ids). Used as evidence for finding (c): what the
transcript tail looks like WHILE a prompt is pending vs AFTER it is answered.
"""
import json
import sys


def describe(rec: dict) -> str:
    t = rec.get("type")
    parts = [f"type={t}"]
    for k in ("subtype", "toolUseID", "timestamp", "isSidechain"):
        if k in rec:
            parts.append(f"{k}={rec[k]}")
    for k in ("uuid", "parentUuid"):
        if rec.get(k):
            parts.append(f"{k}={str(rec[k])[:8]}")
    msg = rec.get("message")
    if isinstance(msg, dict):
        parts.append(f"role={msg.get('role')}")
        content = msg.get("content")
        if isinstance(content, str):
            parts.append(f"text={content[:60]!r}")
        elif isinstance(content, list):
            blocks = []
            for b in content:
                if not isinstance(b, dict):
                    continue
                bt = b.get("type")
                if bt == "tool_use":
                    blocks.append(f"tool_use:{b.get('name')}:{str(b.get('id'))[:12]}")
                elif bt == "tool_result":
                    blocks.append(f"tool_result:{str(b.get('tool_use_id'))[:12]}:{str(b.get('content'))[:50]!r}")
                elif bt == "text":
                    blocks.append(f"text:{str(b.get('text'))[:50]!r}")
                else:
                    blocks.append(str(bt))
            parts.append("content=[" + ", ".join(blocks) + "]")
    if t not in ("user", "assistant"):
        extra = {k: v for k, v in rec.items() if k not in ("type", "uuid", "parentUuid", "timestamp", "message", "sessionId", "version", "cwd", "gitBranch", "userType", "isSidechain")}
        if extra:
            parts.append("extra=" + json.dumps(extra)[:200])
    return " ".join(parts)


def main() -> None:
    path = sys.argv[1]
    n = int(sys.argv[2]) if len(sys.argv) > 2 else 12
    lines = [l for l in open(path, encoding="utf-8") if l.strip()]
    print(f"# {path}\n# total_records={len(lines)} showing_last={min(n, len(lines))}")
    for i, line in enumerate(lines[-n:], start=len(lines) - min(n, len(lines)) + 1):
        try:
            rec = json.loads(line)
        except json.JSONDecodeError:
            print(f"{i}: <unparseable>")
            continue
        print(f"{i}: {describe(rec)}")


if __name__ == "__main__":
    main()
