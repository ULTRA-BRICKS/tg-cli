"""Hermetic #761 call integration: real Bun frontdoors -> real Python CLI/service -> fake externals.

`tg call` and `call-cli` are executed for real; the sidecar they spawn (tests/support/
call_fixture_sidecar.py) runs production `telegram_client.cli.main`. Only the Telegram transport,
the pytgcalls dial and Fish's HTTPS child are faked, and each fake records what reached it.
No network (enforced), no live credentials (fake strings in a temp config), no binary fixtures.

Scenario ids (I-NN) are mapped to acceptance requirements in tests/call-integration.md.
"""
import asyncio
import json
import os
import signal
import stat
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent / "support"))
from call_lab import (
    ACCOUNTS,
    FISH_KEY,
    MODEL,
    REPO,
    USERS,
    VOICE_ID,
    CallLab,
)

sys.path.insert(0, str(REPO / "features"))
import wav_tools

PROBLEM_REFS = ["--agent=3d-house", "--task=761", "--task-title=Print Ops", "--kind=problem"]
ALL_REFS = [
    "--agent=agent-7", "--agent-title=3d-house", "--agent-url=https://example.test/agent",
    "--task=T-761", "--task-title=Print Ops", "--task-url=https://example.test/task",
    "--project=proj-1", "--project-title=tg-cli", "--project-url=https://example.test/project",
    "--session=omp:abc123", "--session-title=Calls", "--session-url=http://example.test/session",
    "--kind=problem",
]
ALICE, BOB, OWNER = USERS["alice"], USERS["bobby"], USERS["owner"]


def ordered(effects, *steps):
    """Indexes of `(kind, predicate)` steps in order; AssertionError if one is missing or early."""
    index, found = -1, []
    for number, (kind, test) in enumerate(steps):
        for position in range(index + 1, len(effects)):
            row = effects[position]
            if row["kind"] == kind and test(row):
                index = position
                found.append(position)
                break
        else:
            raise AssertionError(f"step {number} ({kind}) is missing or happened out of order")
    return found


def always(_row):
    return True


def anchor_and_replies(lab, chat_id):
    """(anchor id, anchor message, ordered reply texts) of the single mirror in a chat."""
    messages = lab.chats()[str(chat_id)]["messages"]
    anchors = [mid for mid, m in messages.items() if m["reply_to"] is None]
    assert len(anchors) == 1, f"expected one anchor in chat {chat_id}, got {anchors}"
    anchor = anchors[0]
    replies = [m["text"] for mid, m in sorted(messages.items(), key=lambda i: int(i[0]))
               if m["reply_to"] == int(anchor)]
    return int(anchor), messages[anchor], replies


class Scenario(unittest.TestCase):
    def lab(self, **options):
        lab = CallLab(**options)
        self.addCleanup(lab.__exit__)
        return lab

    def call(self, lab, args, frontdoor="tg", expect=0, **options):
        run = lab.run(frontdoor, [*args, "--json", "--timeout=5"], **options)
        self.assertEqual(run.code, expect, (run.stdout, run.stderr))
        return run

    def assertNoCall(self, lab, mark=0):
        self.assertEqual(lab.since(mark, "dial"), [], "a dial happened")
        self.assertEqual(lab.since(mark, "network_attempt"), [])

    def assertNoSecrets(self, *texts):
        for text in texts:
            self.assertNotIn(FISH_KEY, text)
            self.assertNotIn("secret-transport-detail", text)
            self.assertNotIn("FAKE-SESSION", text)
            self.assertNotIn("fake-api-hash", text)
            self.assertNotIn("bot-token-must-not-leak", text)


class SuccessfulOneShot(Scenario):
    def test_i01_quick_intro_exact_mirror_effect_order_and_same_anchor_edit(self):
        lab = self.lab()
        run = self.call(lab, ["@alice", "--say=Принтер сломан", *PROBLEM_REFS])
        result = run.result
        self.assertEqual(result["state"], "audio_stream_ended")
        self.assertIs(result["automatic_retry"], False)
        spoken = "Привет! 3d-house. Проблема с Print Ops. Принтер сломан"
        effects = lab.effects()
        anchor_id, anchor, replies = anchor_and_replies(lab, ALICE)
        # Order: resolve -> anchor -> transcript -> TTS -> one dial -> same-anchor edit.
        ordered(effects,
                ("telegram.get_users", lambda e: e["target"] == "alice"),
                ("telegram.send_message", lambda e: e["reply_to"] is None),
                ("telegram.send_message", lambda e: e["reply_to"] == anchor_id),
                ("provider.request", always),
                ("dial", lambda e: e["recipient"] == ALICE),
                ("telegram.edit_message_text", lambda e: e["message_id"] == anchor_id))
        self.assertEqual(len(lab.effects("dial")), 1)
        # Exact verified peer: every Telegram write targets the resolved private chat only.
        writes = lab.effects("telegram.send_message", "telegram.edit_message_text")
        self.assertEqual({row["chat_id"] for row in writes}, {ALICE})
        self.assertEqual(set(lab.chats()), {str(ALICE)})
        self.assertEqual({row["sender"] for row in writes}, {ACCOUNTS["personal"]})
        self.assertEqual({row["parse_mode"] for row in writes}, {"ParseMode.DISABLED"})
        # Transcript reconstruction from the replies, and the readable intro matches the speech.
        self.assertEqual("\n".join(replies), "Расшифровка исходящего сообщения:\n" + spoken)
        self.assertEqual("".join(row["text"] for row in lab.effects("provider.request")), spoken)
        self.assertTrue(spoken.startswith("Привет! 3d-house. Проблема с Print Ops."))
        # Same anchor: created at 'Подготовка', edited once to the final status, never re-sent.
        self.assertIn("Статус: Подготовка звонка", anchor["edits"][0])
        self.assertIn("Статус: Аудиопоток завершён", anchor["text"])
        self.assertIn("прослушивание не подтверждено", anchor["text"])
        self.assertIn(f"Вызывающий аккаунт: {ACCOUNTS['personal']}", anchor["text"])
        self.assertIn(f"Получатель: {ALICE}", anchor["text"])
        self.assertEqual(len(anchor["edits"]), 1)
        self.assertEqual(result["mirror_ids"][0], anchor_id)
        self.assertEqual(result["recipient_id"], ALICE)
        self.assertNoSecrets(run.stdout, run.stderr)
        self.assertEqual(lab.leftover_audio_dirs(), [])

    def test_i01b_human_frontdoor_output_never_claims_listening(self):
        lab = self.lab()
        run = lab.run("call-cli", ["@alice", "--say=Готово", "--agent=a", "--task=t", "--timeout=5"])
        self.assertEqual((run.code, run.stderr), (0, ""))
        self.assertIn("outbound audio stream ended (not a listening receipt)", run.stdout)
        for claim in ("heard", "answered", "conversation"):
            self.assertNotIn(claim, run.stdout.lower())

    def test_i02_raw_audio_gets_spoken_prefix_before_the_audio_and_provided_transcript_unverified(self):
        lab = self.lab()
        raw = lab.raw_audio(duration_ms=1200)
        run = self.call(lab, ["@alice", f"--audio={raw}", "--transcript=Что-то про принтер", "--agent=x", "--task=y"])
        self.assertEqual(run.result["state"], "audio_stream_ended")
        spoken = "Привет! x. Отчёт по y. Далее аудио; текст предоставлен отправителем."
        self.assertEqual([row["text"] for row in lab.effects("provider.request")], [spoken])
        dial = lab.effects("dial")[0]
        # Speech prefix first, then the raw audio: tone profile is [speech, raw], never reversed.
        self.assertEqual([kind for kind, *_ in dial["profile"]], ["speech", "raw"])
        raw_ms = wav_tools.analyze(raw)["duration_ms"]
        speech_ms = dial["profile"][0][2]
        self.assertAlmostEqual(dial["audio"]["duration_ms"], speech_ms + raw_ms, delta=300)
        self.assertEqual((dial["audio"]["rate"], dial["audio"]["channels"]), (48000, 1))
        _, _, replies = anchor_and_replies(lab, ALICE)
        body = "\n".join(replies)
        self.assertIn("Аудио: текст отправителя, не проверен: Что-то про принтер", body)
        row = lab.journal_rows()[0]
        self.assertEqual(row["transcript_kind"], "sender_provided_unverified")
        self.assertIs(row["audio_recorded"], False)
        self.assertIs(row["recipient_replies_captured"], False)

    def test_i02b_raw_audio_without_transcript_is_honestly_unknown(self):
        lab = self.lab()
        raw = lab.raw_audio()
        self.call(lab, ["@alice", f"--audio={raw}"])
        _, _, replies = anchor_and_replies(lab, ALICE)
        self.assertIn("содержание неизвестно; не транскрибировано", "\n".join(replies))
        self.assertIn("Агент неизвестен", lab.effects("provider.request")[0]["text"])
        self.assertEqual(lab.journal_rows()[0]["transcript_kind"], "unknown")

    def test_i02c_the_prefix_detector_fails_when_the_order_is_wrong(self):
        lab = self.lab()
        speech = wav_tools.write_tones(lab.root / "s.wav", (330, 550), 800)
        raw = wav_tools.write_tones(lab.root / "r.wav", (1000, 1500), 800)
        import wave
        def concat(first, second, out):
            with wave.open(str(first)) as a, wave.open(str(second)) as b, wave.open(str(out), "wb") as o:
                o.setparams(a.getparams())
                o.writeframes(a.readframes(a.getnframes()) + b.readframes(b.getnframes()))
            return out
        good = wav_tools.tone_profile(concat(speech, raw, lab.root / "good.wav"))
        bad = wav_tools.tone_profile(concat(raw, speech, lab.root / "bad.wav"))
        self.assertEqual([k for k, *_ in good], ["speech", "raw"])
        self.assertNotEqual([k for k, *_ in bad], ["speech", "raw"])

    def test_i03_long_source_is_split_into_ordered_speech_segments_with_per_segment_metrics(self):
        lab = self.lab()
        source = " ".join(f"слово{index:03d}" for index in range(120))[:990]
        run = self.call(lab, ["@alice", f"--say={source}", "--agent=3d-house", "--task=T", "--kind=report"])
        self.assertEqual(run.result["state"], "audio_stream_ended")
        requests = [row["text"] for row in lab.effects("provider.request")]
        spoken = "Привет! 3d-house. Отчёт по T. " + source
        self.assertGreaterEqual(len(requests), 2)
        self.assertTrue(all(0 < len(text) <= 1000 for text in requests))
        self.assertEqual("".join(requests), spoken)
        row = lab.journal_rows()[0]
        segments = row["tts"]["segments"]
        self.assertEqual([part["segment"] for part in segments], list(range(len(requests))))
        self.assertEqual([part["input_characters"] for part in segments], [len(t) for t in requests])
        dial = lab.effects("dial")[0]
        total_ms = sum(part["audio"]["audio_duration_ms"] for part in segments)
        self.assertAlmostEqual(dial["audio"]["duration_ms"], total_ms, delta=250)
        self.assertEqual([kind for kind, *_ in dial["profile"]], ["speech"])
        # Mirror holds the complete transcript, once.
        _, _, replies = anchor_and_replies(lab, ALICE)
        self.assertEqual("\n".join(replies), "Расшифровка исходящего сообщения:\n" + spoken)

    def test_i04_long_astral_transcript_is_mirrored_in_utf16_bounded_ordered_chunks(self):
        lab = self.lab()
        raw = lab.raw_audio()
        transcript = ("Привет😀мир " * 800).strip()
        self.assertGreater(len(transcript.encode("utf-16-le")) // 2, 3500 * 2)
        self.call(lab, ["@alice", f"--audio={raw}", f"--transcript={transcript}", "--agent=a"])
        _, _, replies = anchor_and_replies(lab, ALICE)
        self.assertGreaterEqual(len(replies), 3)
        for chunk in replies:
            self.assertLessEqual(len(chunk.encode("utf-16-le")) // 2, 3500 + 80)
        sent = lab.effects("telegram.send_message")
        anchor_id = sent[0].get("message_id")
        self.assertTrue(all(row["reply_to"] == anchor_id for row in sent[1:]))
        joined = "".join(replies)
        self.assertTrue(joined.endswith(transcript[-200:]))
        self.assertEqual(joined.count("Привет😀мир"), 800)


class IdentityAndHistory(Scenario):
    def test_i05_every_reference_caller_recipient_and_timestamps_are_persisted_per_frontdoor(self):
        lab = self.lab()
        self.call(lab, ["@alice", "--say=Нужен ответ", *ALL_REFS])
        history = lab.history("tg")
        self.assertEqual(len(history), 1)
        row = history[0]
        expected = {"agent": ("agent-7", "3d-house", "https://example.test/agent"),
                    "task": ("T-761", "Print Ops", "https://example.test/task"),
                    "project": ("proj-1", "tg-cli", "https://example.test/project"),
                    "session": ("omp:abc123", "Calls", "http://example.test/session")}
        for name, (ident, title, url) in expected.items():
            self.assertEqual(row["references"][name], {"id": ident, "title": title, "url": url})
        self.assertEqual((row["caller_id"], row["recipient_id"], row["role"]), (ACCOUNTS["personal"], ALICE, "personal"))
        self.assertEqual(row["peer"], "@alice")
        self.assertEqual(row["kind"], "problem")
        self.assertEqual(row["intro"], "Привет! 3d-house. Проблема с Print Ops. Проект tg-cli.")
        for stamp in (row["created_at"], row["updated_at"]):
            self.assertRegex(stamp, r"^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d+\+00:00$")
        states = [item["status"] for item in row["transitions"]]
        ordered_states = ["intent", "resolved", "mirroring", "mirrored", "synthesizing", "prepared", "attempting", "audio_stream_ended"]
        positions = [states.index(state) for state in ordered_states]
        self.assertEqual(positions, sorted(positions))
        self.assertEqual(states[0], "intent")
        for item in row["transitions"]:
            self.assertRegex(item["at"], r"^\d{4}-")
        anchor = anchor_and_replies(lab, ALICE)[1]["text"]
        for fragment in ("3d-house (agent-7) — https://example.test/agent", "Print Ops (T-761)", "tg-cli (proj-1)",
                         "Calls (omp:abc123)", f"Время: {row['created_at']}"):
            self.assertIn(fragment, anchor)

    def test_i05b_kind_connectors_and_unknown_context_are_spoken_honestly(self):
        lab = self.lab()
        expectations = {
            "report": "Привет! Агент неизвестен. Отчёт по неизвестной задаче. х",
            "question": "Привет! Агент неизвестен. Вопрос по неизвестной задаче. х",
            "problem": "Привет! Агент неизвестен. Проблема с неизвестной задачей. х",
        }
        for kind, spoken in expectations.items():
            mark = lab.mark()
            self.call(lab, ["@alice", "--say=х", f"--kind={kind}"])
            self.assertEqual(lab.since(mark, "provider.request")[0]["text"], spoken)
            self.assertNotIn("Проект", spoken)

    def test_i05c_caller_account_rings_the_owner_for_me_and_mirrors_into_the_owner_private_chat(self):
        lab = self.lab()
        run = self.call(lab, ["me", "--say=Отчёт готов", "--agent=a"])
        self.assertEqual(run.result["recipient_id"], OWNER)
        dial = lab.effects("dial")[0]
        self.assertEqual((dial["role"], dial["recipient"]), ("caller", OWNER))
        writes = lab.effects("telegram.send_message", "telegram.edit_message_text")
        self.assertEqual({(w["chat_id"], w["sender"]) for w in writes}, {(OWNER, ACCOUNTS["caller"])})
        self.assertEqual(set(lab.chats()), {str(OWNER)})

    def test_i06_both_frontdoors_share_store_identity_and_every_history_filter(self):
        lab = self.lab()
        self.call(lab, ["@alice", "--say=Один", "--agent=a1", "--task=t1", "--project=p1", "--session=s1"], frontdoor="tg")
        self.call(lab, ["@bobby", "--say=Два", "--agent=a2", "--task=t2", "--project=p2", "--session=s2"], frontdoor="call-cli")
        self.call(lab, ["@alice", "--say=Три", "--agent=a1", "--task=t3", "--project=p1", "--session=s3"],
                  frontdoor="call-cli", plan={"dial": "timeout"}, expect=3)
        via_tg = lab.history("tg")
        via_cli = lab.history("call-cli")
        self.assertEqual(via_tg, via_cli)
        self.assertEqual(len(via_tg), 3)
        self.assertEqual({row["caller_id"] for row in via_tg}, {ACCOUNTS["personal"]})
        self.assertEqual(len(lab.journal_rows()), 3)
        self.assertEqual([p.name for p in (lab.store / "calls").iterdir()], ["journal.sqlite3"])
        cases = [(["--agent=a1"], 2), (["--agent=a2"], 1), (["--task=t2"], 1), (["--project=p1"], 2),
                 (["--session=s3"], 1), ([f"--recipient={ALICE}"], 2), ([f"--recipient={BOB}"], 1),
                 (["--status=timeout"], 1), (["--status=audio_stream_ended"], 2), (["--limit=1"], 1),
                 (["--agent=a1", "--status=timeout"], 1), (["--agent=nobody"], 0)]
        for flags, count in cases:
            for frontdoor in ("tg", "call-cli"):
                with self.subTest(flags=flags, frontdoor=frontdoor):
                    self.assertEqual(len(lab.history(frontdoor, *flags)), count)
        self.assertEqual({r["references"]["task"]["id"] for r in lab.history("tg", "--agent=a1")}, {"t1", "t3"})
        shown = lab.run("call-cli", ["history", "show", via_tg[0]["call_id"], "--json"])
        self.assertEqual(shown.result["calls"], [via_tg[0]])

    def test_i20_history_reads_leave_existing_journal_logically_and_physically_unchanged(self):
        import hashlib
        lab = self.lab()
        self.call(lab, ["@alice", "--say=fixture", "--agent=history-proof"])
        call_id = lab.journal_rows()[0]["call_id"]
        def digest():
            payload = json.dumps(lab.journal_rows(), sort_keys=True).encode()
            return hashlib.sha256(payload).hexdigest()
        before_digest, before_tree = digest(), lab.tree()
        mark = lab.mark()
        for frontdoor in ("tg", "call-cli"):
            self.assertEqual(len(lab.history(frontdoor)), 1)
            shown = lab.run(frontdoor, ["history", "show", call_id, "--json"])
            self.assertEqual(shown.code, 0)
            self.assertEqual(len(shown.result["calls"]), 1)
        self.assertEqual(digest(), before_digest)
        self.assertEqual(lab.tree(), before_tree)
        self.assertEqual(lab.since(mark, "telegram.connect", "provider.request", "dial"), [])

    def test_i06b_history_is_offline_read_only_and_never_creates_state(self):
        lab = self.lab()
        before = lab.tree()
        mark = lab.mark()
        run = lab.run("tg", ["history", "list", "--json"])
        self.assertEqual((run.code, run.result), (0, {"calls": []}))
        self.assertEqual(lab.tree(), before)
        self.assertEqual(lab.since(mark, "telegram.connect", "provider.request", "dial", "network_attempt"), [])
        self.assertFalse((lab.store / "calls").exists())


class Hostile(Scenario):
    def test_i07_hostile_text_stays_literal_and_travels_over_private_stdin_not_argv(self):
        lab = self.lab()
        hostile = "'; touch PWNED; $(touch PWNED2) `touch PWNED3` <b>x</b> [a](http://evil.test) *_~ \\n --dry-run --peer=@bobby"
        run = self.call(lab, ["@alice", f"--say={hostile}", "--agent=a;rm -rf /", "--task=$(id)"])
        self.assertEqual(run.result["state"], "audio_stream_ended")
        start = lab.effects("sidecar.start")[0]
        self.assertNotIn(hostile, " ".join(start["argv"]))
        self.assertFalse(any("rm -rf" in part or "$(id)" in part for part in start["argv"]))
        self.assertEqual(start["stdin"]["say"], hostile)
        self.assertIs(start["bot_token_in_env"], False)
        self.assertIn("--say-stdin", start["argv"])
        self.assertIn("--context-stdin", start["argv"])
        spoken = lab.journal_rows()[0]["spoken_text"]
        self.assertTrue(spoken.endswith(hostile))
        _, anchor, replies = anchor_and_replies(lab, ALICE)
        self.assertIn(hostile, "\n".join(replies))
        self.assertEqual({row["parse_mode"] for row in lab.effects("telegram.send_message")}, {"ParseMode.DISABLED"})
        self.assertIn("a;rm -rf /", anchor["text"])
        self.assertEqual([row["peer"] for row in lab.journal_rows()], ["@alice"])
        self.assertEqual({row["chat_id"] for row in lab.effects("telegram.send_message")}, {ALICE})
        self.assertFalse(list(lab.root.rglob("PWNED*")))
        self.assertEqual(lab.effects("dial")[0]["recipient"], ALICE)
        provider = lab.effects("provider.request")
        self.assertEqual("".join(r["text"] for r in provider), spoken)
        self.assertFalse(any(r["text_in_argv"] or r["key_in_argv"] for r in provider))
        self.assertTrue(all(r["key_matches"] for r in provider))

    def test_i07b_flag_like_text_is_a_usage_error_before_any_sidecar(self):
        lab = self.lab()
        mark = lab.mark()
        run = lab.run("tg", ["@alice", "--say", "--dry-run"])
        self.assertEqual(run.code, 2)
        self.assertEqual(lab.since(mark), [])


class Mirror(Scenario):
    def test_i08_mirror_failures_and_wrong_chat_never_reach_tts_or_dial(self):
        cases = {
            "anchor send fails": ({"fail_send_at": 1}, "RuntimeError", False),
            "transcript send fails after anchor": ({"fail_send_at": 2}, "RuntimeError", True),
            "returned chat is not the recipient": ({"wrong_chat_at": 1, "wrong_chat": 999}, "CALL_MIRROR_RECIPIENT_MISMATCH", False),
            "returned chat of a chunk is wrong": ({"wrong_chat_at": 2, "wrong_chat": 999}, "CALL_MIRROR_RECIPIENT_MISMATCH", True),
        }
        for name, (plan, reason, has_anchor) in cases.items():
            with self.subTest(name):
                lab = self.lab()
                run = self.call(lab, ["@alice", "--say=Нельзя звонить", "--agent=a"], plan=plan, expect=3)
                self.assertEqual(run.result["error"], "CALL_ATTEMPT_FAILED")
                self.assertEqual(run.result["stage"], "mirror")
                self.assertEqual(run.result["reason"], reason)
                self.assertIn("no call placed", run.result["warning"])
                self.assertEqual(lab.effects("dial", "provider.request", "tts.synthesize"), [])
                self.assertNoCall(lab)
                row = lab.journal_rows()[0]
                self.assertEqual((row["status"], row["failure_stage"], row["automatic_retry"]), ("failed", "mirror", False))
                self.assertEqual(bool(lab.effects("telegram.edit_message_text")), has_anchor)
                if has_anchor:
                    _, anchor, _ = anchor_and_replies(lab, ALICE)
                    self.assertIn("Статус: Ошибка", anchor["text"])
                    self.assertIn(f"Ошибка: {reason}", anchor["text"])
                self.assertEqual(lab.host_engine_calls(), [])
                self.assertNoSecrets(run.stdout, run.stderr, json.dumps(row))

    def test_i09_final_edit_failure_is_a_warning_and_keeps_the_real_outcome(self):
        lab = self.lab()
        run = self.call(lab, ["@alice", "--say=Готово", "--agent=a"], plan={"edit_fail": True})
        self.assertEqual(run.result["state"], "audio_stream_ended")
        self.assertEqual(run.result["mirror_result"], "update_failed")
        self.assertEqual(run.result["mirror_warning"], "RuntimeError")
        self.assertEqual(lab.journal_rows()[0]["status"], "audio_stream_ended")
        human = lab.run("tg", ["@bobby", "--say=Готово", "--agent=a", "--timeout=5"], plan={"edit_fail": True})
        self.assertEqual(human.code, 0)
        self.assertIn("transcript mirror result update failed (RuntimeError)", human.stderr)
        self.assertNoSecrets(run.stdout, human.stderr)

    def test_i10_wrong_or_unverified_peer_and_identity_fail_closed_before_any_message(self):
        cases = {
            "peer unknown": (["@ghost"], {}, "PEER_NOT_FOUND"),
            "peer is a bot": (["@alice"], {"bots": [ALICE]}, "PEER_IS_BOT"),
            "peer is the caller itself": (["@owner"], {}, "CALL_RECIPIENT_IS_CALLER"),
            "session account differs from stored identity": (["@alice"], {"identity": {"personal": 9999}}, "ACCOUNT_IDENTITY_MISMATCH"),
        }
        for name, (peer, plan, code) in cases.items():
            with self.subTest(name):
                lab = self.lab()
                run = lab.run("tg", [*peer, "--say=x", "--json", "--timeout=5"], plan=plan)
                self.assertEqual(run.code, 3, (run.stdout, run.stderr))
                result = run.result
                self.assertIn(code, (result.get("reason"), result.get("error")))
                self.assertEqual(lab.effects("telegram.send_message", "telegram.edit_message_text", "provider.request", "dial"), [])
                self.assertEqual(lab.chats(), {})

    def test_i10b_copied_session_requires_idle_confirmation_before_any_network(self):
        lab = self.lab()
        lab.write_session("personal", origin="import")
        mark = lab.mark()
        run = lab.run("tg", ["@alice", "--say=x", "--json", "--timeout=5"])
        self.assertEqual(run.code, 3)
        self.assertEqual(run.result["error"], "SOURCE_SESSION_OWNERSHIP_NOT_CONFIRMED")
        self.assertEqual(lab.since(mark, "telegram.connect", "telegram.send_message", "provider.request", "dial"), [])
        confirmed = lab.run("tg", ["@alice", "--say=x", "--json", "--timeout=5", "--source-idle-confirmed"])
        self.assertEqual(confirmed.code, 0, (confirmed.stdout, confirmed.stderr))
        self.assertIs(lab.effects("dial")[0]["source_idle"], True)


class Outcomes(Scenario):
    def test_i11_timeout_declined_and_cancellation_are_terminal_single_attempts(self):
        cases = {
            "timeout": ({"dial": "timeout"}, 3, "timeout", "TimeoutError", "Истекло время ожидания"),
            "declined": ({"dial": "declined"}, 3, "failed", "CALL_INCOMPLETE", "Ошибка"),
            "cancelled": ({"dial": "cancel"}, 130, "cancelled", "CancelledError", "Отменён"),
        }
        for name, (plan, code, state, reason, label) in cases.items():
            with self.subTest(name):
                lab = self.lab()
                run = lab.run("tg", ["@alice", "--say=x", "--agent=a", "--json", "--timeout=5"], plan=plan)
                self.assertEqual(run.code, code, (run.stdout, run.stderr))
                result = run.result
                self.assertIs(result["automatic_retry"], False)
                self.assertEqual(result["state"], state)
                self.assertEqual(len(lab.effects("dial")), 1, "no redial")
                self.assertEqual(len(lab.effects("provider.request")), 1, "no second speech synthesis")
                row = lab.journal_rows()[0]
                self.assertEqual((row["status"], row["automatic_retry"]), (state, False))
                if name != "cancelled":
                    self.assertEqual(row["failure"], reason)
                    self.assertEqual(result["stage"], "dial")
                self.assertEqual(row["failure_stage"], "dial")
                _, anchor, _ = anchor_and_replies(lab, ALICE)
                self.assertIn(f"Статус: {label}", anchor["text"])
                self.assertNotIn("Аудиопоток завершён", anchor["text"])
                self.assertNotIn("audio_stream_ended", [t["status"] for t in row["transitions"]])
                self.assertEqual(lab.leftover_audio_dirs(), [])

    def test_i12_idempotency_token_claims_one_attempt_forever_even_after_failure(self):
        lab = self.lab()
        first = self.call(lab, ["@alice", "--say=x", "--agent=a", "--idempotency-key=run-761-a"])
        self.assertEqual(first.result["state"], "audio_stream_ended")
        mark = lab.mark()
        again = self.call(lab, ["@alice", "--say=x", "--agent=a", "--idempotency-key=run-761-a"], expect=3)
        self.assertEqual(again.result["error"], "CALL_TOKEN_ALREADY_USED")
        self.assertEqual(lab.since(mark, "telegram.connect", "telegram.send_message", "provider.request", "dial"), [])
        # A failed attempt keeps its claim: the same token never auto-redials.
        self.call(lab, ["@alice", "--say=x", "--idempotency-key=run-761-b"], plan={"dial": "timeout"}, expect=3)
        mark = lab.mark()
        retry = self.call(lab, ["@alice", "--say=x", "--idempotency-key=run-761-b"], expect=3)
        self.assertEqual(retry.result["error"], "CALL_TOKEN_ALREADY_USED")
        self.assertEqual(lab.since(mark, "telegram.connect", "dial"), [])
        self.assertEqual(len(lab.journal_rows()), 2)
        self.assertEqual(len(lab.effects("dial")), 2)


class SpeechProvider(Scenario):
    def test_i13_missing_or_unconfirmed_provider_never_falls_back_to_host_speech_or_dials(self):
        cases = {
            "no voice.json": ({"voice": False}, {}, "TTS_CONFIG_MISSING", 0),
            "credential missing": ({"credential": False}, {}, "TTS_CREDENTIAL_UNAVAILABLE", 0),
            "credential entry has the wrong domain": ({"voice": False}, {}, "TTS_CREDENTIAL_UNAVAILABLE", 0),
            "provider returns an error": ({}, {"provider": "error:TTS_PROVIDER_FAILED"}, "TTS_PROVIDER_FAILED", 1),
            "provider times out": ({}, {"provider": "timeout"}, "TTS_PROVIDER_TIMEOUT", 1),
            "provider returns invalid audio": ({}, {"provider": "error:TTS_AUDIO_INVALID"}, "TTS_AUDIO_INVALID", 1),
        }
        for name, (options, plan, reason, requests) in cases.items():
            with self.subTest(name):
                lab = self.lab(**options)
                if name == "credential entry has the wrong domain":
                    lab.write_voice(domain="other_provider")
                run = self.call(lab, ["@alice", "--say=Важно", "--agent=a"], plan=plan, expect=3)
                self.assertEqual((run.result["error"], run.result["reason"], run.result["stage"]),
                                 ("CALL_ATTEMPT_FAILED", reason, "prepare"))
                self.assertEqual(len(lab.effects("provider.request")), requests)
                self.assertNoCall(lab)
                self.assertEqual(lab.host_engine_calls(), [], "host speech engine was started")
                self.assertEqual([e for e in lab.effects("subprocess") if os.path.basename(e["argv"][0]) in ("say", "espeak", "espeak-ng")], [])
                row = lab.journal_rows()[0]
                self.assertEqual(row["status"], "failed")
                self.assertNotIn("attempting", [t["status"] for t in row["transitions"]])
                _, anchor, _ = anchor_and_replies(lab, ALICE)
                self.assertIn(f"Ошибка: {reason}", anchor["text"])
                self.assertNoSecrets(run.stdout, run.stderr, json.dumps(row))

    def test_i14_each_segment_records_real_metrics_and_unmeasured_values_stay_null(self):
        lab = self.lab()
        source = ("Проверка метрик. " * 70)[:980]
        self.call(lab, ["@alice", f"--say={source}", "--agent=a"])
        row = lab.journal_rows()[0]
        segments = row["tts"]["segments"]
        self.assertEqual(len(segments), len(lab.effects("provider.request")))
        self.assertGreaterEqual(len(segments), 2)
        for index, part in enumerate(segments):
            self.assertEqual((part["provider"], part["model"], part["voice_id"], part["latency"]),
                             ("fish_audio", MODEL, VOICE_ID, "balanced"))
            self.assertEqual(part["segment"], index)
            self.assertIsNone(part["engine"])
            self.assertEqual(part["version"], 1)
            audio = part["audio"]
            self.assertGreater(audio["audio_duration_ms"], 0)
            self.assertEqual((audio["sample_rate_hz"], audio["channels"]), (24000, 1))
            self.assertTrue(0 < audio["peak"] <= 1 and 0 < audio["rms"] <= audio["peak"])
            self.assertEqual(audio["clipping_ratio"], 0)
            self.assertLess(audio["peak_dbfs"], 0)
            self.assertAlmostEqual(audio["real_time_factor"], audio["synth_ms"] / audio["audio_duration_ms"])
            # Never invented: no recognizer or listener ran.
            for name in ("naturalness_score", "wer", "cer", "word_errors", "character_errors",
                         "reference_words", "reference_characters"):
                self.assertIsNone(audio.get(name), name)
            self.assertIn(audio.get("asr_status", "not_measured"), ("not_measured",))
            self.assertGreaterEqual(part["total_synth_ms"], part["time_to_first_audio_byte_ms"])
        aggregate = row["tts"]["aggregate"]
        self.assertEqual(aggregate["generated_segments"], len(segments))
        self.assertAlmostEqual(aggregate["total_synth_ms"], sum(p["total_synth_ms"] for p in segments))
        self.assertAlmostEqual(aggregate["audio_duration_ms"], sum(p["audio"]["audio_duration_ms"] for p in segments))
        self.assertIsNone(aggregate["time_to_first_playback_ms"])
        self.assertEqual(aggregate["scope"], "generated_segments_only")
        self.assertNotIn(FISH_KEY, json.dumps(row))

    def test_i15_completed_segment_metrics_survive_a_later_segment_failure_and_nothing_dials(self):
        lab = self.lab()
        source = ("Метрика сегмента. " * 70)[:980]
        run = self.call(lab, ["@alice", f"--say={source}", "--agent=a"],
                        plan={"provider_fail_from": 2}, expect=3)
        self.assertEqual((run.result["reason"], run.result["stage"]), ("TTS_PROVIDER_FAILED", "prepare"))
        self.assertEqual(len(lab.effects("provider.request")), 2)
        self.assertNoCall(lab)
        row = lab.journal_rows()[0]
        self.assertEqual(len(row["tts"]["segments"]), 1)
        self.assertEqual(row["tts"]["segments"][0]["segment"], 0)
        self.assertGreater(row["tts"]["segments"][0]["audio"]["audio_duration_ms"], 0)
        self.assertEqual(row["tts"]["aggregate"]["generated_segments"], 1)
        self.assertEqual(lab.host_engine_calls(), [])


class DryRunAndModes(Scenario):
    def test_i16_dry_run_has_zero_network_tts_auth_reads_and_call_state_writes(self):
        for frontdoor in ("tg", "call-cli"):
            with self.subTest(frontdoor):
                lab = self.lab()
                before = lab.tree()
                mark = lab.mark()
                run = lab.run(frontdoor, ["@alice", "--say=Проверка", "--agent=a", "--task=t", "--dry-run", "--json"])
                self.assertEqual(run.code, 3, (run.stdout, run.stderr))
                plan = run.result
                self.assertIs(plan["dry_run"], True)
                self.assertIs(plan["ready"], False)
                self.assertEqual(plan["spoken_text"], "Привет! a. Отчёт по t. Проверка")
                self.assertEqual(plan["tts"]["provider"], "fish_audio")
                self.assertEqual((plan["tts"]["model"], plan["tts"]["voice_id"]), (MODEL, VOICE_ID))
                self.assertIs(plan["tts"]["credentials_checked"], False)
                self.assertFalse(plan["session_checks"]["auth_contents_checked"])
                self.assertIn("session_identity_unverified", plan["missing"])
                self.assertEqual(lab.tree(), before, "dry-run changed the config tree")
                self.assertFalse((lab.store / "calls").exists())
                self.assertEqual(lab.since(mark, "telegram.connect", "telegram.get_me", "telegram.send_message",
                                           "provider.request", "tts.synthesize", "dial", "network_attempt", "subprocess"), [])
                opened = {Path(e["path"]).name for e in lab.since(mark, "config_open")}
                for forbidden in ("personal.json", "caller.json", "ha-entries.json", ".env", "journal.sqlite3"):
                    self.assertNotIn(forbidden, opened)
                self.assertEqual([e for e in lab.since(mark, "config_open") if e["write"]], [])
                self.assertEqual(lab.host_engine_calls(), [])
                self.assertNoSecrets(run.stdout, run.stderr)

    def test_i17_private_modes_for_journal_audio_and_directories(self):
        lab = self.lab()
        raw = lab.raw_audio()
        self.call(lab, ["@alice", f"--audio={raw}", "--agent=a"])
        self.assertEqual(stat.S_IMODE(lab.store.lstat().st_mode), 0o700)
        self.assertEqual(stat.S_IMODE((lab.store / "calls").lstat().st_mode), 0o700)
        self.assertEqual(stat.S_IMODE(lab.journal_path().lstat().st_mode), 0o600)
        for path in lab.store.glob("*.json"):
            self.assertEqual(stat.S_IMODE(path.lstat().st_mode), 0o600, path.name)
        tree = lab.effects("dial")[0]["tree"]
        self.assertGreaterEqual(len(tree), 4)
        for name, info in tree.items():
            self.assertEqual(info["mode"], 0o700 if info["dir"] else 0o600, name)
        self.assertEqual(lab.leftover_audio_dirs(), [], "private audio outlived the call")

    def test_i18_live_two_way_conversation_is_rejected_before_any_provider_or_connection_effect(self):
        import socket

        from telegram_client import call_lib
        from telegram_client.core import ClientError
        attempts = []
        original = socket.socket.connect
        socket.socket.connect = lambda self, address: attempts.append(address) or (_ for _ in ()).throw(OSError("blocked"))
        self.addCleanup(setattr, socket.socket, "connect", original)

        class ReadyOwner(call_lib.NativeOwner):
            def readiness(self, config):
                return {"configured": True}

        config = {"voice": {"status": "confirmed"}, "agent": {"protocol": "call-agent-json-v1"}}
        consent = call_lib.Consent(True, True, True)
        with self.assertRaises(ClientError) as raised:
            asyncio.run(call_lib.start_conversation(object(), config, consent, ReadyOwner()))
        self.assertEqual(str(raised.exception), "CONVERSATION_REQUIRES_IDENTIFIED_SERVICE")
        self.assertEqual(attempts, [])
        with self.assertRaises(ClientError) as unauthorized:
            asyncio.run(call_lib.start_conversation(object(), config, call_lib.Consent(True, False, True), ReadyOwner()))
        self.assertEqual(str(unauthorized.exception), "LIVE_START_NOT_AUTHORIZED")


class DetectorsCatchRegressions(Scenario):
    """Negative controls: the assertions above must fail on broken order or a wrong peer."""

    def effects_of_a_good_call(self):
        lab = self.lab()
        self.call(lab, ["@alice", "--say=Порядок", "--agent=a"])
        return lab, lab.effects()

    def test_order_helper_rejects_dial_before_mirror_and_missing_edit(self):
        effects = self.effects_of_a_good_call()[1]
        steps = (("telegram.send_message", always), ("provider.request", always), ("dial", always),
                 ("telegram.edit_message_text", always))
        ordered(effects, *steps)
        dial = next(i for i, e in enumerate(effects) if e["kind"] == "dial")
        send = next(i for i, e in enumerate(effects) if e["kind"] == "telegram.send_message")
        swapped = list(effects)
        swapped[dial], swapped[send] = swapped[send], swapped[dial]
        with self.assertRaises(AssertionError):
            ordered(swapped, *steps)
        with self.assertRaises(AssertionError):
            ordered([e for e in effects if e["kind"] != "telegram.edit_message_text"], *steps)

    def test_peer_predicate_rejects_a_mirror_into_the_wrong_chat(self):
        effects = self.effects_of_a_good_call()[1]
        with self.assertRaises(AssertionError):
            ordered(effects, ("telegram.send_message", lambda e: e["chat_id"] == BOB))
        with self.assertRaises(AssertionError):
            ordered(effects, ("dial", lambda e: e["recipient"] == OWNER))

    def test_chat_observation_contains_only_the_resolved_private_peer(self):
        # The fake store only holds chats written by production; a stray owner-bot write would
        # appear as an extra chat key and fail `assertEqual(set(lab.chats()), {...})`.
        lab, _ = self.effects_of_a_good_call()
        self.assertEqual(set(lab.chats()), {str(ALICE)})
        self.assertNotIn(str(OWNER), lab.chats())


class OpenInheritedStdin(unittest.TestCase):
    """A harness started with an OPEN stdin pipe (CI, an agent shell) must not hang or leak children.

    The child processes below inherit a pipe whose write end this test keeps open and never
    writes: a query command that reads unused stdin blocks forever on it.
    """

    def under_open_pipe(self, argv, env, timeout):
        reader, writer = os.pipe()
        with tempfile.TemporaryFile("w+") as out:
            process = subprocess.Popen(argv, stdin=reader, stdout=out, stderr=subprocess.STDOUT, env=env,
                                       start_new_session=True)
            os.close(reader)
            try:
                try:
                    process.wait(timeout=timeout)
                except subprocess.TimeoutExpired:
                    self.fail(f"hung on an open inherited stdin pipe for {timeout}s: {argv[1:3]}")
                finally:
                    # Only the group this test created; never anything else on the host.
                    try:
                        os.killpg(process.pid, signal.SIGKILL)
                    except ProcessLookupError:
                        pass
                    process.wait()
            finally:
                os.close(writer)
            out.seek(0)
            return process.returncode, out.read()

    def test_i19_query_commands_do_not_read_an_open_inherited_stdin(self):
        lab = CallLab()
        self.addCleanup(lab.__exit__)
        (lab.control / "plan.json").write_text(json.dumps(lab.plan))
        code, output = self.under_open_pipe(
            [sys.executable, str(Path(__file__).resolve().parent / "support" / "call_fixture_sidecar.py"),
             "caller", f"--store={lab.store}", "call-history", "list"], lab.environment(), 30)
        self.assertEqual(code, 0, output)
        self.assertEqual(json.loads(output.strip().splitlines()[-1]), {"calls": []})
        self.assertEqual([e["stdin"] for e in lab.effects("sidecar.start")], [None])

    def test_i19b_lab_commands_close_stdin_so_a_harness_with_an_open_pipe_cannot_hang(self):
        script = (
            "import sys; sys.path.insert(0, sys.argv[1]); from call_lab import CallLab\n"
            "with CallLab() as lab:\n"
            "    run = lab.run('tg', ['history', 'list', '--json'], timeout=30)\n"
            "    assert (run.code, run.result) == (0, {'calls': []}), (run.stdout, run.stderr)\n"
            "    run = lab.sidecar(['caller', f'--store={lab.store}', 'call-history', 'list'], timeout=30)\n"
            "    assert run.code == 0, (run.stdout, run.stderr)\n")
        support = str(Path(__file__).resolve().parent / "support")
        code, output = self.under_open_pipe([sys.executable, "-c", script, support], dict(os.environ), 60)
        self.assertEqual(code, 0, output)

    def test_i19c_a_hung_lab_command_is_ended_with_its_whole_process_group(self):
        lab = CallLab()
        self.addCleanup(lab.__exit__)
        hang = lab.bin / "hang"
        hang.write_text(f"#!/bin/sh\nsleep 300 &\necho $! > '{lab.control}/child.pid'\nwait\n")
        hang.chmod(0o755)
        from call_lab import run_bounded_checked
        with self.assertRaisesRegex(AssertionError, "process group was ended"):
            run_bounded_checked([str(hang)], 2, env=lab.environment(), cwd=str(lab.root))
        child = int((lab.control / "child.pid").read_text())
        with self.assertRaises(ProcessLookupError):
            os.kill(child, 0)

    def test_i19d_stdin_payload_commands_still_receive_their_input(self):
        lab = CallLab()
        self.addCleanup(lab.__exit__)
        run = lab.run("tg", ["@alice", "--say=ok", "--agent=a", "--json", "--timeout=5"])
        self.assertEqual(run.code, 0, (run.stdout, run.stderr))
        start = lab.effects("sidecar.start")[0]
        self.assertEqual(start["stdin"]["say"], "ok")


class CoverageInventory(unittest.TestCase):
    def test_required_inventory_is_present_in_normal_test_discovery(self):
        sys.path.insert(0, str(REPO / "scripts"))
        from call_acceptance.scenario_inventory import REQUIRED_SCENARIOS
        names = {name for value in globals().values() if isinstance(value, type)
                 and issubclass(value, unittest.TestCase) for name in dir(value) if name.startswith("test_")}
        self.assertEqual(sorted(set(REQUIRED_SCENARIOS) - names), [])


if __name__ == "__main__":
    unittest.main()
