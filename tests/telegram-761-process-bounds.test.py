"""Synthetic bounded-output and TERM-handler fork regressions for the real process runner.

Each producer is disposable; PID existence checks also reject unreaped zombies.
No credentials, network, media tools, or call effects are used.
"""
import os
import subprocess
import sys
import tempfile
import time
import tracemalloc
import unittest
from pathlib import Path
from unittest import mock

REPO = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(REPO / 'scripts'))
from call_acceptance import owned_processes
from call_acceptance.context import Context
from call_acceptance.process import MAX_OUTPUT, run_bounded


def assert_gone(test, pid):
    with test.assertRaises(ProcessLookupError, msg=f'owned PID {pid} survives (including zombies)'):
        os.kill(pid, 0)


class OutputBounds(unittest.TestCase):
    def test_incremental_drain_retains_bounded_output_and_allocation(self):
        with tempfile.TemporaryDirectory() as folder:
            marker = Path(folder) / 'pid'
            source = ("import os; from pathlib import Path; "
                      f"Path({str(marker)!r}).write_text(str(os.getpid())); block=b'x'*65536\n"
                      "for _ in range(128):\n os.write(1,block); os.write(2,block)\n")
            tracemalloc.start()
            try:
                result = run_bounded([sys.executable, '-c', source], 5)
                _, peak = tracemalloc.get_traced_memory()
            finally:
                tracemalloc.stop()
            self.assertEqual((result.code, result.timed_out, result.truncated), (0, False, True))
            self.assertEqual(result.stdout, 'x' * MAX_OUTPUT)
            self.assertEqual(result.stderr, 'x' * MAX_OUTPUT)
            self.assertLess(peak, 28 * 1024 * 1024, f'unbounded parent allocation: {peak}')
            assert_gone(self, int(marker.read_text()))

    def test_stdin_is_delivered_while_both_output_pipes_are_drained(self):
        text = 'private stdin fixture\n' * 10000
        source = ("import os,sys; block=b'o'*65536\n"
                  "for _ in range(8):\n os.write(1,block); os.write(2,block)\n"
                  "data=sys.stdin.read(); print(len(data)); sys.exit(1)")
        result = run_bounded([sys.executable, '-c', source], 5, input=text)
        self.assertEqual((result.code, result.timed_out, result.truncated), (1, False, False))
        self.assertTrue(result.stdout.endswith(str(len(text)) + '\n'))
        self.assertEqual(result.stderr, 'o' * (8 * 65536))
        self.assertNotIn(text, result.stdout + result.stderr)


@unittest.skipUnless(owned_processes.available(), 'Linux pidfd/subreaper cleanup required')
class HandlerFork(unittest.TestCase):
    def test_timeout_does_not_wait_for_escaped_pipe_eof(self):
        with tempfile.TemporaryDirectory() as folder:
            marker = Path(folder) / 'escaped.pid'
            result = Context().run([sys.executable, str(Path(__file__).resolve()),
                                    '--escaped-pipe', str(marker)], 8)
            self.assertEqual(result.code, 0, result.stderr)
            self.assertEqual(result.stdout.strip(), 'bounded timeout')
            assert_gone(self, int(marker.read_text()))

    def test_term_handler_detaches_child_and_cleanup_reaps_fresh_descendant(self):
        with tempfile.TemporaryDirectory() as folder:
            marker = Path(folder) / 'fork.pid'
            ready = Path(folder) / 'ready'
            leaf = ("import os,time; from pathlib import Path; "
                    f"Path({str(marker)!r}).write_text(str(os.getpid())); time.sleep(4)")
            source = ("import os,signal,subprocess,sys,time; from pathlib import Path\n"
                      "def term(*args):\n"
                      f" subprocess.Popen([sys.executable,'-c',{leaf!r}],start_new_session=True)\n"
                      f" while not Path({str(marker)!r}).exists(): time.sleep(.001)\n"
                      " os._exit(0)\n"
                      "signal.signal(signal.SIGTERM,term)\n"
                      f"Path({str(ready)!r}).write_text(str(os.getpid()))\n"
                      "while True: time.sleep(.01)\n")
            unrelated = subprocess.Popen([sys.executable, '-c', 'import time; time.sleep(10)'],
                                         start_new_session=True)
            try:
                start = time.monotonic()
                result = Context().run([sys.executable, '-c', source], .3)
                elapsed = time.monotonic() - start
                self.assertTrue(ready.exists(), 'TERM handler must actually be installed')
                self.assertTrue(marker.exists(), 'TERM handler must actually fork')
                self.assertTrue(result.timed_out)
                self.assertLess(elapsed, 2, f'TERM-fork child delayed cleanup: {elapsed}')
                assert_gone(self, int(ready.read_text()))
                assert_gone(self, int(marker.read_text()))
                self.assertIsNone(unrelated.poll(), 'unrelated sleeper was signalled')
            finally:
                unrelated.terminate()
                unrelated.wait(timeout=3)


if __name__ == '__main__':
    if len(sys.argv) > 1 and sys.argv[1] == '--escaped-pipe':
        marker = Path(sys.argv[2])
        leaf = ("import os,time; from pathlib import Path; "
                f"Path({str(marker)!r}).write_text(str(os.getpid())); time.sleep(4)")
        source = ("import subprocess,sys,time; "
                  f"subprocess.Popen([sys.executable,'-c',{leaf!r}],start_new_session=True); time.sleep(10)")
        start = time.monotonic()
        with mock.patch.object(owned_processes, 'available', return_value=False):
            result = run_bounded([sys.executable, '-c', source], .3)
        if not result.timed_out or not marker.exists() or time.monotonic() - start >= 2:
            raise AssertionError('timeout waited for escaped pipe EOF')
        print('bounded timeout')
        raise SystemExit(0)
    unittest.main()
