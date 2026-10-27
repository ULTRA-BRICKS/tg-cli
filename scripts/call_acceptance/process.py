"""Bounded subprocesses with whole-group cleanup. Output is capped; argv/env are never logged."""
import os
import selectors
import shutil
import signal
import subprocess
import sys
import time
from pathlib import Path

from . import owned_processes

MAX_OUTPUT = 4 * 1024 * 1024


class Outcome:
    def __init__(self, code, stdout, stderr, timed_out=False, truncated=False, error=None):
        self.code, self.stdout, self.stderr = code, stdout, stderr
        self.timed_out, self.truncated, self.error = timed_out, truncated, error


def _kill_owned_group(process):
    """Fallback for a lost supervisor; only its original session's group is owned."""
    try:
        os.killpg(process.pid, signal.SIGKILL)
    except ProcessLookupError:
        pass
    except OSError:
        return False
    try:
        process.wait(timeout=2)
    except subprocess.TimeoutExpired:
        return False
    deadline = time.monotonic() + .2
    while True:
        try:
            os.killpg(process.pid, 0)
        except ProcessLookupError:
            return True
        except OSError:
            return False
        if time.monotonic() >= deadline:
            # An orphan zombie cannot be reaped by this owner. Do not claim cleanup.
            return False
        time.sleep(.005)


def _terminate_group(process):
    if owned_processes.available():
        owned_processes.terminate_tree(process)
        return
    try:
        os.killpg(process.pid, signal.SIGTERM)
    except (ProcessLookupError, PermissionError):
        return
    try:
        process.wait(timeout=2)
    except subprocess.TimeoutExpired:
        pass
    # The leader exiting says nothing about descendants that still hold its pipes.
    try:
        os.killpg(process.pid, signal.SIGKILL)
    except (ProcessLookupError, PermissionError):
        pass
    process.wait(timeout=2)


def _drain(process, input, timeout):
    """Drain both pipes to EOF, discarding excess without retaining output-sized chunks."""
    deadline = time.monotonic() + timeout
    output = {process.stdout: bytearray(), process.stderr: bytearray()}
    pending = memoryview(input.encode()) if input is not None else None
    truncated = False
    with selectors.DefaultSelector() as selector:
        for pipe in output:
            os.set_blocking(pipe.fileno(), False)
            selector.register(pipe, selectors.EVENT_READ)
        if pending is not None:
            os.set_blocking(process.stdin.fileno(), False)
            if pending:
                selector.register(process.stdin, selectors.EVENT_WRITE)
            else:
                process.stdin.close()
        while selector.get_map():
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                raise subprocess.TimeoutExpired(process.args, timeout)
            for key, _ in selector.select(remaining):
                pipe = key.fileobj
                pending, excess = handle_pipe(selector, process, pipe, pending, output)
                truncated |= excess
        process.wait(timeout=max(0, deadline - time.monotonic()))
    return output[process.stdout], output[process.stderr], truncated


def run_bounded(argv, timeout, *, env=None, cwd=None, input=None):
    """Run in its own session; on timeout or interruption end the WHOLE process group."""
    command, supervised = supervised_command(argv, env, cwd)
    if command is None:
        return Outcome(None, "", "", error="SPAWN_FAILED")
    try:
        process = subprocess.Popen(command, stdin=subprocess.PIPE if input is not None else subprocess.DEVNULL,
                                   stdout=subprocess.PIPE, stderr=subprocess.PIPE, env=env, cwd=cwd,
                                   start_new_session=True)
    except OSError:
        return Outcome(None, "", "", error="SPAWN_FAILED")
    outcome = None
    try:
        stdout, stderr, truncated = _drain(process, input, timeout)
        outcome = Outcome(process.returncode, stdout.decode("utf-8", "replace"),
                          stderr.decode("utf-8", "replace"), truncated=truncated)
    except subprocess.TimeoutExpired:
        outcome = Outcome(None, "", "", timed_out=True)
        try:
            _terminate_group(process)
        except (OSError, subprocess.TimeoutExpired):
            outcome.error = "CLEANUP_FAILED"
    except BaseException:
        try:
            _terminate_group(process)
        except (OSError, subprocess.TimeoutExpired):
            pass
        raise
    finally:
        cleanup_process(process, supervised, outcome)
    return outcome


def handle_pipe(selector, process, pipe, pending, output):
    if pipe is process.stdin:
        try:
            count = os.write(pipe.fileno(), pending[:4096])
            pending = pending[count:]
        except BrokenPipeError:
            pending = pending[:0]
        if not pending:
            selector.unregister(pipe)
            pipe.close()
        return pending, False
    data = os.read(pipe.fileno(), 65536)
    if not data:
        selector.unregister(pipe)
        return pending, False
    buffer = output[pipe]
    retained = min(len(data), MAX_OUTPUT - len(buffer))
    buffer.extend(data[:retained])
    return pending, retained < len(data)


def supervised_command(argv, env, cwd):
    command = argv
    supervised = owned_processes.available()
    if supervised:
        executable = str(argv[0])
        if '/' in executable:
            candidate = Path(executable) if Path(executable).is_absolute() else Path(cwd or os.getcwd()) / executable
            present = candidate.is_file() and os.access(candidate, os.X_OK)
        else:
            present = shutil.which(executable, path=(env or os.environ).get('PATH')) is not None
        if not present:
            return None, supervised
        command = [sys.executable, str(Path(owned_processes.__file__)), *argv]
    return command, supervised


def cleanup_process(process, supervised, outcome):
    for pipe in (process.stdin, process.stdout, process.stderr):
        if pipe:
            pipe.close()
    if supervised and (process.poll() is None or process.returncode < 0):
        # A signal-killed supervisor never acknowledged descendant reaping.
        if not _kill_owned_group(process) and outcome is not None:
            outcome.error = "CLEANUP_FAILED"
    elif not supervised:
        # Legacy group cleanup has no disposable reaper to acknowledge completion.
        try:
            os.killpg(process.pid, signal.SIGKILL)
        except (ProcessLookupError, PermissionError):
            pass
