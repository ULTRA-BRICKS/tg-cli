"""Tests for scripts/history-archive-import.py (Refs #815, #813).

The importer adds history that the capped live store (MAX_HISTORY = 5000 rows) no longer holds
to a sibling archive in the SAME row format `tg replies` reads. It must be idempotent, never
touch the live file, scrub secrets and keep message timestamps.
"""

import importlib.util
import json
import stat
from pathlib import Path
from types import ModuleType

import pytest

SCRIPT = Path(__file__).resolve().parents[2] / "scripts" / "history-archive-import.py"
CHAT = 1001
FAKE_TOKEN = "1234567890:AAH" + "x" * 32  # shaped like a bot token, not a real one


def load() -> ModuleType:
    spec = importlib.util.spec_from_file_location("history_archive_import", SCRIPT)
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def jl(path: Path, rows: list[dict]) -> Path:
    path.write_text("".join(json.dumps(r, ensure_ascii=False) + "\n" for r in rows))
    return path


def read(path: Path) -> list[dict]:
    return [json.loads(line) for line in path.read_text().splitlines() if line.strip()]


def mt(
    i: int,
    date: int,
    text: str | None,
    out: bool = False,
    media: object = None,
    entities: list | None = None,
) -> dict:
    return {
        "id": i,
        "date": date,
        "out": out,
        "text": text,
        "raw_media": media,
        "entities": entities or [],
        "reply_to": None,
    }


def hr(ts: int, text: str, message_id: int | None = None, **extra: object) -> dict:
    """A history-file row as another host's `tg` wrote it."""
    return {
        "ts": ts,
        "message_id": message_id,
        "direction": "agent",
        "from": "agent",
        "text": text,
        "pane": None,
        **extra,
    }


@pytest.fixture
def env(tmp_path: Path) -> dict:
    live = jl(
        tmp_path / "live.jsonl",
        [
            {
                "ts": 2000,
                "message_id": 19184,
                "chat_id": CHAT,
                "direction": "agent",
                "from": "agent",
                "text": "<b>live</b>",
                "pane": None,
            },
            {
                "ts": 2010,
                "message_id": 19185,
                "chat_id": CHAT,
                "direction": "user",
                "from": "Alex",
                "text": "same text as mtproto owner row",
                "pane": None,
            },
        ],
    )
    return {"tmp": tmp_path, "live": live, "archive": tmp_path / "archive.jsonl"}


def run(mod: ModuleType, env: dict, *extra: str) -> int:
    code = mod.main(
        [
            "--archive",
            str(env["archive"]),
            "--live-history",
            str(env["live"]),
            "--chat-id",
            str(CHAT),
            *extra,
        ]
    )
    assert code == 0
    return code


def test_mtproto_rows_keep_timestamps_and_split_by_direction(env: dict) -> None:
    mod = load()
    dump = jl(
        env["tmp"] / "mt.jsonl",
        [
            mt(1, 1000, "agent says hi"),
            mt(2, 1001, "owner answers", out=True),
            mt(3, 1002, "same text as mtproto owner row", out=True),
        ],
    )
    assert run(mod, env, "--mtproto", str(dump)) == 0
    rows = read(env["archive"])
    assert len(rows) == 3
    by_text = {r["text"]: r for r in rows}
    assert by_text["agent says hi"]["direction"] == "agent"
    assert by_text["agent says hi"]["ts"] == 1000
    assert by_text["agent says hi"]["message_id"] is None
    assert by_text["agent says hi"]["chat_id"] == CHAT
    assert by_text["owner answers"]["direction"] == "user"
    assert by_text["owner answers"]["from"] == "Alex"
    assert [r["ts"] for r in rows] == sorted(r["ts"] for r in rows)


def test_rows_covered_by_the_live_store_are_not_imported(env: dict) -> None:
    mod = load()
    dump = jl(
        env["tmp"] / "mt.jsonl",
        [
            mt(1, 1990, "older than the live store"),
            mt(2, 2005, "inside the live window, rendered twin of a live row"),
            mt(3, 2012, "same text as mtproto owner row", out=True),
        ],
    )
    run(mod, env, "--mtproto", str(dump))
    texts = [r["text"] for r in read(env["archive"])]
    assert texts == ["older than the live store"]


def test_import_is_idempotent(env: dict) -> None:
    mod = load()
    dump = jl(env["tmp"] / "mt.jsonl", [mt(1, 100, "one"), mt(2, 101, "two", out=True)])
    run(mod, env, "--mtproto", str(dump))
    first = env["archive"].read_bytes()
    run(mod, env, "--mtproto", str(dump))
    assert env["archive"].read_bytes() == first


def test_second_source_merges_in_timestamp_order_without_duplicates(env: dict) -> None:
    mod = load()
    dump = jl(env["tmp"] / "mt.jsonl", [mt(1, 300, "late"), mt(2, 100, "early")])
    run(mod, env, "--mtproto", str(dump))
    hist = jl(
        env["tmp"] / "other-host-history.jsonl",
        [
            hr(200, "mid", message_id=7),
            hr(100, "early"),
        ],
    )
    run(mod, env, "--history", str(hist))
    rows = read(env["archive"])
    assert [r["text"] for r in rows] == ["early", "mid", "late"]


def test_secrets_are_scrubbed_everywhere(env: dict) -> None:
    mod = load()
    dump = jl(
        env["tmp"] / "mt.jsonl",
        [
            mt(1, 10, f"use token {FAKE_TOKEN} please"),
            mt(2, 11, "GITHUB_TOKEN=ghp_abcdefghijklmnopqrstuvwxyz0123456789", out=True),
        ],
    )
    run(mod, env, "--mtproto", str(dump))
    blob = env["archive"].read_text()
    assert FAKE_TOKEN not in blob
    assert "ghp_" not in blob
    assert "<TG_BOT_TOKEN>" in blob


def test_media_only_and_unreadable_rich_rows_get_placeholders(env: dict) -> None:
    mod = load()
    dump = jl(
        env["tmp"] / "mt.jsonl",
        [
            mt(1, 10, None, media="MessageMediaUnsupported"),
            mt(2, 11, None, media="MessageMediaPhoto"),
            mt(3, 12, None, media="MessageMediaDocument"),
        ],
    )
    run(mod, env, "--mtproto", str(dump))
    rows = read(env["archive"])
    assert rows[0]["kind"] == "rich-unreadable"
    assert rows[0]["text"].startswith("[rich message")
    assert rows[1]["text"] == "[photo]"
    assert rows[2]["text"] == "[document]"


def test_transcript_rows_become_agent_rows_with_the_tg_body(env: dict) -> None:
    mod = load()
    command = (
        "tg --format html --tag report \"$(cat <<'EOF'\n"
        '<h3>Context</h3>\n| a | b |\n|---|---|\n| 1 | 2 |\nEOF\n)"'
    )
    tr = jl(
        env["tmp"] / "pc-omp.jsonl",
        [
            {
                "host": "pc",
                "harness": "omp",
                "file": "s/x.jsonl",
                "line": 3,
                "session": "abc",
                "ts": 50,
                "command": command,
                "flags": ["--format html", "--tag report"],
                "result": "OK tg#1",
                "result_error": False,
            }
        ],
    )
    run(mod, env, "--transcripts", str(tr))
    (row,) = read(env["archive"])
    assert row["direction"] == "agent"
    assert row["text"] == "<h3>Context</h3>\n| a | b |\n|---|---|\n| 1 | 2 |"
    assert row["sessionKey"] == "omp:abc"
    assert row["source"] == "transcript:pc:omp"
    assert row["flags"] == ["--format html", "--tag report"]


def test_dry_run_writes_nothing_and_reports_counts(
    env: dict, capsys: pytest.CaptureFixture
) -> None:
    mod = load()
    dump = jl(env["tmp"] / "mt.jsonl", [mt(1, 10, "x")])
    entries_before = sorted(p.name for p in env["tmp"].iterdir())
    run(mod, env, "--mtproto", str(dump), "--dry-run")
    assert not env["archive"].exists()
    assert sorted(p.name for p in env["tmp"].iterdir()) == entries_before  # no lock file either
    report = json.loads(capsys.readouterr().out)
    assert report["added"] == 1
    assert report["dry_run"] is True


def test_archive_is_private_and_the_live_file_is_never_written(env: dict) -> None:
    mod = load()
    before = env["live"].read_bytes()
    dump = jl(env["tmp"] / "mt.jsonl", [mt(1, 10, "x")])
    run(mod, env, "--mtproto", str(dump))
    assert env["live"].read_bytes() == before
    assert stat.S_IMODE(env["archive"].stat().st_mode) == 0o600


def test_the_archive_must_not_be_the_live_file(env: dict) -> None:
    mod = load()
    before = env["live"].read_bytes()
    dump = jl(env["tmp"] / "mt.jsonl", [mt(1, 10, "x")])
    with pytest.raises(SystemExit) as refused:
        mod.main(
            [
                *("--archive", str(env["live"])),
                *("--live-history", str(env["live"])),
                *("--chat-id", str(CHAT)),
                *("--mtproto", str(dump)),
            ]
        )
    assert "must not be the live history file" in str(refused.value.code)
    assert env["live"].read_bytes() == before


def test_a_missing_source_file_is_a_clear_refusal_not_a_traceback(env: dict) -> None:
    mod = load()
    gone = env["tmp"] / "no-such-dump.jsonl"
    with pytest.raises(SystemExit) as refused:
        run(mod, env, "--mtproto", str(gone))
    assert str(gone) in str(refused.value.code)
    assert not env["archive"].exists()


def test_media_that_is_not_a_plain_string_is_skipped_not_fatal(env: dict) -> None:
    mod = load()
    dump = jl(
        env["tmp"] / "mt.jsonl",
        [
            mt(1, 10, None, media={"_": "MessageMediaPhoto"}),
            mt(2, 11, None, media=["MessageMediaPhoto"]),
            mt(3, 12, "still imported"),
        ],
    )
    run(mod, env, "--mtproto", str(dump))
    assert [r["text"] for r in read(env["archive"])] == ["still imported"]


def test_one_archive_has_one_lock_whatever_path_spelling_names_it(
    env: dict, monkeypatch: pytest.MonkeyPatch
) -> None:
    mod = load()
    monkeypatch.chdir(env["tmp"])
    assert mod.lock_path(Path("archive.jsonl")) == mod.lock_path(env["tmp"] / "archive.jsonl")
    assert mod.lock_path(env["tmp"] / "sub" / ".." / "archive.jsonl") == mod.lock_path(
        env["archive"]
    )


def test_a_hand_edited_archive_row_without_ts_does_not_crash_the_merge(env: dict) -> None:
    mod = load()
    jl(
        env["archive"],
        [
            {"direction": "agent", "from": "agent", "text": "no ts"},
            {"ts": "55", "direction": "agent", "from": "agent", "text": "string ts"},
            {"ts": 5, "message_id": None, "direction": "agent", "from": "agent", "text": "ok"},
        ],
    )
    dump = jl(env["tmp"] / "mt.jsonl", [mt(1, 10, "new row")])
    assert run(mod, env, "--mtproto", str(dump)) == 0
    assert [r["text"] for r in read(env["archive"])] == ["ok", "new row", "no ts", "string ts"]


def test_identical_same_second_messages_are_two_rows_and_stay_idempotent(env: dict) -> None:
    mod = load()
    hist = jl(
        env["tmp"] / "other-host-history.jsonl",
        [
            hr(70, "ok"),
            hr(70, "ok"),
        ],
    )
    run(mod, env, "--history", str(hist))
    assert [r["text"] for r in read(env["archive"])] == ["ok", "ok"]
    first = env["archive"].read_bytes()
    run(mod, env, "--history", str(hist))
    assert env["archive"].read_bytes() == first


def test_history_rows_keep_their_ids_and_group(env: dict) -> None:
    mod = load()
    hist = jl(
        env["tmp"] / "other-host-history.jsonl",
        [
            hr(80, "part", message_id=321, chat_id=9, pane="%3", groupId="g1", threadId=12),
        ],
    )
    run(mod, env, "--history", str(hist))
    (row,) = read(env["archive"])
    assert (row["message_id"], row["chat_id"], row["pane"], row["groupId"], row["threadId"]) == (
        321,
        9,
        "%3",
        "g1",
        12,
    )


def test_a_secret_in_a_transcript_command_is_scrubbed_and_owner_name_is_configurable(
    env: dict,
) -> None:
    mod = load()
    tr = jl(
        env["tmp"] / "pc-omp.jsonl",
        [
            {
                "host": "pc",
                "harness": "omp",
                "file": "s.jsonl",
                "line": 1,
                "session": "abc",
                "ts": 5,
                "command": f"tg --tag report TOKEN={FAKE_TOKEN} no quotes here",
                "flags": [],
            }
        ],
    )
    dump = jl(env["tmp"] / "mt.jsonl", [mt(1, 6, "owner says", out=True)])
    run(mod, env, "--transcripts", str(tr), "--mtproto", str(dump), "--owner-name", "Boss")
    rows = read(env["archive"])
    assert FAKE_TOKEN not in env["archive"].read_text()
    assert [r["from"] for r in rows if r["direction"] == "user"] == ["Boss"]


def test_prose_that_only_contains_auth_is_kept_but_credentials_are_scrubbed(env: dict) -> None:
    mod = load()
    messages = [
        "Author: Alexander wrote the fix",
        "Authorization: Basic dXNlcjpwYXNzd29yZA== sent",
        "Authorization: Digest a9f8bcdef1234567 sent",
        # The secret-shaped fixtures are split so this file does not trip the repo's secret scanner.
        "export AUTH_" + "TOKEN=abcdef" + "123456",
        "export BASIC_" + "AUTH=hunter2" + "secret",
        "AUTH=hunter3" + "secret",
        "Authorization: Basic dXNlcg== sent",
    ]
    dump = jl(env["tmp"] / "mt.jsonl", [mt(i, 10 + i, m) for i, m in enumerate(messages)])
    run(mod, env, "--mtproto", str(dump))
    texts = [r["text"] for r in read(env["archive"])]
    assert texts == [
        "Author: Alexander wrote the fix",
        "Authorization: <AUTH_CREDENTIAL> sent",
        "Authorization: <AUTH_CREDENTIAL> sent",
        "export AUTH_TOKEN=<ASSIGNED_SECRET>",
        "export BASIC_AUTH=<ASSIGNED_SECRET>",
        "AUTH=<ASSIGNED_SECRET>",
        "Authorization: <AUTH_CREDENTIAL> sent",
    ]


def test_mtproto_rows_without_an_integer_id_are_skipped_not_merged_into_one(env: dict) -> None:
    mod = load()
    keyless = [{"date": 10 + n, "out": False, "text": f"no id {n}"} for n in range(3)]
    dump = jl(env["tmp"] / "mt.jsonl", [*keyless, mt(7, 20, "has an id")])
    run(mod, env, "--mtproto", str(dump))
    assert [r["text"] for r in read(env["archive"])] == ["has an id"]


def test_mtproto_text_that_is_not_a_string_is_skipped_not_fatal(env: dict) -> None:
    mod = load()
    odd = {"id": 1, "date": 10, "out": False, "text": ["a", "list"], "raw_media": None}
    dump = jl(env["tmp"] / "mt.jsonl", [odd, mt(2, 11, "fine")])
    run(mod, env, "--mtproto", str(dump))
    assert [r["text"] for r in read(env["archive"])] == ["fine"]
