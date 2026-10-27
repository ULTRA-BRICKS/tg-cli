"""Linux descendant cleanup for bounded probes, including preparation's separate session.

The timeout owner freezes its own child tree before enumeration. Kernel parent links prove
ownership; pidfds fence signals against PID reuse. No global process-name matching occurs.
Other platforms retain process-group cleanup and cannot run live acceptance stages.
"""
import ctypes
import os
import signal
import subprocess
import sys
import time
from pathlib import Path


def available():
    if sys.platform != 'linux' or not hasattr(os, 'pidfd_open') or not hasattr(signal, 'pidfd_send_signal'):
        return False
    try:
        handle = os.pidfd_open(os.getpid())
        try:
            signal.pidfd_send_signal(handle, 0)
        finally:
            os.close(handle)
    except OSError:
        return False
    return True


def send(handle, sig):
    try:
        signal.pidfd_send_signal(handle, sig)
    except ProcessLookupError:
        pass


def freeze_tree(pid, include_root=True):
    """Return owned pidfds in parent-first order; every returned process is stopped."""
    handles = []
    seen = set()

    def visit(child, parent=None):
        if child in seen:
            return
        try:
            handle = os.pidfd_open(child)
        except ProcessLookupError:
            return
        try:
            if parent is not None:
                fields = Path(f'/proc/{child}/stat').read_text().rsplit(')', 1)[1].split()
                if int(fields[1]) != parent:
                    os.close(handle)
                    return
            seen.add(child)
            handles.append(handle)
            send(handle, signal.SIGSTOP)
            wait_stopped(child)
            # Threads can each own children; stopped threads cannot add new ones.
            for entry in Path(f'/proc/{child}/task').glob('*/children'):
                try:
                    children = entry.read_text().split()
                except FileNotFoundError:
                    continue
                for descendant in children:
                    visit(int(descendant), child)
        except FileNotFoundError:
            if handle not in handles:
                os.close(handle)

    try:
        if include_root:
            visit(pid)
        else:
            for entry in Path(f'/proc/{pid}/task').glob('*/children'):
                for child in entry.read_text().split():
                    visit(int(child), pid)
    except BaseException:
        for handle in handles:
            send(handle, signal.SIGCONT)
            os.close(handle)
        raise
    return handles


def terminate_tree(process):
    # The disposable supervisor owns waitpid: its exit acknowledges descendant reaping.
    # Killing it together with its children would orphan zombies to an outer subreaper.
    try:
        handle = os.pidfd_open(process.pid)
    except ProcessLookupError:
        process.wait(timeout=2)
        return
    try:
        send(handle, signal.SIGTERM)
        # A stopped supervisor must run its pending TERM handler to reap children.
        send(handle, signal.SIGCONT)
        try:
            process.wait(timeout=4)
        except subprocess.TimeoutExpired:
            descendants = freeze_tree(process.pid, include_root=False)
            try:
                for child in reversed(descendants):
                    send(child, signal.SIGKILL)
                    send(child, signal.SIGCONT)
            finally:
                for child in descendants:
                    os.close(child)
            # Keep the supervisor alive to reap, including adopted grandchildren.
            process.wait(timeout=2)
    finally:
        os.close(handle)


def reap_descendants():
    handles = freeze_tree(os.getpid(), include_root=False)
    try:
        for handle in reversed(handles):
            send(handle, signal.SIGTERM)
            send(handle, signal.SIGCONT)
        deadline = time.monotonic() + .2
        while time.monotonic() < deadline:
            try:
                pid, _ = os.waitpid(-1, os.WNOHANG)
            except ChildProcessError:
                return
            if not pid:
                time.sleep(.005)
    finally:
        for handle in handles:
            os.close(handle)
    kill_and_reap_descendants()


class Stopped(BaseException):
    def __init__(self, signum):
        self.signum = signum


def stopped(signum, frame):
    raise Stopped(signum)


def supervise(argv):
    """Adopt escaped descendants; SIGTERM returns only after all owned children are reaped."""
    signal.signal(signal.SIGTERM, stopped)
    signal.signal(signal.SIGINT, stopped)
    if ctypes.CDLL(None, use_errno=True).prctl(36, 1, 0, 0, 0):
        return 77
    try:
        try:
            child = subprocess.Popen(argv)
        except OSError:
            return 127
        code = child.wait()
    except Stopped as error:
        code = 128 + error.signum
    except KeyboardInterrupt:
        code = 130
    finally:
        # Repeated cancellation must not interrupt the reaper or its spawn-race cleanup.
        signal.signal(signal.SIGTERM, signal.SIG_IGN)
        signal.signal(signal.SIGINT, signal.SIG_IGN)
        reap_descendants()
    return code if code >= 0 else 128 - code




def wait_stopped(child):
    deadline = time.monotonic() + 1
    while Path(f'/proc/{child}/stat').read_text().rsplit(')', 1)[1].split()[0] not in ('T', 't', 'Z', 'X'):
        if time.monotonic() >= deadline:
            raise OSError('owned process could not be stopped')
        time.sleep(.002)


def kill_and_reap_descendants():
    # TERM handlers may fork or detach children. Freeze the current owned tree again
    # before KILL so no resumed handler can extend ownership during the final wait.
    while True:
        handles = freeze_tree(os.getpid(), include_root=False)
        try:
            for handle in reversed(handles):
                send(handle, signal.SIGKILL)
        finally:
            for handle in handles:
                os.close(handle)
        while True:
            try:
                pid, _ = os.waitpid(-1, os.WNOHANG)
            except ChildProcessError:
                return
            if not pid:
                break
        # A parent exiting during enumeration can adopt children after that scan.
        time.sleep(.005)


if __name__ == '__main__':
    raise SystemExit(supervise(sys.argv[1:]))
