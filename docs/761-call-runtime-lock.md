# Call runtime lock compatibility (#761)

Worktree: `/home/ultra/xp/tg-cli/.worktrees/call-lock-761`, branch
`fix/761-call-lock`, base `218a7a4`. No commit, push, deployment, provider access,
Telegram access, or call was performed. Main owns remote installation/integration.

The clean server's Python 3.13.16 install failed because `aiohttp==3.14.4`
requires `yarl>=1.25.1,<2.0`, while this lock pinned `yarl==1.23.0`.
User-supplied original evidence:
`/home/ultra/.cache/call-integration-20261027/runtime-server.log` on the main
integration host. That remote log was not accessed by this worker.

Only `yarl` changes: **1.23.0 → 1.25.1**. The other 19 pins, including
`aiohttp==3.14.4`, remain unchanged. The replacement carries all **138** wheel/source SHA256
hashes emitted by uv for the release, retaining the lock's multi-platform format.
No dependency or hash was invented or omitted to force installation.

Published metadata sources:

- [aiohttp 3.14.4](https://pypi.org/pypi/aiohttp/3.14.4/json)
- [yarl 1.25.1](https://pypi.org/pypi/yarl/1.25.1/json)
- [PyPI yarl artifact index](https://pypi.org/simple/yarl/)

Shell `curl` could not resolve `pypi.org` (exit 6). The web reader reached the
release endpoints but did not expose their full metadata/artifact arrays.
Resolution and hash generation therefore used the existing uv PyPI cache,
copied into `/tmp/761-lock-cache` to avoid modifying shared cache state:
`simple-v25`, `wheels-v6`, and `sdists-v9/pypi/pyaes` from
`/home/ultra/.cache/uv`. This is cached public metadata, not a fresh index fetch.

The cached aiohttp 3.14.4 CPython 3.12 wheel metadata lists the yarl constraint
above, `multidict>=4.5,<7.0`, and its other base dependencies. The cached yarl
1.25.1 CPython 3.12/3.13/3.14 metadata lists `idna>=2.0`, `multidict>=4.0`,
`propcache>=0.2.1`, and Python `>=3.10`. Existing pins `idna==3.20`,
`multidict==6.9.1`, and `propcache==0.4.1` satisfy these constraints. No new
transitive pin is needed.

`requirements-voice.txt` has no aiohttp/yarl pins; its only overlap with the call
lock is unchanged `typing-extensions==4.15.0`. The packaged
`features/telegram_client/requirements.txt` contains direct dependency ranges,
not a second yarl lock. `pyproject.toml` likewise has direct extras only. The
former packaged `runtime.lock`/`voice-runtime.lock` moved to root in #714/#715
(CHANGELOG 1.60.3); no such packaged lock remains. No lock generator script was
found. The existing format is one exact pin with artifact hashes per line.

## Local verification (2026-10-27)

uv: `0.12.24`; temporary venv interpreter: CPython `3.12.15`.
The offline regression uses `packaging` (also a runtime pin) to evaluate frozen
base Requires-Dist constraints with Python 3.12, 3.13.16 and 3.14.4 markers.
It checks dependency presence and version membership, including the upper bound;
it does not claim to model every package in the runtime. The opt-in test runs
the real resolver over the entire lock with hashes required and `--reinstall`
so a populated environment cannot short-circuit the check.

1. Before changing the lock, `python3 tests/call-runtime-lock.test.py` failed
   because 1.23.0 violates `>=1.25.1,<2.0` on all three Python versions.
   Log: `/tmp/761-lock-test-red.log`.
2. Original whole-lock resolution also failed with the exact conflict (exit 1):

   ```sh
   git show HEAD:requirements-call.txt > /tmp/761-baseline-call.txt
   uv pip compile --offline --cache-dir /tmp/761-lock-cache \
     --python-version 3.12 --generate-hashes /tmp/761-baseline-call.txt \
     -o /tmp/761-baseline-resolved.txt
   ```

   Log: `/tmp/761-red-final.log`.
3. Hash source generation (temporary output's other pins are not adopted):

   ```sh
   printf 'yarl==1.25.1\n' > /tmp/761-yarl.in
   uv pip compile --offline --cache-dir /tmp/761-lock-cache \
     --default-index https://pypi.org/simple --python-version 3.13 \
     --generate-hashes /tmp/761-yarl.in -o /tmp/761-yarl-resolved.txt
   ```

4. Updated whole lock resolves **20 packages** (exit 0) with the same command
   as step 2 against `requirements-call.txt`. Output:
   `/tmp/761-call-resolved.txt`; log: `/tmp/761-green-resolver.log`.
   Comparing every pin/hash to that output found zero unknown hashes. Existing
   unrelated pins retain their original artifact subsets; only yarl adopts its
   complete release hash set.
5. Default regression: 2 passed, 1 explicit opt-in skip. Resolver-enabled run:
   **3 passed**, exit 0:

   ```sh
   uv venv --offline --cache-dir /tmp/761-lock-cache --python 3.12 /tmp/761-lock-runtime
   CALL_RUNTIME_LOCK_RESOLVE=1 \
   CALL_RUNTIME_LOCK_PYTHON=/tmp/761-lock-runtime/bin/python \
   UV_CACHE_DIR=/tmp/761-lock-cache UV_OFFLINE=true \
     python3 tests/call-runtime-lock.test.py
   ```

   Log: `/tmp/761-lock-test-resolver-green.log`.
6. Actual `uv pip install --offline --require-hashes` into the empty venv
   resolves successfully, then fails downloading the uncached ntgcalls 2.1.0
   CPython 3.12 Linux wheel. Log: `/tmp/761-install-attempt.log`. Thus **no
   successful installation is claimed**. Python 3.13 whole-lock metadata is
   also incomplete in the cache (aiohttp 3.14.4), so its actual installation
   remains to be verified by main. No full suite ran locally.

Independent read-only review found the populated-venv short-circuit risk; the
resolver test includes `--reinstall` to address it. `git diff --check` passed.

## Main's clean-server commands

Run from the integrated checkout on the already authorized clean server; use a
fresh directory, preserving the original red environment/log separately:

```sh
uv venv --python python3 runtime-lock-761
uv pip install --python runtime-lock-761/bin/python --require-hashes \
  -r requirements-call.txt
uv pip check --python runtime-lock-761/bin/python
runtime-lock-761/bin/python tests/call-runtime-lock.test.py
CALL_RUNTIME_LOCK_RESOLVE=1 CALL_RUNTIME_LOCK_PYTHON=runtime-lock-761/bin/python \
  runtime-lock-761/bin/python tests/call-runtime-lock.test.py
```

Capture interpreter version, command exit codes and complete resolver/install
output. This must succeed with dependency resolution and hash validation enabled;
neither `--no-deps` nor removal of hashes is an acceptable workaround. Repeat in
a separate Python 3.12 venv for the CLI's managed-runtime target if needed.
These commands install packages/check metadata only; no provider calls are needed.
Main can then run its own authorized optional runtime tests. Native/media/provider
acceptance and the voice ML stack are outside this patch.
