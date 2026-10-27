"""Permanent, exclusive acceptance-run claim before any --call live effects.

A failed or interrupted run consumes its ID. Claims contain no credentials/transcripts,
are fsynced create-only files, and are never automatically removed or retried.
"""
import hashlib
import json
import os
import stat

from . import owned_processes
from .probes_runner import runtime_python
from .report import utc_now


def claim(check, ctx, opts):
    if not owned_processes.available():
        return check.blocked('owned_process_cleanup_unavailable')
    if ctx.deployed_repo is None or runtime_python(ctx, ctx.deployed_repo) is None:
        return check.failed('sidecar_runtime_not_built')
    directory = ctx.config_dir / 'acceptance-runs'
    try:
        directory.mkdir(mode=0o700, exist_ok=True)
        parent = os.open(directory, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
        try:
            info = os.fstat(parent)
            if info.st_uid != os.getuid() or stat.S_IMODE(info.st_mode) != 0o700:
                return check.failed('run_claim_directory_not_private')
            name = hashlib.sha256(opts.run_id.encode()).hexdigest() + '.json'
            try:
                fd = os.open(name, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600, dir_fd=parent)
            except FileExistsError:
                return check.failed('run_id_already_claimed')
            with os.fdopen(fd, 'w') as out:
                json.dump({'schema': 1, 'run_id_sha256': name[:-5], 'claimed_at': utc_now()}, out)
                out.flush()
                os.fsync(out.fileno())
            os.fsync(parent)
        finally:
            os.close(parent)
    except OSError:
        return check.failed('run_claim_unavailable')
    return check.passed('exclusive_durable_run_claim')
