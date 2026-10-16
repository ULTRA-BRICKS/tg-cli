"""Offline identity, literal private mirrors and private call journal regressions."""
import asyncio
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from types import SimpleNamespace
import sqlite3
import sys
import tempfile
import unittest
from unittest.mock import patch
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'features'))
from telegram_client.call_identity import prepare
from telegram_client.call_journal import Journal
from telegram_client.call_mirror import mirror, finish, anchor_text
from telegram_client.core import ClientError


def plan(**kwargs):
    return prepare(SimpleNamespace(say='Нужна помощь.', **kwargs), {})


class IdentityTests(unittest.TestCase):
    def test_quick_intro_connectors_and_distinct_references(self):
        for kind, phrase in [('problem', 'Проблема с'), ('report', 'Отчёт по'), ('question', 'Вопрос по')]:
            row = plan(agent='3d-house', kind=kind, task='OPS-7', task_title='Print Ops')
            self.assertEqual(row['spoken_text'], f'Привет! 3d-house. {phrase} Print Ops. Нужна помощь.')
            self.assertEqual(row['references']['task']['id'], 'OPS-7')
            self.assertEqual(row['references']['task']['title'], 'Print Ops')
            self.assertIsNone(row['references']['project']['id'])

    def test_unknowns_project_and_raw_audio_are_honest(self):
        self.assertIn('Агент неизвестен. Отчёт по неизвестной задаче.', plan()['intro'])
        self.assertIn('Проблема с Print Ops. Проект House.', plan(agent='a', kind='problem', task_title='Print Ops', project_title='House')['intro'])
        row = plan(agent='a', task='T', audio='original.wav', transcript='<literal>')
        self.assertEqual(row['transcript_kind'], 'sender_provided_unverified')
        self.assertEqual(row['audio_transcript'], '<literal>')
        self.assertIn('текст предоставлен отправителем', row['spoken_text'])


class JournalTests(unittest.TestCase):
    def test_filters_and_validated_ids_even_without_database(self):
        with tempfile.TemporaryDirectory() as directory:
            journal = Journal(directory)
            with self.assertRaisesRegex(ClientError, 'CALL_ID_INVALID'):
                journal.history(call_id='../secret')
            with self.assertRaisesRegex(ClientError, 'LIMIT_MUST_BE_1_TO_100'):
                journal.history(limit=0)
            row = journal.begin(plan(task='T-1', project='P-1'))
            self.assertEqual(journal.history(task='T-1', project='P-1')[0]['call_id'], row['call_id'])
            self.assertEqual(journal.history(task='other'), [])
            self.assertEqual(journal.history(project='other'), [])
            with self.assertRaisesRegex(ClientError, 'CALL_ID_NOT_FOUND'):
                journal.update('00000000-0000-0000-0000-000000000000', 'failed')

    def test_sqlite_exception_text_never_escapes(self):
        with tempfile.TemporaryDirectory() as directory:
            journal = Journal(directory)
            journal.begin(plan())
            with patch('telegram_client.call_journal.sqlite3.connect', side_effect=sqlite3.OperationalError('private transcript secret')):
                with self.assertRaisesRegex(ClientError, '^CALL_JOURNAL_UNAVAILABLE$') as caught:
                    journal.history()
                self.assertIsNone(caught.exception.__cause__)

    def test_concurrent_updates_keep_fields_and_private_modes(self):
        with tempfile.TemporaryDirectory() as directory:
            journal = Journal(directory)
            row = journal.begin(plan())
            def update(index):
                journal.update(row['call_id'], 'preparing', **{f'field_{index}': index})
            with ThreadPoolExecutor(max_workers=4) as pool:
                list(pool.map(update, range(12)))
            result = journal.history()[0]
            for index in range(12):
                self.assertEqual(result[f'field_{index}'], index)
            self.assertEqual(journal.path.stat().st_mode & 0o777, 0o600)
            self.assertEqual(journal.directory.stat().st_mode & 0o777, 0o700)


class MirrorTests(unittest.IsolatedAsyncioTestCase):
    def test_status_is_human_readable_and_never_claims_the_call_was_heard(self):
        row = dict(plan(agent='3d-house', task='OPS-7'), call_id='fixture')
        states = {'cancelled': 'Отменён', 'failed': 'Ошибка', 'timeout': 'Истекло время ожидания',
                  'attempting': 'Набор номера', 'audio_stream_ended': 'Аудиопоток завершён'}
        for state, label in states.items():
            with self.subTest(state=state):
                text = anchor_text(row, state)
                self.assertIn('Статус: ' + label, text)
                self.assertIn('прослушивание не подтверждено', text)

    async def test_readable_anchor_same_final_edit_and_literal_transcript_replies(self):
        sent, edits = [], []
        class App:
            async def send_message(self, recipient, text, **options):
                sent.append((recipient, text, options))
                return SimpleNamespace(id=len(sent), chat=SimpleNamespace(id=recipient))
            async def edit_message_text(self, recipient, message_id, text, **options):
                edits.append((recipient, message_id, text, options))
                return SimpleNamespace(id=message_id, chat=SimpleNamespace(id=recipient))
        row = dict(plan(agent='3d-house', task='OPS-7', task_title='Print Ops', task_url='https://example.test/T', session='omp:s'), call_id='fixture', created_at='2026-10-16T12:00:00+00:00', status='intent')
        app = App()
        ids = await mirror(app, 77, row, lambda ids: None, 'disabled', reply_to=12)
        self.assertIn('3d-house', sent[0][1])
        self.assertIn('Print Ops', sent[0][1])
        self.assertIn('2026-10-16', sent[0][1])
        self.assertIn('omp:s', sent[0][1])
        self.assertIn('OPS-7', sent[0][1])
        self.assertNotIn('{"', ''.join(text for _, text, _ in sent))
        self.assertIn('Расшифровка', sent[1][1])
        self.assertEqual(sent[0][2]['reply_to_message_id'], 12)
        self.assertEqual(sent[1][2]['reply_to_message_id'], ids[0])
        self.assertTrue(all(options['parse_mode'] == 'disabled' for _, _, options in sent))
        row.update(status='failed', failure='CALL_TIMEOUT', mirror_ids=ids)
        await finish(app, 77, row, 'disabled')
        self.assertEqual(edits[0][1], ids[0])
        self.assertIn('CALL_TIMEOUT', edits[0][2])


if __name__ == '__main__':
    unittest.main()
