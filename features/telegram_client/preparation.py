"""Awaitable call preparation through one private, owned process group.

Effects uses this boundary so synchronous providers, signal metrics and ffmpeg cannot
block the call event loop or outlive cancellation and caller temp-directory cleanup.
Text travels only on stdin; worker diagnostics are bounded stable error codes.
"""
import asyncio
import json
import os
from pathlib import Path
import re
import signal
import sys
from .core import ClientError


async def _stop(process):
    try:
        os.killpg(process.pid, signal.SIGTERM)
    except ProcessLookupError:
        pass
    try:
        await asyncio.wait_for(process.wait(), 2)
    except TimeoutError:
        pass
    finally:
        # Even an exited leader can leave descendants in its owned process group.
        # Linux workers reap adopted descendants; other OSes reap orphans themselves.
        try:
            os.killpg(process.pid, signal.SIGKILL)
        except ProcessLookupError:
            pass
        await process.wait()


async def _reap(process):
    cleanup = asyncio.create_task(_stop(process))
    cancelled = False
    while not cleanup.done():
        try:
            await asyncio.shield(cleanup)
        except asyncio.CancelledError:
            cancelled = True
    cleanup.result()
    if cancelled:
        raise asyncio.CancelledError()


async def prepare_audio(operation, *, timeout=90, **payload):
    env = dict(os.environ, PYTHONPATH=str(Path(__file__).resolve().parent.parent))
    spawn = asyncio.create_task(asyncio.create_subprocess_exec(
        sys.executable, '-m', 'telegram_client.preparation_worker',
        stdin=asyncio.subprocess.PIPE, stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.DEVNULL, start_new_session=True, env=env, limit=4096))
    process = None
    try:
        # Shield creation: cancellation must still obtain and reap a spawned child.
        process = await asyncio.shield(spawn)
        data = json.dumps(dict(operation=operation, **payload)).encode('utf-8')
        async def exchange():
            process.stdin.write(data)
            await process.stdin.drain()
            process.stdin.close()
            output = await process.stdout.read(4097)
            if len(output) > 4096:
                raise ClientError('CALL_AUDIO_PREPARATION_FAILED')
            await process.wait()
            return output
        output = await asyncio.wait_for(exchange(), timeout)
        if process.returncode:
            code = output.decode('ascii', errors='ignore').strip()
            raise ClientError(code if re.fullmatch(r'[A-Z][A-Z0-9_]{0,79}', code) else 'CALL_AUDIO_PREPARATION_FAILED')
        return Path(output.decode('utf-8').strip())
    except asyncio.CancelledError:
        while not spawn.done():
            try:
                await asyncio.shield(spawn)
            except asyncio.CancelledError:
                pass
        process = spawn.result()
        raise
    except TimeoutError:
        raise
    except (OSError, UnicodeError, ValueError):
        raise ClientError('CALL_AUDIO_PREPARATION_FAILED') from None
    finally:
        if process is not None:
            await _reap(process)
