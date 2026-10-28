# Laya model caller: autostart and a `required` policy

Ticket: https://git.hyperide.ai/ultrabricks/tg-cli/issues/830 (Refs #830). Companion in task-cli:
`task classify-server start` becomes idempotent/singleton and honours
`TASK_CLASSIFY_SERVER_IDLE_SECONDS` (task-cli#298).

## Problem

Today `tg` only talks to a Laya classify server that is already warm. After the server idles out,
every ask check silently returns `null` and every problem check says "unavailable (no-socket)" and
moves on: the owner gets a quietly weaker `tg` and nobody is told how to fix it. The ask budget
(1200 ms) is also tighter than the measured first warm call on a CPU host.

Measurements (this is where the defaults come from):

| host | mode | latency |
|---|---|---|
| clvm (CPU) | cold start (spawn + model load) | 6.354 s |
| clvm (CPU) | warm requests, in order | 1.395 s, 0.807 s, 0.267 s |
| Ubuntu (live server, this session) | warm ask x8 | 51, 33, 33, 34, 33, 32, 31, 31 ms |
| Ubuntu (live server, this session) | warm problem (2 questions) x8 | 63-64 ms |

## Behaviour

1. **One implementation, in Python.** The whole caller is stdlib-only Python,
   `src/tgcli/laya/`, started by the glue as `python3 -I <repo>/tg-laya ask ...` (the launcher
   `tg-laya` adds only `<repo>/src` to `sys.path`; `-I` keeps the cwd, PYTHONPATH and the user
   site off it, and the environment handed over carries no `PYTHON*` variable, so planted code can
   neither shadow `tgcli` nor the standard library; `TG_PYTHON` overrides the interpreter).
   It owns config parsing and validation, socket
   discovery and trust checks, the unix-socket client, autostart and its failure state. The
   TypeScript side (`features/cli/laya-socket.ts`) shrinks to glue: spawn, parse one JSON
   line, keep the pure helpers that are TS-only because the intent gate is TS (reply
   probability parsing, question text, problem-evidence extraction). The old TS socket client is
   deleted, not wrapped.
2. **Config** (top-level `laya:` block, one-level scalars; env wins over config):

   | key | default | env override | rule |
   |---|---|---|---|
   | `enabled` | `true` | `TG_LAYA` (`0/false/no/off` disable) | boolean |
   | `autostart` | `true` | `TG_LAYA_AUTOSTART` | boolean |
   | `required` | `false` | `TG_LAYA_REQUIRED` | boolean |
   | `cold_timeout_sec` | `75` | `TG_LAYA_COLD_TIMEOUT_SEC` | integer >= 1 |
   | `warm_timeout_ms` | `3000` | `TG_LAYA_TIMEOUT_MS` | integer >= 1 |
   | `task_bin` | unset | - | absolute path |

   `TG_LAYA_SOCKET` still pins one socket (autostart never runs for a pinned socket: the owner
   named a server, tg does not invent another).

   **Pinned socket (`laya.socket` / `TG_LAYA_SOCKET`).** Precedence: env > YAML > discovery. A
   pinned socket is never autostarted. With `laya.required: true` an unreachable pinned socket is
   an explicit failure that names the external supervisor responsible for that socket. The clvm
   host pins a private proxy socket because it cannot hold a resident model.

   Defaults: warm 3000 ms is the hard ceiling for the ask path and covers 2x the worst measured
   first warm call (1.395 s). Cold 75 s = the 60 s `task classify-server start` waits itself plus
   a 15 s margin, so task's own diagnostic wins over our kill; measured cold start is 6.4 s.
   Invalid input (unknown key, non-boolean, non-integer or non-positive timeout, relative
   `task_bin`, `required: true` with Laya disabled by config or `TG_LAYA=0`, bad env value) is a
   diagnostic: exit 78 at the point Laya is consulted, listed by `tg config validate`.
   No silent defaults.
3. **Autostart.** No live socket (none, or connection refused = stale) + `autostart` + not
   `--dry-run` + not disabled -> Python runs `task classify-server start` (argv list, no shell,
   own process group, hard deadline = cold budget, sanitized env: PATH, HOME, XDG_*, TASK_*,
   locale), validates the printed socket path (absolute, private directory owned by the user,
   a socket we own) and asks with the warm budget. A slow but alive server is never restarted:
   a read timeout is `timeout`, not a reason to autostart.
   - **Bounded.** A failed start writes `~/.local/state/tg-cli/laya-autostart.json` (0600, dir
     0700) and is not retried for 300 s; the next consult returns `attempt: skipped, last
     failure <age> ago` immediately. A success deletes the file.
   - **One starter.** Our own `flock` serializes start attempts; after taking the lock the caller
     re-probes (another sender may have started the server) and re-reads the failure state before
     it spawns anything. task keeps its own exclusive flock underneath.
   - **`task` resolution.** `laya.task_bin` if set (must be absolute and executable; a bad value
     fails with that reason, it does not fall through), else `task` over PATH entries that are
     absolute, existing directories, not world-writable, owned by the user or root. Never a
     cwd-relative entry. tg installs and downloads nothing; if `task` itself fetches a model
     that is task's documented behaviour, bounded by the cold timeout, and the remedy text says so.
4. **Policy.**
   - `required: false` (default): same fallback as today, but every unavailable outcome has a
     typed reason (`disabled`, `invalid-config`, `no-socket`, `no-task`, `untrusted-socket`,
     `autostart-failed`, `autostart-skipped`, `cold-timeout`, `timeout`, `connection-error`,
     `invalid-response`, `payload-too-large`), an `attempt` and a `remedy`, shown as an advisory hint
     for BOTH ask and problem checks. The ask path is no longer silent (an explicit `disabled`
     stays quiet for ask, as the owner chose it; problem checks keep their existing hint).
   - `required: true`: if Laya was consulted (the existing conditions decide that) and the outcome
     is unavailable for any reason, the send fails before any Bot API request, exit 1 (the exit
     of every other pre-send gate block; ESCALATION_GATE_ENFORCE=0 does not bypass it):
     `tg: Laya is required (laya.required: true) but unavailable: <reason>. Tried: <attempt>. Next: <remedy>.`
   - `--dry-run` never spawns, connects or loads a model (`skipped: dry-run` stays).
5. **Timeouts are two budgets and two reasons.** `cold-timeout` (autostart: spawn + lock wait)
   and `timeout` (one warm request). Every message states the attempt and the next step, e.g.
   `run: task classify-server start`.

## Wire contract of the glue

`python3 -I <repo>/tg-laya ask --config-dir <dir>` reads one JSON object on stdin
`{message, questions}`. stdout:
first line `{"status":"budget","total_ms":N}` (so the glue can arm a kill timer of `total_ms` +
margin without parsing config itself), final line `{"status":"ok","line":"<reply>"}` or
`{"status":"unavailable","reason","detail","attempt","remedy","policy"}`. Progress ("starting
Laya...") goes to stderr so a cold start is never a silent pause.
`python3 -I <repo>/tg-laya check-config --file <config.yaml>` prints validation diagnostics as JSON;
`tg config validate` appends them, and the TS validator skips `laya.*` value checks so no rule exists
twice. Defaults appear once in Python (`tgcli.laya.config.DEFAULTS`) and once as editor-schema
metadata in `features/config/schema.ts`; `tests/py/test_config_schema_parity.py` pins the two.

## Tradeoffs

- Python on the send path costs ~30-60 ms of interpreter start per consult. Accepted: it runs only
  when Laya is consulted, and it removes a second implementation of config, trust and timeout rules.
- A fixed 300 s failure window can delay recovery after the owner fixes the cause; the remedy text
  names the manual start (`task classify-server start`, after which the next consult connects) as
  the way past it.
- `required: true` turns a missing model into failed sends. That is the point; the default stays
  `false`. When the Python caller itself cannot run (no interpreter, crash, hang) it cannot report
  the policy, so the glue reads `required` itself, fail-closed (env, then the first `required:` of
  the `laya:` block), only in that case: a broken interpreter never turns a required Laya into a
  fallback. Reasons `helper-failed` and `helper-timeout` belong to the glue.
- The test suite sets `TG_LAYA=0` for every spawned child (`tests/hermetic-env.ts`): a stray
  consult would otherwise autostart a model on the developer's host.

## Test matrix

pytest (`tests/py/test_laya_*.py`; a fake `task` script that spawns a fake unix-socket Laya server):
warm ok; stale socket; no socket + autostart ok; autostart failure then the 300 s window (skipped,
then expiry); concurrent starters (one `task` invocation); slow server -> `timeout`; hung start ->
`cold-timeout`; invalid config table (each rule); env precedence; untrusted/relative PATH entries
and `task_bin`; private-dir violation; bad `task` stdout path; dry-run is the caller's job (bun).
bun: glue spawn contract (fake interpreter via TG_PYTHON), launcher isolation (a planted `tgcli` and
`json.py` in the cwd and on PYTHONPATH never run; mutation-checked without `-I`), gate `required` vs fallback, dry-run
spawns nothing, reason hints for ask and problem, `tg config validate` surfacing laya diagnostics,
schema artifacts.
