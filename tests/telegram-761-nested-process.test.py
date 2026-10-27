"""Nested bounded-process lifecycle regressions; synthetic local children only.

The outer bounded command is a real subreaper, as when the verifier runs a suite.
The inner result must acknowledge reaping, not leave zombies for that outer owner.
"""
import json
import ctypes
import os
import signal
import subprocess
import sys
import tempfile
import threading
import time
import unittest
from unittest import mock
from pathlib import Path

REPO = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(REPO / 'scripts'))
from call_acceptance import owned_processes
from call_acceptance.process import run_bounded


def wait_for(path):
    deadline = time.monotonic() + 4
    while not path.exists():
        if time.monotonic() >= deadline:
            raise AssertionError('owned children did not start')
        time.sleep(.005)


def probe(mode, root):
    ready, pids = root / 'ready', root / 'pids.json'
    leaf = ("import signal,time; from pathlib import Path; "
            "signal.signal(signal.SIGTERM,signal.SIG_IGN); "
            f"Path({str(ready)!r}).touch(); time.sleep(30)")
    detached = ("import os,signal,subprocess,sys,time,json; from pathlib import Path; "
                "signal.signal(signal.SIGTERM,signal.SIG_IGN); "
                f"child=subprocess.Popen([sys.executable,'-c',{leaf!r}]); ready=Path({str(ready)!r})\n"
                "while not ready.exists(): time.sleep(.005)\n"
                f"Path({str(pids)!r}).write_text(json.dumps([os.getppid(),os.getpid(),child.pid])); time.sleep(30)")
    command = ("import subprocess,sys,time; "
               f"subprocess.Popen([sys.executable,'-c',{detached!r}],start_new_session=True); time.sleep(30)")
    unrelated = subprocess.Popen([sys.executable, '-c', 'import time; time.sleep(30)'], start_new_session=True)
    previous = signal.signal(signal.SIGALRM, lambda *args: (_ for _ in ()).throw(KeyboardInterrupt()))
    timer = None
    try:
        if mode == 'cancel':
            def interrupt_ready():
                wait_for(pids)
                os.kill(os.getpid(), signal.SIGALRM)
            timer = threading.Thread(target=interrupt_ready)
            timer.start()
            try:
                run_bounded([sys.executable, '-c', command], 10)
            except KeyboardInterrupt:
                pass
            else:
                raise AssertionError('cancellation was swallowed')
        else:
            result = run_bounded([sys.executable, '-c', command], 1)
            if not result.timed_out:
                raise AssertionError('timeout was not reported')
        wait_for(pids)
        owned = json.loads(pids.read_text())
        for pid in owned:
            try:
                os.kill(pid, 0)
            except ProcessLookupError:
                continue
            raise AssertionError(f'owned PID {pid} survives inner result')
        if unrelated.poll() is not None:
            raise AssertionError('unrelated sleeper was signalled')
        print(json.dumps({'reaped': len(owned), 'unrelated_alive': True}))
    finally:
        if timer:
            timer.join(timeout=5)
        signal.signal(signal.SIGALRM, previous)
        unrelated.terminate()
        unrelated.wait(timeout=3)
    return 0


def spawn_probe(root):
    marker = root / 'spawn.pid'
    source = f"import os,time; from pathlib import Path; Path({str(marker)!r}).write_text(str(os.getpid())); time.sleep(30)"
    actual_spawn = subprocess.Popen
    children = []
    def interrupted_spawn(argv):
        child = actual_spawn(argv, start_new_session=True)
        children.append(child)
        wait_for(marker)
        os.kill(os.getpid(), signal.SIGTERM)
        return child
    owned_processes.subprocess.Popen = interrupted_spawn
    try:
        code = owned_processes.supervise([sys.executable, '-c', source])
    finally:
        owned_processes.subprocess.Popen = actual_spawn
    if code != 143 or len(children) != 1:
        raise AssertionError('supervisor SIGTERM exit contract changed')
    try:
        os.kill(int(marker.read_text()), 0)
    except ProcessLookupError:
        pass
    else:
        raise AssertionError('spawn-race child survives acknowledgement')
    print(json.dumps({'exit': code, 'reaped': True}))
    return 0


def parent_signal_probe(root, sig):
    # This fixture adopts only its own orphan when the disposable supervisor dies.
    if ctypes.CDLL(None, use_errno=True).prctl(36, 1, 0, 0, 0):
        raise AssertionError('fixture subreaper unavailable')
    marker = root / 'parent-signal.json'
    source = ("import os,signal,time,json; from pathlib import Path; "
              f"Path({str(marker)!r}).write_text(json.dumps([os.getpid(),os.getppid()])); "
              f"os.kill(os.getppid(),{sig}); time.sleep(30)")
    unrelated = subprocess.Popen([sys.executable, '-c', 'import time; time.sleep(30)'], start_new_session=True)
    try:
        start = time.monotonic()
        result = run_bounded([sys.executable, '-c', source], .2)
        elapsed = time.monotonic() - start
        child, parent = json.loads(marker.read_text())
        if not result.timed_out or result.code is not None:
            raise AssertionError('timeout failure contract changed')
        if elapsed >= 2:
            raise AssertionError(f'supervisor cleanup exceeded bound: {elapsed}')
        verify_supervisor_signal(sig, child, parent, result)
        if unrelated.poll() is not None:
            raise AssertionError('unrelated sleeper was signalled')
        print('parent signal cleaned')
    finally:
        reap_fixture_orphans(marker)
        unrelated.terminate()
        unrelated.wait(timeout=3)
    return 0


def verify_supervisor_signal(sig, child, parent, result):
    if sig == signal.SIGKILL:
        assert_killed_child_reaped(child)
        if result.error != 'CLEANUP_FAILED':
            raise AssertionError('unacknowledged orphan cleanup must fail closed')
    else:
        for pid in (child, parent):
            try:
                os.kill(pid, 0)
            except ProcessLookupError:
                continue
            raise AssertionError(f'owned PID {pid} survives stopped supervisor')
        if result.error:
            raise AssertionError('cooperative cleanup did not acknowledge reaping')


def reap_fixture_orphans(marker):
    if marker.exists():
        owned, parent = json.loads(marker.read_text())
        for pid in (parent, owned):
            try:
                reaped, _ = os.waitpid(pid, os.WNOHANG)
                if not reaped:
                    os.kill(pid, signal.SIGKILL)
                    os.waitpid(pid, 0)
            except ChildProcessError:
                pass



def assert_killed_child_reaped(child):
    deadline = time.monotonic() + 1
    while True:
        reaped, status = os.waitpid(child, os.WNOHANG)
        if reaped:
            if os.waitstatus_to_exitcode(status) != -signal.SIGKILL:
                raise AssertionError('orphan was not killed by owned-group cleanup')
            break
        if time.monotonic() >= deadline:
            raise AssertionError('child survives killed supervisor')
        time.sleep(.005)



class NestedLifecycle(unittest.TestCase):
    def parent_signal(self, sig, nested):
        with tempfile.TemporaryDirectory(prefix='parent-signal-761-') as folder:
            argv = [sys.executable, str(Path(__file__).resolve()), '--parent-signal', folder, str(sig)]
            result = (run_bounded(argv, 12) if nested else
                      subprocess.run(argv, capture_output=True, text=True, timeout=12, start_new_session=True))
            code = result.code if nested else result.returncode
            self.assertEqual(code, 0, result.stderr)
            self.assertEqual(result.stdout.strip(), 'parent signal cleaned')

    @unittest.skipUnless(owned_processes.available(), 'Linux pidfd/subreaper cleanup required')
    def test_child_kills_parent_supervisor_direct_and_nested(self):
        for nested in (False, True):
            with self.subTest(nested=nested):
                self.parent_signal(signal.SIGKILL, nested)

    @unittest.skipUnless(owned_processes.available(), 'Linux pidfd/subreaper cleanup required')
    def test_child_stops_parent_supervisor_direct_and_nested(self):
        for nested in (False, True):
            with self.subTest(nested=nested):
                self.parent_signal(signal.SIGSTOP, nested)

    def exercise(self, mode):
        with tempfile.TemporaryDirectory(prefix='nested-lifecycle-761-') as folder:
            result = run_bounded([sys.executable, str(Path(__file__).resolve()), '--probe', mode, folder], 15)
            self.assertFalse(result.timed_out)
            self.assertEqual(result.code, 0, result.stderr)
            self.assertEqual(json.loads(result.stdout), {'reaped': 3, 'unrelated_alive': True})

    @unittest.skipUnless(owned_processes.available(), 'Linux pidfd/subreaper cleanup required')
    def test_nested_timeout_reaps_all_owned_pids_before_return(self):
        self.exercise('timeout')

    @unittest.skipUnless(owned_processes.available(), 'Linux pidfd/subreaper cleanup required')
    def test_nested_cancellation_reaps_all_owned_pids_before_return(self):
        self.exercise('cancel')

    @unittest.skipUnless(owned_processes.available(), 'Linux pidfd/subreaper cleanup required')
    def test_sigterm_during_spawn_reaps_the_child_before_acknowledgement(self):
        with tempfile.TemporaryDirectory(prefix='spawn-lifecycle-761-') as folder:
            result = run_bounded([sys.executable, str(Path(__file__).resolve()), '--spawn-race', folder], 10)
            self.assertEqual(result.code, 0, result.stderr)
            self.assertEqual(json.loads(result.stdout), {'exit': 143, 'reaped': True})

    def test_normal_exit_127_and_spawn_failure_keep_their_contracts(self):
        for code in (0, 7, 127):
            result = run_bounded([sys.executable, '-c', f"import sys; print('fixed'); sys.exit({code})"], 5)
            self.assertEqual((result.code, result.stdout, result.stderr), (code, 'fixed\n', ''))
        with tempfile.TemporaryDirectory(prefix='spawn-error-761-') as folder:
            bad = Path(folder) / 'bad-interpreter'
            bad.write_text('#!/missing-interpreter-761\n')
            bad.chmod(0o700)
            result = run_bounded([str(bad)], 5)
            expected = (127, None) if owned_processes.available() else (None, 'SPAWN_FAILED')
            self.assertEqual((result.code, result.error), expected)
            self.assertEqual((result.stdout, result.stderr), ('', ''))
            missing = run_bounded([str(Path(folder) / 'missing')], 5)
            self.assertEqual(missing.error, 'SPAWN_FAILED')

    def test_portable_exit_and_spawn_failure_without_supervisor(self):
        with mock.patch.object(owned_processes, 'available', return_value=False):
            self.test_normal_exit_127_and_spawn_failure_keep_their_contracts()


if __name__ == '__main__':
    if len(sys.argv) > 1 and sys.argv[1] == '--parent-signal':
        raise SystemExit(parent_signal_probe(Path(sys.argv[2]), int(sys.argv[3])))
    if len(sys.argv) > 1 and sys.argv[1] == '--spawn-race':
        raise SystemExit(spawn_probe(Path(sys.argv[2])))
    if len(sys.argv) > 1 and sys.argv[1] == '--probe':
        raise SystemExit(probe(sys.argv[2], Path(sys.argv[3])))
    unittest.main()
