# Port tg-cli to Python — design

Ticket: [tg-cli#768](https://git.hyperide.ai/ultrabricks/tg-cli/issues/768). Plan:
`docs/plans/2026-10-17-python-port.md`.

## 1. Decision and scope

The owner decided on 2026-06-14 at 19:32 (Telegram, «Добро, переводим тулы на питон», after a
review-cli comparison of Bun/TS and Python) that the rig ecosystem is Python-only and tg-cli moves
last; agent-tools recorded it in
[ROADMAP.md lines 33-36](https://git.hyperide.ai/ultrabricks/agent-tools/src/branch/main/ROADMAP.md).
On 2026-10-17 he restated it («все тулы риг экосистемы должны быть на питоне»). Library extraction:
[agent-tools#12](https://git.hyperide.ai/ultrabricks/agent-tools/issues/12).

Why tg-cli is TypeScript: it started on 2026-05-22 (commit `5cfc1d0`) as a 155-line single-file Bun
script, "Simple Telegram CLI to send messages, photos, and files via a bot", three weeks before the
Python decision. The decision put tg-cli last and set no ticket or date, so it kept growing in TS
(47k lines by October), and each shared rule extracted into agent-tools was copied back into TS
(`autostart.ts:14`, `rig-delegate.ts:13`, `AGENTS.md:110-112`). This ticket is the missing one.

In scope: the entrypoints `tg`, `tg-ctl`, `call-cli` and every TypeScript module under `features/`
they load; `tools/omp-live-cli.mjs` (replaced by the Python omp-live client in Phase 2, deleted in
Phase 3); `scripts/deploy.sh`, `install.sh`; the developer scripts `scripts/*.ts` (emoji builders
`create-ai-emoji-set.ts`, `create-tag-emoji.ts`, `sync-tag-pill-alts.ts`, and `e2e-telegram.ts` with
`features/e2e-telegram/`), ported to Python in Phase 3 before the TypeScript they import is deleted;
the TypeScript tests (replaced by pytest or retired with the code they test).

Stays in its current language because its host requires it: `extensions/omp-live.ts` (omp extension
loader) and `features/tg-ctl/omp-live-extension.mjs` + `omp-live-runtime.mjs` (loaded by omp). The
Python daemon talks to them through their on-disk protocol (§6.4), never by importing them.

Already Python and kept: `features/telegram_client` (MTProto, calls, TTS).

Not changed: anything another tool reads (§3). A Python tg-cli is invisible to its callers.

## 2. Architecture: a strangler behind the same entrypoints

```
~/.local/bin/tg ──► <deploy>/bin/tg (POSIX sh switch) ──► ts: exec bun <deploy>/tg
                                                      └─► py: exec <deploy>/.venv/bin/tg
                                                                 │ (tgcli facade)
                                                                 ├─ ported subcommand → Python
                                                                 └─ not ported → exec bun <deploy>/tg
```

### 2.1 Package

- The root `pyproject.toml` becomes the distribution `tg-cli` (setuptools, `uv.lock` committed,
  `requires-python = ">=3.12"`, `[tool.setuptools.packages.find] where = ["src"]`, `include = ["tgcli*"]`)
  and the root of a uv workspace. The existing `tg-call-lib` distribution moves unchanged (name,
  version 0.1.0, extras, scripts, package data) to `features/pyproject.toml` as a workspace member, so
  `call_lib.identity()` and `adapters/calbot/call-lib.ts:43` keep seeing `tg-call-lib 0.1.0`. `tg-cli`
  depends on it as a workspace source (its base dependencies are empty; the `call`/`voice` extras stay
  out), so a plain `uv sync` still puts `.venv/bin/tg-call` and its siblings in place. A consumer that
  installs `tg-call-lib` from git adds `#subdirectory=features` (README "Shared call-lib").
- Import packages: `tgcli` (new, `src/tgcli/`) and `telegram_client` (unchanged, `features/telegram_client`
  until the TypeScript removal moves it to `src/`).
- Console scripts of `tg-cli`: `tg` → `tgcli.entry:tg`, `tg-ctl` → `tgcli.entry:tg_ctl`, `call-cli` →
  `tgcli.entry:call_cli`. `tg-call`, `tg-mtproto`, `tg-call-json`, `call-agent-mock` stay with
  `tg-call-lib`; the repo-root `tg-call`/`tg-mtproto` launchers stay as they are.
- Module map: `features/<area>/<name>.ts` → `src/tgcli/<area>/<name>.py` with `-` → `_`
  (`features/tg-ctl/alert-subscriptions.ts` → `src/tgcli/tg_ctl/alert_subscriptions.py`); an exported
  `camelCase` function becomes `snake_case`; a TS interface for a JSON shape on disk or on the wire
  becomes a `TypedDict`; an in-memory value type becomes a frozen `dataclass`. Named exceptions:
  `features/cli/version.ts` → `tgcli/version.py`, `features/install-skill/install.ts` →
  `tgcli/install_skill.py`; new modules without a TS twin: `tgcli/entry.py`, `tgcli/common/*`,
  `tgcli/send/pipeline.py`, `tgcli/transport/bot_api.py`, `tgcli/text_check.py`, the entrypoint modules. The pure/impure split
  stays: pure modules take their effects as parameters, the entrypoint modules (`tgcli/tg_main.py`,
  `tgcli/tg_ctl_main.py`) own I/O. Handler modules are imported lazily by the facade, so a code update
  that lands before its dependencies (§5 deploy) cannot break every command at import time.
- Version: `tg --version` keeps reading `package.json` `version` at run time (today's single source,
  tg-cli#80) through `tgcli.version.resolve_version()`. `pyproject.toml` carries the same number as a
  static `version` (valid PEP 440 for wheel builds); a test fails when the two differ. The TypeScript
  removal makes `pyproject.toml` the only source.

### 2.2 Facade and fall-through

`tgcli.entry` dispatches the first argv token through a per-entrypoint table of ported handlers.
A token with no handler execs `bun <repo>/<entrypoint> <argv…>` (the TS implementation of the same
checkout, located from the package path; editable install). This lets a component be cut over in
stages (tg-ctl: client subcommands first, the daemon later, §8) while every caller keeps one binary.
The TS treats several first tokens as subcommands only in certain argv shapes (`tg install-skill`
alone; `tg auth`/`tg hooks` only when their parsers accept the argv; `tg voice` bare or
`setup [--dry-run]`; `tg help` with at most one non-flag topic; `tg report` bare, `-h` or followed by a
`--` flag); any other shape is a message to send. A handler reproduces its TS guard and returns
`DECLINE` ONLY for the shapes the TS sends as a message; the facade then runs the default (send)
handler with the full argv. A shape the TS treats as a subcommand that the Python does not handle yet
(for example `tg auth user …` while only bot auth is ported, or `tg user send …` while only the
`user list` alias is) goes to `fall_through`, never to `DECLINE`, so it can never be sent as text.
`DECLINE` may carry a replacement argv for the default handler, for the TS paths that rewrite argv
before sending (`tg user …` → `replies user …` when it is not a replies query, `tg:792-795`; `tg report`
→ its built send argv, `tg:893-894`).
`TG_NO_TS_FALLBACK=1` turns the fall-through into exit 70 with `<entrypoint>: not ported yet: <token>`;
the parity harness sets it, so a parity pass is never a TypeScript pass in disguise. The daemon has
its own switch: `DAEMON_TOKENS` (`run`, `start`, `restart`, `auto-continue-once`, `usage-schedule-check`) go to the Python
handlers only when the `tg-ctl-daemon` selection is `py` (`TG_IMPL_TG_CTL_DAEMON` → `TG_IMPL` → state
file `impl/tg-ctl-daemon` → `ts`, as in §2.3) AND a handler exists; otherwise they fall through to the
TS, even under `TG_NO_TS_FALLBACK=1`. So merging and deploying the stage B code never flips the live
daemon: the flip is `tg-impl use py tg-ctl-daemon`, verified like every other flip, and its rollback is
`tg-impl use ts tg-ctl-daemon`.
At a component's final cutover its table covers every subcommand and the fall-through is deleted with
the TypeScript code.

### 2.3 The switch: cutover and rollback are one command each

- `bin/tg`, `bin/tg-ctl`, `bin/call-cli`: POSIX sh, ~20 lines each. Selection order:
  `TG_IMPL_<NAME>` (`TG_IMPL_TG`, `TG_IMPL_TG_CTL`, `TG_IMPL_CALL_CLI`; the facade reads
  `TG_IMPL_TG_CTL_DAEMON` the same way, §2.2) → `TG_IMPL` →
  `$HOME/.local/state/tg-cli/impl/<name>` (contents `py` or `ts`; a fixed path, not
  `XDG_STATE_HOME`, because the service manager's environment differs from the shell's) → `ts`.
  `ts` execs `${TG_BUN:-bun}` (falling back to `$HOME/.bun/bin/bun` when `bun` is not on PATH) on
  `<repo>/<name>`; the service definitions pin `TG_BUN` to the absolute bun the unit was written with
  (systemd `Environment=TG_BUN=…`, launchd `EnvironmentVariables`), as today's units pin
  `process.execPath`, because a service PATH has neither Homebrew's nor bun's directory. `py` execs
  `<repo>/.venv/bin/<name>`. `<repo>` comes from the shim's resolved real path. Any other selection
  exits 64. Under `py`, a missing console script or a `.venv/bin/python` that does not resolve to an
  executable (an interpreter removed by a uv Python upgrade) exits 71 with
  `<name>: Python implementation unusable at <path>; roll back with: tg-impl use ts <name> (or <repo>/scripts/tg-impl use ts <name>)`.
- `scripts/tg-impl` (stdlib-only Python with 3.9-compatible syntax, so it runs on a stock macOS
  `python3` when the venv is broken; `install.sh` and rig link it as `~/.local/bin/tg-impl`):
  - `tg-impl status [--json]` — selection, source of the selection, and resolved target per entrypoint;
    warns when its own environment carries `TG_IMPL*`, which the service manager does not see.
  - `tg-impl use py|ts tg|tg-ctl|tg-ctl-daemon|call-cli|all` — refuses `py` for a selection whose
    parity component is not in `tests/parity/gated.txt` of the deploy checkout (a missing file reads as
    empty; a hidden `--ungated` flag exists for the parity author's own experiments). Selection →
    component: `tg` → `tg`, `call-cli` → `call`, `tg-ctl` → `tg-ctl-a`, `tg-ctl-daemon` → `tg-ctl`
    (and it needs `tg-ctl` already `py`); `all` applies the rule to each and flips only the gated ones. The same
    mapping decides which entrypoints the parity py legs set to `py` (spec §2.4). It writes the state
    file atomically, then verifies with
    every `TG_IMPL*` variable removed from the environment of the commands it runs (so a stale export
    in the shell can neither block a rollback nor fake a cutover): `tg`: `bin/tg --version` exits 0;
    `call-cli`: `bin/call-cli --help` exits 0; `tg-ctl`: when a service definition exists it must run
    `<repo>/bin/tg-ctl` (Linux: the unit's `ExecStart`, else exit 1 naming `tg-ctl enable`; macOS with
    rig's `ai.hyperide.tg-ctl`: its `ProgramArguments`, else exit 1 naming `rig apply`; macOS otherwise:
    `com.agenttools.tg-ctl.tg-ctl`, fix `tg-ctl enable`); then `systemctl --user restart
    agenttools-tg-ctl-tg-ctl.service` whenever the unit exists, active or not, after stopping any running
    daemon that is not the unit's `MainPID` (the same stray-stop rule as the restart bullet below; macOS:
    `launchctl kickstart -k` on the existing job), else (no service manager, no unit: containers)
    `bin/tg-ctl restart`; then `bin/tg-ctl status` must exit 0,
    report the daemon running, and its `impl:` must equal the expected daemon implementation: `py` only
    when both `tg-ctl` and `tg-ctl-daemon` are selected `py`, else `ts`; whenever the expected daemon is
    `ts`, `impl: unknown` is accepted (the TS writes `run.json` only when git works). For `tg` and
    `call-cli` the check is `bin/<name> --version` (resp. `--help`), plus, only when the resulting
    selection is `py`, `<repo>/.venv/bin/python -m tgcli.entry --self-check <name>` (a rollback to `ts`
    never needs the venv), which imports every registered handler module (lazy imports would
    otherwise hide a missing dependency until the first real send). After a restart,
    status is polled for up to 30 s until a daemon with a new pid holds the lock (the restart and this
    check happen only when a daemon was running before the flip — an installed or enabled unit alone
    never triggers them, since `tg-ctl stop` leaves the unit enabled; a deliberately
    stopped daemon stays stopped, as `deploy.sh` never starts one, and the selection then takes effect on
    its next start), and on a host with the
    unit that pid must be the unit's `MainPID` (a stray that won the flock in the restart window is a
    failed verification, and is stopped). A failed verification
    of a cutover (target `py`) restores `ts`, restarts again and exits 1; a failed verification of a
    rollback (target `ts`) never re-selects `py`: it prints what failed and exits 1 with `ts` selected.
- Every path to the binaries goes through the shims:
  - `install.sh` and rig link `~/.local/bin/{tg,tg-ctl,call-cli}` to `<repo>/bin/<name>` and
    `~/.local/bin/tg-impl` to `<repo>/scripts/tg-impl`, and re-point `~/.files/bin` links per the PATH-check
    rule below;
  - the systemd unit and both launchd plists run `<repo>/bin/tg-ctl run`;
  - TS callers that spawn a sibling entrypoint use `<repo>/bin/<name>`: `tgBinary()` (`tg-ctl:3245`),
    the usage-report send (`tg-ctl:4999`, today a bare `tg` from PATH), `resolveDeployedBin`/`startLauncher`
    (`resolveDeployedBin` ~`tg-ctl:4439-4443`, `startLauncher` `tg-ctl:4192-4213`), `spawnDelayedAutoContinue` (`tg-ctl:7854`, a self-spawn of `auto-continue-once`), `tg`'s daemon autostart (`tg:2789`) and
    `voice setup` passthrough (`tg:690`), and `scripts/deploy.sh`'s `tg-ctl restart` (`:169,241`);
  - on Linux, when the systemd unit exists AND serves this config dir (the unit pins
    `TG_CTL_CONFIG_DIR` for a non-default dir; launchd discovery already matches jobs by config dir),
    `tg-ctl restart` (both implementations) and `deploy.sh` restart through the unit, as the TS already does with `launchctl kickstart` for a launchd job: a
    running daemon that is not the unit's `MainPID` (a detached one, e.g. from `tg`'s lazy autostart) is
    stopped first exactly as `stopDaemon` does (SIGTERM, wait for exit), then
    `systemctl --user restart agenttools-tg-ctl-tg-ctl.service`, so the daemon never ends up detached
    outside its unit with the deploying shell's environment and a fresh unit start never loses the
    flock to a stray; `startLauncher` (`tg-ctl start`, which `tg` runs after a send) starts the unit with
    `systemctl --user start` when the unit is installed, and detaches a daemon as today only when that
    command fails (no user D-Bus in an ssh or agent shell, start limit hit); `deploy.sh`, like `tg-impl`, strips `TG_IMPL*` from the
    commands it runs;
  - the PATH check: `readlink -f "$(command -v tg)"` and the same for `tg-ctl` must end in the deploy
    checkout's `bin/`; `install.sh` re-points a `~/.files/bin/{tg,tg-ctl}` link into ANY tg-cli checkout
    (a directory whose `package.json` has `"name": "tg-cli"` and that holds `tg` and `tg-ctl`) and prints what it changed, because a link earlier on
    PATH would bypass the switch for agents and for the installed hooks, which call a bare `tg-ctl`.
    Service definitions that run `bun <that link>` would break once the link points at a shell shim, so
    `resolveDeployedBin` returns a `bin/tg-ctl` path (never the link; which checkout: below), every definition tg-cli writes
    (daemon unit and plist, the usage-schedule plist `com.agenttools.tg-ctl.usage-schedule`) runs
    `[<repo>/bin/tg-ctl, …]` with `TG_BUN`, and `install.sh` re-renders the enabled ones (`tg-ctl enable`,
    `tg-ctl usage-schedule enable`) BEFORE it moves a link; a rig-owned `ai.hyperide.tg-ctl` plist that
    still runs bun on the link keeps its link untouched and `install.sh` prints `rig apply` as the fix.
    The `tg` and `tg-ctl` links move together or not at all, so `deploy.sh` (which finds its checkout
    through `tg`) and the daemon never point at two different checkouts;
  - which checkout a spawn targets: `tgBinary()` and the self-spawns use the running entrypoint's own
    checkout (`dirname(realpathSync(import.meta.path))`, the "same code" rule they follow today);
    `resolveDeployedBin` keeps preferring the DEPLOYED checkout, as today ("`enable` from a dev checkout
    still launches the right file"): it returns the real path of the deployed `tg-ctl` link (the first
    existing of `~/.local/bin/tg-ctl`, then `~/.files/bin/tg-ctl`; which now
    ends in `<deploy>/bin/tg-ctl`), never the link itself and never a worktree, and falls back to the
    running checkout's `bin/tg-ctl` only when no deployed link exists; `startLauncher` keeps pinning the
    daemon's cwd to that deployed checkout;
  - the Python implementation spawns `<repo>/bin/<name>` for the same purposes.
  So `tg-impl use py tg` also moves the daemon's own alert and report sends, and a deploy restarts the
  selected daemon implementation, never the other one.
- `tg-ctl status` prints `impl: py <version>` or `impl: ts <version>` for the RUNNING daemon (new line
  in both implementations). The daemon records `impl` and the `version` it loaded in
  `tg-ctl.<botId>.run.json` (a record without `version` prints the implementation alone); the field is
  trusted only when the record's pid is the running daemon's pid (as `assessRunningCode` does); a
  matching record without the field is `ts`; no matching record prints `impl: unknown`. The Python
  daemon writes its `run.json` record (with `impl: "py"`) even when git is unavailable. In tg-ctl
  stage A (and in stage B until `tg-ctl-daemon` flips) the facade is Python and the line still says `ts`.

### 2.4 Parity harness

- `tests/helpers/entry.ts` exports `entry(name)` = `[<repo>/bin/<name>]` for `tg`, `tg-ctl` and
  `call-cli`; a one-time codemod replaces every `['bun', TG…]` and `[process.execPath, tgCtlPath…]`
  spawn of those three in the black-box tests with it (`tg-call` is already Python and unchanged, so its
  tests are not touched and not in any manifest). `tests/hermetic-env.ts` sets `TG_IMPL` to `ts` when
  unset, sets `TG_BUN` to `process.execPath` when unset (many tests run children with
  `PATH=/usr/bin:/bin` and a temporary `HOME`, where the shim could not find bun), and forwards
  `TG_IMPL`, every `TG_IMPL_*`, `TG_BUN` and `TG_NO_TS_FALLBACK` to every child, so a developer's state
  file never leaks in and a py leg can never silently run TypeScript.
- `tests/parity/<component>.txt` (`tg`, `call`, `tg-ctl-a` for tg-ctl stage A, `tg-ctl` for the whole
  daemon) lists that component's black-box test files, one per line; a file may be listed in more than
  one manifest (the `tg-ctl` tests whose daemon sends through `tg`, such as
  `ctl-alert-lifecycle-integration`, are also in `tg.txt`, so the `tg` py leg runs the TS daemon calling
  the Python `tg`); a line may carry
  `# py-skip: <reason>` only for a test whose subject the port deletes on purpose (§7: in-tree gates
  replaced by text-lint), and the replacement pytest is named in the reason.
- `scripts/parity <component> [--json] [--gate] [--only <file>]` (stdlib Python, 3.9-compatible syntax; `--only` restricts the run to one manifest file) runs
  `bun test <file>` once per file with every entrypoint pinned to `ts` (`TG_IMPL=ts` and each
  `TG_IMPL_<NAME>=ts`, overriding anything inherited from the invoking shell) and once with the component's entrypoints set to
  `py` (`TG_IMPL_TG=py` for `tg`; `TG_IMPL_CALL_CLI=py` for `call`; `TG_IMPL_TG_CTL=py` for `tg-ctl-a`;
  `TG_IMPL_TG_CTL=py` and `TG_IMPL_TG_CTL_DAEMON=py` for `tg-ctl`), plus every entrypoint whose component is already gated (the §2.3 entrypoint →
  component mapping), every other entrypoint
  pinned to `ts`, and `TG_NO_TS_FALLBACK=1`. A `tg` test that starts a daemon therefore runs the TS daemon
  until tg-ctl is ported. Runs are sequential; output is one row per file (`ts`, `py`, seconds) plus
  totals. Every run (report-only too) exits 1 when a file listed in `tests/parity/<component>.baseline`
  fails under `py` (ratchet: every task adds the files it turned green, and CI enforces it from that
  task on). `--gate` additionally exits 1 when any file that passes under `ts` fails under `py`.
- CI job `parity` runs `scripts/parity <component> --gate` for each component listed in `tests/parity/gated.txt`
  (a component is added when its last port task lands) and the report form for the rest, and uploads
  the JSON. Full parity runs only in CI or through `runpod-run`, never on the workstation.
- A component's **parity gate** is green when `scripts/parity <component> --gate` passes and every
  line without `py-skip` passes under `py`.

## 3. Contracts that stay byte-compatible

The Python implementation must reproduce these exactly; the black-box tests and the shared test
vectors are the proof.

- CLI: every flag, subcommand, stdout line and exit code of `tg` (0, 1, 2, 3, 10, 75, 78, 130),
  `tg-ctl` (lifecycle 0/1/4; `ask` stdin form always 0, question form 0 only on Approve; `withdraw`
  0/1/2/69; `alert` 0/1/3/5) and `call-cli`; `tg-mtproto`/`tg-call` JSON lines (unchanged code).
  The stdout markers other tools parse: `OK tg#<id>[ tg#<id>…]` (tg-ctl alert, task-cli,
  agenttools_stall_watchdog), `tg --session-topic`, `tg --session-id`, `tg-ctl omp-live status --json`
  (rig `riglib/omp_inspect.py:411-463`), `tg-ctl ask` hookSpecificOutput JSON.
- Files under `${TG_CTL_CONFIG_DIR:-~/.config/tg-cli}`: `.env`, `config.yaml`, every
  `tg-ctl.<botId>.*` file named by `features/tg-ctl/lock.ts:12-45`, `inbox/<key>/…` (0700/0600),
  `hosts/<name>.json`, `omp-live/…`, `mtproto/…`, `voice.json`, `pane-locks/`,
  `intent-obligations.jsonl`, `autolink-tasks.json`, `inbox-stranded-report.json`. JSON is written with
  `tgcli.common.jsonio.js_stringify` (JS `JSON.stringify` output: compact separators or `indent=2`,
  raw non-ASCII, JS key order (integer-index keys `"0"`…`"4294967294"` first in ascending order, then the
  rest in insertion order), a lone surrogate written as a `\udXXX` escape, numbers formatted as
  JS does — integral floats without `.0`, exponent form only below `1e-6` or from `1e21`, non-finite as
  `null`), files atomically (tmp + fsync + rename) with the same modes.
- The daemon socket `tg-ctl.<botId>.sock`: one JSON line in, one JSON line out; the five request kinds
  (verify-grant, resolve-session, topic-result, withdraw, ButtonRequest) with today's shapes.
- The lock: `flock(LOCK_EX|LOCK_NB)` on `tg-ctl.<botId>.lock` held for the daemon's life
  (`fcntl.flock`, same open-file-description semantics as the `bun:ffi` call), `DAEMON_LOCK_GRACE_MS`
  1000; status probes `/proc/locks` (Linux) or `lsof -t` (macOS) without taking it.
- Service identity: label `com.agenttools.tg-ctl.tg-ctl`, unit `agenttools-tg-ctl-tg-ctl.service`,
  `Restart=on-failure`, log `tg-ctl.<botId>.log`; macOS external supervisor `ai.hyperide.tg-ctl`.
- Installed hooks and files: `~/.claude/settings.json` entries and sentinel, Codex Stop hook,
  `# agent-tools-awareness`, `~/.agents/skills/tg/SKILL.md` and `.blurbs/tg.md`,
  `~/.omp/agent/extensions/tg-omp-live.ts` header `Managed by tg-cli omp-live (v1)`,
  `~/.agents/hooks/tg/` descriptors.
- The Bot API requests: method names, field names, multipart part names and order, the
  `TG_API_BASE` override, per-attempt timeouts (30 s, 120 s for uploads), the retry budget
  (`TG_SEND_RETRY_BUDGET_MS`, default 60000) and the outbox format (`features/transport/outbox.ts`).

## 4. Libraries

| Need | Choice | Why |
|---|---|---|
| Bot API | own thin client on `httpx` (`httpx.Client` in `tg`, `httpx.AsyncClient` in the daemon), one request builder shared by both | parity needs exact fields and multipart layout, the advisory-thread fallback and `sendRichMessage`, which no maintained library exposes; one dependency for both sides |
| MTProto (`tg auth user/caller`, `tg user send`, `tg call`, `call-cli`) | keep the `features/telegram_client` sidecar (pyrofork, py-tgcalls, ntgcalls) in its own hashed venv `~/.cache/tg-cli/mtproto-runtime-<lock sha>`, spawned as today | keeps `--require-hashes` (tg-cli#714), keeps native call wheels out of every `tg` start, keeps the `TG_MTPROTO_SIDECAR` test seam; the TS front (`features/user-account`) is ported 1:1 |
| Daemon runtime | `asyncio`: `asyncio.start_unix_server`, `create_subprocess_exec`, `loop.add_signal_handler`, `fcntl.flock` | standard library, one event loop like Bun's |
| Text checks | `text_lint` imported in-process (§7) | owner decision; one rule set |
| Service lifecycle | `agenttools_service` | deletes `features/tg-ctl/autostart.ts` |
| Inbox keys | `agenttools_tg_inbox` | deletes `unreachable.ts:19-23,92-96`, `inbox.ts:2-16` |
| Hatch protocol constants | `agenttools_hatch_escalation` (`hatch_env_var`, `_APPROVED_GRANT_RE` promoted to a public `APPROVED_GRANT_RE`, request-id format) | deletes the copies in `questions.ts:211-253`, `grants.ts:8-12,58,88-105,363-367`, `hook-normalize.ts:203-215` |
| agents-hooks/v1 trust | `agenttools_registry` | deletes `features/hooks/types.ts` + the trust half of `runner.ts` |
| tmux inject, rig delegation, Gantt, help, skill install | `agenttools_tmux_inject`, `agenttools_rig_delegate`, `agenttools_gantt`, `agenttools_help`, `advertise` | deletes `inject.ts` send-keys code, `rig-delegate.ts` (and its bug: the candidate list at `rig-delegate.ts:31` misses `~/dev/agent-tools`), the `/tasks` Gantt, `format-help.ts`, `install-skill/install.ts` |
| YAML (`config.yaml`) | port the scalar parser in `features/tg-ctl/config.ts` | the file format is a hand-rolled subset; PyYAML would accept files the TS rejects |
| Tests, lint, types | `pytest`, `ruff` (lint + format check), `mypy --strict` on `src/tgcli` | dict-shape bugs are the main porting risk |

agent-tools libraries and text-lint are public repositories on git.hyperide.ai; they are declared as
normal dependencies with `[tool.uv.sources]` git sources (`subdirectory = "lib/<pkg>"`, pinned `rev`),
locked in `uv.lock`. `agenttools_hatch_escalation` has no `pyproject.toml` today; agent-tools gets one
(`agenttools-hatch-escalation`, stdlib only) in its own PR before tg-ctl needs it. When a lib lacks a
behaviour tg-ctl has (for example the external launchd supervisor in `selectExternalLaunchdSupervisor`),
the behaviour is added to the lib in an agent-tools PR, not re-copied into tg-cli.

## 5. Packaging, install and deploy

- One deploy checkout per machine: `${XDG_DATA_HOME:-~/.local/share}/tg-cli` (where `install.sh`
  clones and where the live systemd unit already runs on this Linux machine). `~/dev/tg-cli` is a
  development checkout only (main checked out, feature work in worktrees). `~/xp/tg-cli` is stale and is
  retired by the owner (listed as a leftover; nothing deletes it automatically). On the macOS machine the
  live checkout is `~/.files/repos/tg-cli` behind `~/.files/bin` (AGENTS.md); there the same consolidation
  (plan Task 5) moves it to the one deploy path, or names it the deploy path in `tools.items.tg.repo`.
- `install.sh`: requires `uv` (prints the install command when missing) and, until the TypeScript
  removal, `bun`; runs `uv sync --frozen --no-dev` in the checkout (creates `<repo>/.venv`), links
  `tg`, `tg-ctl`, `call-cli` from `~/.local/bin` to `<repo>/bin/*` and `tg-impl` to
  `<repo>/scripts/tg-impl` (and re-points `~/.files/bin` links as in §2.3), keeps `tg-call` and
  `tg-mtproto` linked to the repo-root launchers as today, runs `tg install-skill`, and on Linux with a
  usable `systemctl --user` runs `tg-ctl enable`.
- `scripts/deploy.sh`: resolves the deploy checkout through the `tg` link (ending in `bin/tg` or `tg`);
  fetches; installs the fetched revision's dependencies into the live venv BEFORE moving the tree
  (`git show origin/<branch>:<path>` for `pyproject.toml`, `uv.lock` and every workspace member's
  `pyproject.toml` — today `features/pyproject.toml` — plus `.python-version` when the revision has one,
  into a temp project tree,
  then
  `UV_PROJECT_ENVIRONMENT=<repo>/.venv uv sync --frozen --no-dev --no-install-workspace --inexact --project <tmp>`:
  third-party dependencies only, no workspace member is built from the temp tree, which has no sources),
  so new code never runs against old dependencies; a failure there re-runs `uv sync --frozen --no-dev` on
  the current tree (undoing a half-applied install) and exits 4 with the tree unchanged. When
  the fetched revision would change the venv's interpreter (`requires-python` or `.python-version`),
  deploy refuses with exit 4 and names `./install.sh` as the fix, because uv would recreate the live venv.
  Known limit, accepted: an in-place pre-sync swaps packages under running code for the seconds it takes;
  a `tg` started inside that window can fail and exit 1 (the caller sees it). An atomic venv swap is
  not worth its machinery while the code itself is an editable checkout that a fast-forward changes in
  place. The
  pre-sync runs only after the divergence check (exit 2) and the `--dry-run` exit, right before the
  fast-forward. Every path that reaches the restart — fast-forwarded, already up to date (a checkout
  pulled by hand), or a fast-forward that failed after the pre-sync — first runs
  `uv sync --frozen --no-dev` on the tree that is checked out (installs the project, prunes), so the
  venv always matches the code; then it restarts with `<repo>/bin/tg-ctl restart --if-stale`.
- rig: `tools.items.tg: {repo: ~/.local/share/tg-cli}` (rig runs `install.sh`, as for every tool). rig's
  `tg_ctl` block: on Linux, plan and drift run `tg-ctl enable` / check
  `systemctl --user is-enabled agenttools-tg-ctl-tg-ctl.service` and that its `ExecStart` names the deploy
  checkout's `bin/tg-ctl` (today `drift.py:3695` returns early off macOS); on macOS, the
  `ai.hyperide.tg-ctl` plist's `ProgramArguments` become `[<repo>/bin/tg-ctl, run]` instead of
  `[bun, <binPath>, run]`. This is a rig-cli PR in Phase 0 (plan Task 5), before any cutover, so the
  single install path exists before the first switch flips.
- The systemd unit (written by `agenttools_service` from the Python `tg-ctl enable`, and by the TS
  `autostart.ts` until then): `ExecStart=<repo>/bin/tg-ctl run`, `Environment=TG_BUN=<absolute bun>`
  (until the TypeScript removal), `Restart=on-failure`, `RestartSec=2`,
  `StandardOutput/StandardError=append:<cfg>/tg-ctl.<botId>.log`. The launchd plists carry the same
  `TG_BUN` in `EnvironmentVariables`.

## 6. Component notes

### 6.1 `tg` (sender)

Ported first. The send pipeline keeps the TS order (`tg:912` onward): feature flags → argv parse (a
parse error exits 1 before anything else) → text-lint check, run once here, before the credential gate
(§7) → if the verdict blocks on a `Format.Decision` finding, exit 1 now (the TS escalation-format gate,
`tg:1311-1323`, runs before the credential gate on purpose) → credential gate (`tg:1368`: not
`--dry-run` and no token/chat → exit 78; a `TextLintError` from the check above on a send that has no
credentials also exits 78 with the `tg auth` hint, so a fresh install without Laya still learns that it
is not connected) → for `--table`, stdin is read here (as the TS
does, after the credential gate) and the check runs once more on the assembled body with the rows,
replacing the first result → any other blocking finding exits 1 (where the TS ran its other in-tree
text gates, after the credential gate) → attachment checks
(denylist, screenshot gate, unattached-file gate) → `--dry-run` exit → send plan (`tg:2301`) → photo
hooks (`:2334`) → autolink, which rewrites the plan's first text message (`:2372`) → code PDF render
(`:2504`) → text hooks (`:2564`) → session/topic ask → transmit → outbox on budget exhaustion
(`:2734`, exit 75) → reaction (`:2765`), history (`:2778`), routes → daemon autostart (`:2789`) → the `OK tg#…` line → obligations (which may wait on their lock; a failure there never turns a sent message into an error).
Ported with it: the shared subset of `features/tg-ctl` that `tg` imports (paths, config,
routes, session registry read, session name, host registry, omp detection, question-inbox read,
reactions), `features/replies`, `features/transport`, `features/render`, `features/auto-attach`,
`features/hooks`, `features/autolink-*`, `features/branding`, `features/agent-role`,
`features/prefix-style`, `features/auth`, `features/user-account`, `features/install-skill`
(via `advertise`), `features/md-pdf`, `features/code-pdf`. Those shared modules become the canonical
Python versions that tg-ctl reuses. The process table comes from `ps -axo pid=,ppid=,command=` on every
OS, as in the TS, behind an injectable source: the test suite's `ps` fakes must keep working and a
test must never see the developer's real process tree.

### 6.2 `call-cli`

Ships with `tg` (it is a 14-line front for `features/user-account`); same component switch line
`call-cli`, parity manifest `call`.

### 6.3 `tg-ctl` (daemon) — last

Two cutover stages, each with its own parity gate and its own `tg-impl` flip:

- **Stage A — one-shot and client subcommands** in the facade, `run`/`start`/`restart` still fall
  through to the TS daemon: `status`, `stop`, `enable`/`disable` (via `agenttools_service`),
  `install-hooks`, `voice-setup`, `harness-event`, `codex-usage-hook`, `audit-delivery`, `inbox`,
  `usage-schedule`, `alert …`, `ask` (all forms), `withdraw`, `omp-live …`.
- **Stage B — the daemon**: `run`, `start`, `restart`, the socket server, the getUpdates loop,
  delivery (tmux, abduco PTY, omp-live, Stop-hook inbox) with the exactly-once ledger, questions and
  grants, topics and the session registry, `/new`, `/agent`, `/tasks`, voice transcription, outbox
  replay, auto-continue, schedules. The facade fall-through for tg-ctl is then empty.

Order inside the stages follows the module layers in the plan (leaves first). Each stage's flip
needs its parity gate green and a soak: stage A flips after the stage A manifest passes; stage B
flips only after the full tg-ctl manifest passes, then the live proofs in §9.

### 6.4 omp-live from Python

The JS runtime publishes `omp-live/<pid>-<instanceId>.json` and a Unix socket (fallback
`/tmp/ol-<uid>-<24hex>/live.sock`, `omp-live-runtime.mjs:71-117,259-271`). The Python daemon reads the
metadata files and speaks the socket's JSON-line request/response itself (`tgcli/tg_ctl/omp_live.py`),
with shared test vectors taken from `tests/omp-live-*.test.mjs` fixtures, so tg-ctl never spawns node.
`tg-ctl omp-live install` still writes the extension loader (same bytes, same header).

## 7. Text checks through text-lint

The in-tree text gates are replaced by a call into text-lint, absorbing
[tg-cli#764](https://git.hyperide.ai/ultrabricks/tg-cli/issues/764) and text-lint plan tasks 12-13
(text-lint repo, `docs/plans/2026-10-17-text-lint-plan.md`).

- Deleted from the port (not ported): `features/cli/{dict-gate,cjk-guard,mixed-script-guard,
  escalation-format,message-structure,laya-socket}.ts` and the classifier half of `intent-gate.ts`.
  The follow-up obligations store (`intent-obligations.jsonl`, `tg obligations`) stays in tg-cli and is
  fed from the report's `intent`.
- Kept in tg-cli: flood cap, attachment checks (denylist, screenshot gate, unattached-file gate),
  rich-HTML limits, the `answer` → `--reply-to` gate, the title `tg#<id>` / ticket-code gates.
- `tgcli/text_check.py` builds one input@1 document per send (fields `title`, `subagent`,
  `harness_title`, `body`, table rows, captions; markup `html` or `plain`) and calls
  `text_lint.check(document, profile=<profile>, enforce="block", laya_mode=…, dict_path=…)`, text-lint's
  public API (report@1 dict; `TextLintError` for its exit-2 cases), never its internal `check_units`.
- Profile chosen from the send path in code, never from a flag: a bot send (`tg …`, `tg report`,
  daemon-originated sends) → `tg-bot`; `tg user send` and `tg call --say` → `as-user`; a duplex call
  reply (`telegram_client/conversation.py`) → `spoken`, where findings are logged and the reply is
  still spoken. The sidecar runs in its own venv without text-lint, so `tg` passes
  `TG_TEXT_LINT_BIN=<repo>/.venv/bin/text-lint` in the sidecar's environment and `conversation.py`
  resolves that first, then `text-lint` on PATH.
- Sender scope stays the TS one (`tg:1669-1715`) and is applied by the `tg-bot` profile, not by tg
  (text-lint plan task 5): the input@1 `meta` carries `agent_authored` (an agent in the process ancestry
  or an agent env marker, the TS list), `automated` (`--automated`), `tag`, `send_format`,
  `attachments` and `table`. `Intent.*` and the prose-question block apply when `agent_authored` or
  `automated`; with `automated`, `Format.Problem`/`Format.Report` are skipped; `Format.Decision`,
  `Dict.*`, `Script.*` and the rest run on every send. The unattached-file gate stays in tg with its own
  scope (agent-authored and not automated).
- Verdict mapping: `block` → exit 1 with every finding (rule id, matched text, suggestion) on stderr,
  `--dry-run` included; `warn` → stderr, send proceeds. When tg drops findings itself (an ignore list
  text-lint cannot take), the verdict is recomputed from the findings that remain. `ESCALATION_GATE_ENFORCE=0` turns `Format.*`
  findings into warnings. `--no-feature cjk-guard` passes `ignore=("Script.StrayCjk","Script.MixedScript")`.
  A text-lint configuration error (malformed DICT.json, unknown profile) refuses the send and names the
  file; a missing DICT.json at the default path stays a silent pass (`tg:1596-1612`).
- Laya (owner-delegated ruling via Main, 2026-10-17; text-lint plan task 5): Laya is mandatory and
  local. text-lint starts `ai.hyperide.laya.service` once if no server answers. Still unreachable:
  - a send without `--automated` (agent- or human-authored) gets `TextLintError` → refused, exit 1,
    text-lint's message. Programs that call `tg` pass `--automated` (the TS convention); Task 15 checks
    the known callers (tg-ctl, rig sysmon, agenttools_stall_watchdog, task-cli notifications) and files a
    ticket in each repo whose call lacks it. Those callers passing `--automated` (fixed and deployed, or
    verified) is a precondition of the `tg` cutover;
  - a `--automated` send (tg-ctl alerts, usage reports, monitors that pass the flag) gets a report with
    `engines.laya.status = "unreachable"` and a warning; native, Vale and aiw-ru findings still decide
    the verdict, and tg prints the warning and sends.
  `TG_LAYA` and `TG_LAYA_TIMEOUT_MS` lose their meaning; `TG_LAYA_SOCKET` reaches text-lint as
  `TEXT_LINT_LAYA_SOCKET`. Tests never reach the developer's Laya: the test preload and the pytest
  conftest start a fake Laya socket (text-lint's request/response shape) and point
  `TEXT_LINT_LAYA_SOCKET` at it for every child; an explicit socket never makes text-lint start
  `ai.hyperide.laya.service` (text-lint contract, tested in its task 5). Wire shape the fake answers
  (task-cli's classify_server protocol, `text_lint/engines/laya.py`): AF_UNIX stream, one connection per
  request, one JSON line each way; request
  `{"op":"predict","message":…,"questions":{<name>:{"type":"noul","instructions":…}}}` with names
  `slop`, `asks_reader`, `first_person` batched in one request; reply
  `{"ok":true,"result":{"answers":{<name>:{"type":"noul","noul":<0..1>}}}}` or `{"ok":false,"error":…}`. `laya_mode="ci"` is used only when
  `CI=true`. Every daemon-originated send passes `--automated`.
- Precondition: text-lint v0.4.0 (its plan task 9: the public `check` API and the `tg-bot`,
  `as-user` and `spoken` profiles). The black-box files that assert the old gates' wording are marked `py-skip` with the
  pytest that replaces them.

## 8. Cutover, rollback and removal

1. `tg` + `call-cli`: parity gate green → deploy → `tg-impl use py tg` and `tg-impl use py call-cli`
   → live proof (§9). Rollback: `tg-impl use ts tg`.
2. `tg-ctl` stage A: parity gate (stage A manifest) green → deploy → `tg-impl use py tg-ctl` (the
   daemon itself keeps running TS through the fall-through) → live proof. Rollback:
   `tg-impl use ts tg-ctl`.
3. `tg-ctl` stage B: full parity gate green → deploy (the daemon stays TS: its own selection is still
   `ts`) → `tg-impl use py tg-ctl-daemon` restarts the unit on the Python daemon → live proof. Rollback:
   `tg-impl use ts tg-ctl-daemon` (one command; restarts the unit on the TS daemon, which reads the same
   files).
4. Seven days after step 3 with no rollback, a separate PR deletes the TypeScript code, the TS tests,
   `package.json`/`bunfig.toml`, the fall-through, the `ts` branch of the shims and of `tg-impl`, the
   bun requirement in `install.sh` and CI, moves `features/telegram_client` to `src/`, and the version
   into `pyproject.toml`. A rollback inside the seven days restarts the count after the fix.

The tg-ctl daemon bridges every agent session to the owner, so stage B needs the green gate and a
rollback already exercised on the live machine: stage A is flipped to `py`, back to `ts` and to `py`
again with `tg-impl` before stage B starts, which proves the state file, the unit restart and the
status check on the real unit.

## 9. Live proofs per cutover

- `tg`: `tg --dry-run "…"` (exit 0, Python impl per `tg-impl status`), one real send (`OK tg#<id>`),
  a send with a DICT word refused.
- `tg-ctl` stage A: `tg-ctl status` (Python facade), `tg-ctl omp-live status --json`, an
  `alert send --to-holder` delivered into the holder session, `tg-ctl ask` round trip.
- `tg-ctl` stage B: `tg-ctl status` showing `impl: py` with the pid under
  `agenttools-tg-ctl-tg-ctl.service` (`systemctl --user show -p MainPID`), the same four proofs as
  stage A, an inbound reply delivered into a session.

## 10. Owner reports

`tg report` in Russian at: spec and plan ready; `tg` cut over; `tg-ctl` cut over; TypeScript removed.

## 11. Risks and limits

- Mid-port drift: TS keeps receiving fixes (for example #761) while the port runs. Rule: a TS change
  that lands after its module was ported is ported in the same PR or as the next plan task; the
  parity harness catches the behavioural part.
- Startup latency: Python `tg` must not be slower than Bun `tg` by more than 150 ms on a plain
  `--dry-run` (measured in the cutover task; imports of `text_lint` engines and `httpx` are lazy).
- Memory on the workstation: full suites run only in CI or `runpod-run`; locally one test file at a
  time under `nice -n19 ionice -c3`.
