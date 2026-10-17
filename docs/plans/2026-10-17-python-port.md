# Port tg-cli to Python — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `tg`, `call-cli` and then `tg-ctl` run from one Python package behind the same entrypoints, cut over and rolled back with one command each, with the TypeScript kept runnable until seven days of production.

**Architecture:** A `tgcli` package (uv, pyproject) whose facade owns the entrypoints and falls through to the TypeScript for subcommands not yet ported; POSIX sh shims in `bin/` pick the implementation per entrypoint from a state file that `scripts/tg-impl` flips; a parity harness runs the existing black-box tests against both implementations. `tg` ports first, `tg-ctl` last.

**Tech Stack:** Python ≥ 3.12, uv, setuptools, httpx, pytest, ruff, mypy; agent-tools libraries and text-lint as git dependencies; Bun only for the TypeScript under rollback and its tests.

**Spec:** `docs/specs/2026-10-17-python-port-design.md`. Ticket: tg-cli#768 (absorbs #764 and text-lint plan tasks 12-13).

## Phases

| Phase | What | Plan | Ends with |
|---|---|---|---|
| 0 | Package, switch, parity harness, one deploy path | this file, Tasks 1-5 | `tg-impl` and `scripts/parity` merged, CI `python` and `parity` jobs green, one rig-managed install at `~/.local/share/tg-cli` |
| 1 | `tg` and `call-cli` | this file, Tasks 6-18 | `tg` and `call-cli` cut over, live proof, owner report |
| 2 | `tg-ctl` stage A (client subcommands) and stage B (daemon) | `docs/plans/<date>-python-port-tg-ctl.md`, written when Task 18 is complete, from the outline at the end of this file | `tg-ctl` cut over, live proof, owner report |
| 3 | TypeScript removal | `docs/plans/<date>-python-port-ts-removal.md`, written on day 7 after the stage B flip | separate PR merged, owner report |

Phases 2 and 3 get their own plan files because their module-level interfaces depend on the canonical Python modules Phase 1 creates; writing their steps now would guess at those names.

## Global Constraints

- Work in a worktree from `~/dev/tg-cli` (`rig worktree create <name>`); `main` stays checked out in every checkout that a link points at. One PR per task, `Refs #768` in the body (never `Closes`/`Fixes`), CI green, merged with `ship`.
- Module map (spec §2.1): `features/<area>/<name>.ts` → `src/tgcli/<area>/<name>.py`, `-` → `_` in every path segment; exported `camelCase` → `snake_case`; JSON shapes → `TypedDict`; in-memory values → frozen `dataclass`; pure modules take effects as parameters; the named exceptions and new modules of spec §2.1 are the only deviations. A task never invents a second name for something an earlier task's Interfaces block already names.
- TDD red-first: every task first ports, as pytest under `tests/py/`, every test case of the TypeScript white-box test files that import the modules it ports (find them with a grep for `features/<area>/<name>` under `tests/`), plus the tests the task names; runs them red; then implements.
- JSON on disk and on the wire: `tgcli.common.jsonio.js_stringify` only. Whole-file rewrites via `tgcli.common.fsio.atomic_write`; append-only JSONL files that the TS appends to (delivery ledger, obligations, logs, history appends the TS makes with `O_APPEND`) via `tgcli.common.fsio.append_lines` (one `O_APPEND` write of whole lines, fsync where the TS fsyncs), never a rewrite. Every read of a file the TS also writes uses `tgcli.common.fsio.read_text_lossy` (UTF-8, invalid bytes → U+FFFD, as `readFileSync(…,'utf8')`). Same modes as the TypeScript (0600 files, 0700 dirs where the TS uses them).
- String lengths, split points and Telegram entity offsets count UTF-16 code units, as JS does: `tgcli.common.text.utf16_len` / `utf16_slice`, never `len()` on message text. `utf16_slice` ports `safeSliceEnd` (`text-util.ts`); the 4096 splitter ports `safeCut` (`split.ts:64-72`, checks the first excluded unit for a low surrogate, floor `start+1`) — the TS keeps the two rules separate on purpose and so does the port.
- Text from argv and stdin is decoded as Bun does: invalid UTF-8 becomes U+FFFD (`os.fsencode(arg).decode("utf-8", "replace")`, stdin read as bytes from `sys.stdin.buffer` and decoded with `errors="replace"`), never Python's surrogateescape. Stdin and files are never read in text mode: `\r\n` and a lone `\r` stay as Bun keeps them (no universal-newline translation).
- `TG_API_BASE`, `TG_CTL_CONFIG_DIR`, `TG_MTPROTO_SIDECAR`, `TG_SEND_RETRY_BUDGET_MS`, `TG_DICT_PATH`, `TG_TOPIC`, `TG_SESSION` keep their exact meaning; `TG_LAYA`/`TG_LAYA_TIMEOUT_MS` are retired by the text-lint switch and `TG_LAYA_SOCKET` is forwarded as `TEXT_LINT_LAYA_SOCKET` (spec §7).
- No change to TypeScript behaviour except the switch-wiring edits listed in Task 3.
- Tests on the workstation: one file at a time under `nice -n19 ionice -c3`; the full TS suite and full parity runs only in CI or `runpod-run`.
- `ruff check`, `ruff format --check` and `mypy --strict src/tgcli` clean on every task.
- Every code PR bumps the version in `package.json` AND `pyproject.toml` (equal; `test_versions_agree` enforces it) and runs `uv lock` (the CI `python` job runs `uv lock --check`) — patch, except a minor bump for each cutover task — and adds the matching `## <version>` section to `CHANGELOG.md`; docs-only PRs ship with `--no-version-bump-ok`.
- `scripts/tg-impl` and `scripts/parity`: stdlib only, Python 3.9 compatible (stock macOS `python3`), enforced by CI: ruff `extend-include` names both files and a separate `ruff check --target-version py39 scripts/tg-impl scripts/parity` runs, and their pytest files also run under a uv-provided Python 3.9.
- Exit codes: `tg` 0/1/2/3/10/75/78/130; facade not-ported 70; shim bad selection 64, shim unusable Python implementation 71; `deploy.sh` 0/1/2/3 plus 4 (dependency sync failed, tree unchanged).

## Review Focus

1. **Non-ASCII and emoji text at the 4096 limit.** JS counts UTF-16 code units, Python counts code points; a Russian message with emoji near 4096 must split at the same places and produce the same entity offsets as the TS. Test in Task 9 (`test_split_counts_utf16_units`: a body of `"xx"` + 1367 × `"я😀"` (4103 UTF-16 units; the 4096 cut falls between a high and a low surrogate, so the splitter must step back) splits into parts of the same UTF-16 lengths as `features/auto-attach/split.ts` produces for the same input, fixture captured from the TS).
2. **Files written by one implementation, read by the other after a rollback.** routes.json, history.jsonl, outbox entries, obligations written by Python must parse in the TS and the reverse. Test in Task 10 (`test_ts_fixtures_roundtrip`: fixtures generated by running the TS `tg` against a fake API are parsed by the Python and re-serialized byte-identical) and Task 9 for the outbox.
3. **A TS `tg` and a Python `tg` writing at the same time** (tg cut over, daemon still TS spawning `bin/tg`, or a stale shell). The routes and history lock protocols must be the TS ones. Test in Task 10 (`test_routes_lock_interop`: a Python writer blocks while a lock file in the TS format is held, and the TS `withRoutesLock` stale-lock rule applies to a Python-held lock; `test_history_lock_interop` for `<history>.lock`).
4. **A deploy that leaves the venv broken.** With selection `py` and a missing console script or a dangling `.venv/bin/python` (uv Python upgrade), every agent loses `tg`. The shim exits 71 and prints the one-line rollback (`tg-impl use ts tg`). Test in Task 2 (`test_shim_missing_venv`, `test_shim_dangling_interpreter`).
5. **Argument edge cases agents actually send:** a body starting with `-`, literal `\n` escapes, an empty body with `--file`, Cyrillic and emoji in `--title`, a 100 KB body. Test in Task 8 (`test_args_edge_cases`, each case compared with the TS `parseArgs` result captured as a fixture).

---

## Phase 0 — package, switch, parity harness, one deploy path

### Task 1: Package skeleton, facade and the CI `python` job

**Files:**
- Modify: `pyproject.toml` (root becomes distribution `tg-cli`, static `version` equal to `package.json`; `dependencies = ["httpx>=0.28,<1"]`; dependency group `dev = ["pytest>=8,<9", "ruff>=0.7", "mypy>=1.13,<2"]`; `[tool.setuptools.packages.find] where = ["src"]`, `include = ["tgcli*"]`; scripts `tg = "tgcli.entry:tg"`, `tg-ctl = "tgcli.entry:tg_ctl"`, `call-cli = "tgcli.entry:call_cli"`; `[tool.uv.workspace] members = ["features"]`; `tg-call-lib` as a dependency with `[tool.uv.sources] tg-call-lib = { workspace = true }` (so `uv sync` keeps `.venv/bin/tg-call` and siblings); `[tool.pytest.ini_options] testpaths = ["tests/py"]`; ruff and mypy config), `.gitignore` (`.venv/`), `.github/workflows/ci.yml` (new job `python`: `astral-sh/setup-uv` pinned by sha, `uv sync --frozen`, `uv run ruff check`, `uv run ruff format --check`, `uv run mypy --strict src/tgcli`, `uv run pytest -q`), `README.md` ("Shared call-lib and conversational start": `tg-call-lib` now lives in `features/pyproject.toml`; a git install adds `#subdirectory=features`), `requirements-tg.txt` (new: `uv export --frozen --no-dev --no-emit-workspace --format requirements-txt --no-emit-package <name>` repeated for every first-party git source — agent-tools libraries, `hyper-text-lint` — so the file holds third-party packages only; the export command lives in `scripts/export-requirements` so CI and humans run the same one; `ci/dependency-review/dep-audit.sh` already pip-audits every `requirements*.txt`, so the new third-party dependencies are audited; the CI `python` job fails when the file differs from a fresh export), `tests/telegram-call-lib.test.py` (`test_package_declares_single_source` points at `features/pyproject.toml`, the call-lib distribution's new home)
- Create: `src/tgcli/tg_ctl/__init__.py`, `src/tgcli/tg_ctl/text_util.py` (re-export of `safe_slice_end` only), `features/pyproject.toml` (the current `tg-call-lib` project moved verbatim: name, dynamic version from `telegram_client.call_lib.VERSION`, extras `call`/`voice`, its four scripts, `package-dir = {"" = "."}`, `packages = ["telegram_client"]`, package data), `uv.lock`, `src/tgcli/__init__.py`, `src/tgcli/version.py`, `src/tgcli/common/__init__.py`, `src/tgcli/common/jsonio.py`, `src/tgcli/common/fsio.py`, `src/tgcli/common/text.py`, `src/tgcli/entry.py`
- Test: `tests/py/test_version.py`, `tests/py/test_jsonio.py`, `tests/py/test_fsio.py`, `tests/py/test_text.py`, `tests/py/test_facade.py`

**Interfaces:**
- Produces:
  - `tgcli.version.repo_root() -> Path` (the checkout the package is installed from, editable install); `resolve_version(root: Path) -> str` (`package.json` `version`, `"unknown"` when absent or not a string; used by `--version` at run time); `VERSION: str`.
  - `tgcli.common.jsonio.js_stringify(value: object, indent: int | None = None) -> str` (JS `JSON.stringify` output per spec §3: raw non-ASCII, lone surrogates as `\udXXX`, integral floats without `.0`, exponent form only below `1e-6` or from `1e21`, non-finite → `null`).
  - `tgcli.common.fsio.atomic_write(path: Path, data: str | bytes, mode: int = 0o600) -> None` (tmp in the same dir, fsync, rename, fsync dir); `append_lines(path: Path, lines: Sequence[str], *, fsync: bool, mode: int = 0o600) -> None` (one `O_APPEND` write); `read_text_lossy(path: Path) -> str` (`path.read_bytes().decode("utf-8", "replace")`, never `read_text`, so CR bytes survive).
  - `tgcli.common.text.safe_slice_end(s: str, end: int) -> int` (the port of `safeSliceEnd`, `features/tg-ctl/text-util.ts:31-48`, in UTF-16 units, backing up over a whole run of unpaired high surrogates), `utf16_len(s: str) -> int`, `utf16_slice(s: str, start: int, end: int | None = None) -> str` (slices UTF-16 units, the end adjusted by `safe_slice_end`); `tgcli.tg_ctl.text_util` re-exports `safe_slice_end` (module map; Task 6 adds the rest of that module), so the dependency points from `tg_ctl` down to `common`.
  - `tgcli.entry.Decline` (frozen dataclass, `argv: list[str] | None = None`) and `DECLINE = Decline()`; `Handler = Callable[[list[str]], int | Decline]` — a handler returns a `Decline` only for argv shapes the TS sends as a message (spec §2.2), and `dispatch` then runs the `DEFAULT` handler with `decline.argv` when set (the TS argv rewrites) or else the FULL original argv (or falls through when `DEFAULT` is not registered); `DAEMON_TOKENS = frozenset({"run", "start", "restart", "auto-continue-once", "usage-schedule-check"})` (tg-ctl tokens that go to Python only when the `tg-ctl-daemon` selection is `py` — `TG_IMPL_TG_CTL_DAEMON` → `TG_IMPL` → `$HOME/.local/state/tg-cli/impl/tg-ctl-daemon` → `ts` — and a handler exists; otherwise they fall through even under `TG_NO_TS_FALLBACK=1`, spec §2.2); fall-through flushes `sys.stdout` and `sys.stderr` before `os.execvp`; `SUBCOMMANDS: dict[str, frozenset[str]]` (the first-token subcommands of each TS entrypoint: `tg` → `install-skill, auth, call, user, hooks, voice, help, obligations, report, replies`; `tg-ctl` → every subcommand in its `USAGE` constant (`tg-ctl:579-702`, which starts with `start`) and its dispatch block (`tg-ctl:13614-13797`) plus the internal `usage-schedule-check`, `auto-continue-once`; `call-cli` → empty); `DEFAULT = "*"` (key for "not a subcommand": the send path of `tg`, the whole of `call-cli`); `HANDLERS: dict[str, dict[str, str]]` mapping a token to a lazy `"module:function"` reference, imported only when dispatched (empty for all three in this task); `dispatch(entrypoint: str, argv: list[str], env: Mapping[str, str]) -> int`; `tg() -> NoReturn`, `tg_ctl() -> NoReturn`, `call_cli() -> NoReturn`; `python -m tgcli.entry --self-check <entrypoint>` imports every registered handler module and exits 0 (used by `tg-impl`).
  - Fall-through: `fall_through(entrypoint: str, argv: list[str], env: Mapping[str, str]) -> int` — `os.execvp(bun, [bun, str(repo_root() / entrypoint), *argv])`, `bun` = `env["TG_BUN"]`, else `shutil.which("bun")`, else `~/.bun/bin/bun`. With `TG_NO_TS_FALLBACK=1`: stderr `<entrypoint>: not ported yet: <token>` (token `<send>` for the default path), return 70. `dispatch` calls it for an unregistered token; a registered handler calls it itself for the part of its path that is not ported yet.

- [ ] **Step 1: Write the failing tests:** `test_resolve_version_reads_package_json`, `test_resolve_version_unknown` (missing file, non-string version), `test_versions_agree` (`package.json` and `pyproject.toml` versions equal); `test_read_text_lossy_keeps_crlf` and `test_stdin_keeps_crlf` (`a\r\nb\rc` read back byte-identical); `test_js_stringify_key_order` (`{"b":1,"2":2,"a":3,"1":4}` → `{"1":4,"2":2,"b":1,"a":3}`, as JS); `test_js_stringify_matches_js` (compact and `indent=2` output for nested dicts, lists, empty containers, Cyrillic, emoji, `None` → `null`, booleans, ints, `1.0` → `1`, `1e16` → `10000000000000000`, `1e-7` → `1e-7`, `1e21` → `1e+21`, `float("nan")` → `null`, `-0.0` → `0`, `2.0**60` → `1152921504606847000`, a lone `"\ud800"` → `"\ud800"` escaped — expected strings written literally from `JSON.stringify` output); `test_atomic_write_mode_and_content`, `test_atomic_write_replaces_existing`; `test_utf16_len` (`"я😀"` → 3), `test_utf16_slice_never_splits_pair`, `test_utf16_slice_unpaired_high_run` (the `safeSliceEnd` run case from `tests/` ported verbatim: a cut inside `"\ud83d\ud83d\ude00"` backs up over the whole run); `test_dispatch_falls_through` (monkeypatched `os.execvp` receives `[bun, <root>/tg, "hello"]`), `test_dispatch_no_fallback_exit_70` (stderr `tg: not ported yet: <send>`; `tg-ctl status` → `tg-ctl: not ported yet: status`), `test_dispatch_routes_ported_handler` (a handler registered under `"auth"` gets `["login"]` for argv `["auth","login"]`; one under `DEFAULT` gets the full argv when the first token is not a subcommand), `test_dispatch_decline_runs_default_with_full_argv` (an `"help"` handler returning `DECLINE` for `["help","me","with","this"]` → `DEFAULT` receives all four tokens), `test_dispatch_decline_with_rewritten_argv` (a `Decline(["replies","user","x"])` reaches `DEFAULT` with exactly that argv), `test_daemon_tokens_follow_daemon_selection` (for every token in `DAEMON_TOKENS`, e.g. `tg-ctl run`: execs bun with `TG_NO_TS_FALLBACK=1` while `tg-ctl-daemon` is `ts`, even with a registered handler), `test_fall_through_flushes_stdout` (output printed before the exec reaches a pipe), `test_self_check`, `test_handlers_imported_lazily` (registering a reference to a module that does not exist breaks only dispatch to that token), `test_daemon_impl`.
- [ ] **Step 2: Run** `nice -n19 ionice -c3 uv run pytest tests/py -q` — expect import errors.
- [ ] **Step 3: Implement** the modules above and the pyproject changes; `uv lock`.
- [ ] **Step 4: Run** the same command — expect PASS; `uv run ruff check && uv run ruff format --check && uv run mypy --strict src/tgcli` clean; `uv run --package tg-call-lib tg-call library-info` still reports `tg-call-lib 0.1.0`; `python3 tg-call library-info` from the repo root unchanged.
- [ ] **Step 5: Commit** `build: tg-cli Python package skeleton and facade (Refs #768)`; PR; CI green; ship.

### Task 2: Switch shims and `tg-impl`

**Files:**
- Create: `bin/tg`, `bin/tg-ctl`, `bin/call-cli` (POSIX sh, executable), `scripts/tg-impl` (stdlib Python 3, executable, `#!/usr/bin/env python3`)
- Test: `tests/py/test_switch.py`, `tests/py/test_tg_impl.py`

**Interfaces:**
- Consumes: `.venv/bin/<name>` (Task 1 console scripts).
- Produces:
  - Shim selection (spec §2.3): `TG_IMPL_<NAME>` (name upper-cased, `-` → `_`) → `TG_IMPL` → `$HOME/.local/state/tg-cli/impl/<name>` (first line, trimmed; fixed path, `XDG_STATE_HOME` ignored) → `ts`. `ts`: exec `${TG_BUN:-bun}` (or `$HOME/.bun/bin/bun` when `bun` is not on PATH) with `<repo>/<name> "$@"`; `py`: exec `<repo>/.venv/bin/<name> "$@"`. `<repo>` = the shim's own directory's parent after resolving symlinks (`readlink -f` with a POSIX fallback loop for macOS).
  - Unknown selection → stderr `<name>: unknown implementation '<v>' (from <source>); expected py or ts`, exit 64. Under `py`, a missing `.venv/bin/<name>` or a `.venv/bin/python` that is not an executable after resolving links → stderr `<name>: Python implementation unusable at <path>; roll back with: tg-impl use ts <name> (or <repo>/scripts/tg-impl use ts <name>)`, exit 71.
  - `tg-impl status [--json]`: per entrypoint `{"name", "selection", "source" ("env:TG_IMPL_TG" | "env:TG_IMPL" | "state" | "default"), "target"}`.
  - `tg-impl use <py|ts> <tg|tg-ctl|tg-ctl-daemon|call-cli|all>`: verification exactly as spec §2.3, run with every `TG_IMPL*` variable removed from the child environment (`bin/tg --version`; `bin/call-cli --help`; for `tg-ctl` the service-definition check with the Linux/macOS fix hints, the restart, and `impl:` compared with the expected daemon implementation per spec §2.3; `--self-check` for `tg`/`call-cli` only when the resulting selection is `py`, so a rollback to `ts` with a broken venv still verifies; selections `tg|tg-ctl|tg-ctl-daemon|call-cli|all`; a missing `gated.txt` reads as empty); unit path `${XDG_CONFIG_HOME:-~/.config}/systemd/user/agenttools-tg-ctl-tg-ctl.service`, launchd labels `ai.hyperide.tg-ctl` (rig) then `com.agenttools.tg-ctl.tg-ctl`; `systemctl`/`launchctl` found on PATH (tests put fakes there). Exit 0 verified, 1 verification failed (selection restored), 2 usage.

- [ ] **Step 1: Write the failing tests** (each runs the real shim or script in a tmp `HOME` with `XDG_CONFIG_HOME` removed, fake `bun`, fake `.venv/bin/*`, fake `systemctl`/`launchctl` that record their argv): `test_shim_default_is_ts`, `test_shim_state_file_py`, `test_shim_ignores_xdg_state_home`, `test_shim_env_beats_state`, `test_shim_per_entry_env_beats_global`, `test_shim_unknown_selection_exit_64`, `test_shim_missing_venv` (exit 71, the rollback line), `test_shim_dangling_interpreter` (`.venv/bin/python` → a removed target: exit 71), `test_shim_through_symlink` (`~/.local/bin/tg` → `bin/tg` resolves `<repo>`), `test_shim_bun_fallback_path` (no `bun` on PATH → `$HOME/.bun/bin/bun`); `test_impl_status_json`, `test_impl_status_warns_env_override`, `test_impl_use_tg_writes_and_verifies`, `test_impl_use_tg_failed_verify_restores` (fake `.venv/bin/tg --version` exits 1 → state file back to `ts`, exit 1), `test_impl_use_call_cli_verifies_help`, `test_impl_use_tg_ctl_requires_shim_unit` (unit `ExecStart=bun …/tg-ctl run` → exit 1, message names `tg-ctl enable`), `test_impl_use_tg_ctl_macos_rig_plist_hint` (fake `launchctl` listing `ai.hyperide.tg-ctl` with a bun `ProgramArguments` → exit 1, message names `rig apply`), `test_impl_use_tg_ctl_restarts_unit` (fake systemctl `is-active` → active; `restart` recorded; fake `bin/tg-ctl status` prints `running` and `impl: ts 1.0.0`, fake `tg-ctl-daemon` is `ts` → exit 0), `test_impl_use_tg_ctl_impl_mismatch_restores` (expected `py`, status says `impl: ts` → `ts` re-selected, exit 1), `test_impl_rollback_never_reselects_py` (target `ts`, fake status keeps failing → exit 1, state file still `ts`), `test_impl_waits_for_new_pid` (fake status reports the old pid twice, then a new one → exit 0 within the 30 s poll), `test_impl_ts_accepts_impl_unknown`, `test_impl_stage_a_accepts_impl_unknown` (target `py`, `tg-ctl-daemon` is `ts`, status `impl: unknown` → exit 0), `test_impl_restarts_inactive_unit` (unit exists and is inactive, a stray daemon is running → `systemctl --user restart`, never `bin/tg-ctl restart`), `test_impl_stops_stray_before_unit_restart` (a running daemon that is not the unit's `MainPID` gets SIGTERM before the restart), `test_impl_lock_holder_must_be_main_pid` (after the restart the lock holder is not the unit's `MainPID` → verification fails, the stray is stopped), `test_impl_use_all`, `test_impl_refuses_ungated_py` (`tg` not gated → exit 1, state unchanged; `--ungated` overrides), `test_impl_component_mapping` (`call` gated → `use py call-cli` allowed; `tg-ctl-a` gated and `tg-ctl-daemon` is `ts` → `use py tg-ctl` allowed; `tg-ctl-daemon` is `py` with only `tg-ctl-a` gated → refused; `use py all` flips only gated entrypoints), `test_impl_does_not_start_stopped_daemon` (no daemon running, unit installed AND enabled — the state after `tg-ctl stop` → no `systemctl` call, state written, exit 0 with the next-start note), `test_impl_use_ignores_shell_env` (`TG_IMPL_TG=py` exported and a broken venv: `tg-impl use ts tg` runs no `--self-check`, still verifies and exits 0), `test_impl_use_tg_ctl_without_service_manager` (no unit, no `systemctl` on PATH: no unit check, `bin/tg-ctl restart` recorded, status check applies).
- [ ] **Step 2: Run** `nice -n19 ionice -c3 uv run pytest tests/py/test_switch.py tests/py/test_tg_impl.py -q` — FAIL.
- [ ] **Step 3: Implement** the shims and `tg-impl`.
- [ ] **Step 4: Run** the same — PASS; `sh -n bin/*` and `shellcheck -s sh bin/*` clean when shellcheck is installed.
- [ ] **Step 5: Commit** `feat: per-entrypoint implementation switch and tg-impl (Refs #768)`; PR; CI green; ship.

### Task 3: Route every caller through the shims

**Files:**
- Modify (the switch-wiring edits; spec §2.3 lists the sites by symbol; in every TS edit `<repo>` = `dirname(realpathSync(import.meta.path))` of the running entrypoint, never a value derived from `binPath` or a `~/.files/bin` link — except `resolveDeployedBin` and `startLauncher`'s cwd, which keep preferring the deployed checkout per spec §2.3):
  - `tg-ctl` (entrypoint): `tgBinary()` prefers `<repo>/bin/tg`; `sendScheduledUsageReport` uses `tgBinary()` instead of a bare `tg`; `resolveDeployedBin` returns the real path of the first existing deployed link among `~/.local/bin/tg-ctl` and `~/.files/bin/tg-ctl` (now ending in `<deploy>/bin/tg-ctl`; never the link itself), falling back to `<repo>/bin/tg-ctl` only when neither exists, and `startLauncher` keeps pinning the daemon's cwd to that checkout; `startLauncher` runs `systemctl --user start agenttools-tg-ctl-tg-ctl.service` when the unit is installed AND serves this config dir (its `TG_CTL_CONFIG_DIR` equals the resolved config dir, or it pins none and the config dir is the default) and otherwise (or when that command fails) detaches `bin/tg-ctl run` as today; `restartDaemon` with such a unit stops a running daemon that is not the unit's `MainPID` as `stopDaemon` does, then runs `systemctl --user restart` (a unit serving another config dir is never started or restarted); `spawnDelayedAutoContinue` spawns `<repo>/bin/tg-ctl auto-continue-once`; `recordRunInfo` adds `impl: "ts"` and the loaded `version` to `run.json`; `status` prints `impl: <impl> <version>` after the `code:` line from `run.json` only when its pid is the running daemon's pid (as `assessRunningCode` does): field absent → `ts`, `version` absent → implementation alone, no matching record → `impl: unknown`.
  - `tests/hermetic-env.ts` + `tests/helpers/hermetic-host.ts`: the preload also shims `systemctl` (exits 1 for every call, so `hasUserSystemd()` is false — a test that wants systemd prepends its own fake) and deletes `XDG_CONFIG_HOME`, so no test reads, starts or restarts the host's real unit; `tests/py/conftest.py` deletes `XDG_CONFIG_HOME` the same way.
  - `tg` (entrypoint): the daemon autostart (`tg-ctl start` after a send) and the `voice setup` passthrough spawn `<repo>/bin/tg-ctl`.
  - `features/tg-ctl/autostart.ts`: systemd `ExecStart` and launchd `ProgramArguments` use `<repo>/bin/tg-ctl run` when that file exists, else today's bun form; with the shim form the unit gets `Environment=TG_BUN=<process.execPath>` and the plist `EnvironmentVariables.TG_BUN`.
  - `features/tg-ctl/usage-schedule.ts`: the usage-schedule plist runs `[<repo>/bin/tg-ctl, usage-schedule-check]` with `TG_BUN`.
  - `install.sh`: require `uv` with the install hint; `uv sync --frozen --no-dev`; link `~/.local/bin/{tg,tg-ctl,call-cli}` to `<repo>/bin/*` and `~/.local/bin/tg-impl` to `<repo>/scripts/tg-impl`; re-render the enabled service definitions (`bin/tg-ctl enable`, `bin/tg-ctl usage-schedule enable`) BEFORE moving any link; then re-point existing `~/.files/bin/{tg,tg-ctl}` links whose target is a tg-cli checkout (a directory whose `package.json` has `"name": "tg-cli"` and that holds `tg` and `tg-ctl`), both or neither, and neither while rig's `ai.hyperide.tg-ctl` plist still runs bun on the link (print `rig apply`); `tg-call`/`tg-mtproto` unchanged.
  - `scripts/deploy.sh`: resolve the checkout through a link ending in `bin/tg` or `tg`; strip `TG_IMPL*` from the commands it runs; after the divergence check and the `--dry-run` exit, install the fetched revision's third-party dependencies exactly as spec §5 (temp tree with `pyproject.toml`, `uv.lock`, every workspace member's `pyproject.toml`, `.python-version`; `--no-install-workspace`; exit 4 with the tree unchanged on failure or on an interpreter change); fast-forward; on every path that reaches the restart run `uv sync --frozen --no-dev` on the checked-out tree; restart with `<repo>/bin/tg-ctl restart --if-stale`.
  - `AGENTS.md` ("This checkout is the live binary" names the shims and `tg-impl`), `README.md` (install: uv requirement).
- Test: `tests/ctl-autostart.test.ts` (new cases), `tests/ctl-status-impl.test.ts` (new), the existing install/deploy tests (`grep -l 'install.sh\|deploy.sh' tests/`) extended for the new links, the `~/.files/bin` re-point, the pre-sync step and exit 4

**Interfaces:**
- Consumes: `bin/*` (Task 2).
- Produces: unit `ExecStart=<repo>/bin/tg-ctl run`; `status` line `impl: <py|ts> <version>`; `run.json` optional field `impl: "py" | "ts"` (Python daemon writes `"py"` in Phase 2).

- [ ] **Step 1: Write the failing tests:** autostart plan with `bin/tg-ctl` present renders `ExecStart=<repo>/bin/tg-ctl run` and the plist `ProgramArguments` `[<repo>/bin/tg-ctl, run]`; without it the old form; `tg-ctl status` against a fake run.json with the daemon's pid and no `impl` prints `impl: ts <version>`, with `"impl":"py"` prints `impl: py <version>`, with another pid prints `impl: unknown`; the unit rendered after the `~/.files/bin/tg-ctl` → `<repo>/bin/tg-ctl` re-point (the live layout) still names `<repo>/bin/tg-ctl run` and carries `TG_BUN`; `tgBinary()` returns `<repo>/bin/tg` when present (test through `alert send` with a fake `bin/tg` that records argv); the usage-report send goes through the same fake; `startLauncher` with `~/.files/bin/tg-ctl` → `<repo>/tg-ctl` launches `<repo>/bin/tg-ctl run`; `tg` autostart and `tg voice setup` spawn a fake `bin/tg-ctl`; install test asserts the links target `bin/*` and `~/.local/bin/tg-impl` targets `scripts/tg-impl`, a pre-existing `~/.files/bin/tg` → `<repo>/tg` link and a `~/.files/bin/tg-ctl` → `<other tg-cli checkout>/tg-ctl` link are re-pointed and reported, and `uv sync --frozen --no-dev` ran (fake `uv` on PATH); deploy test (real `uv`, local bare remote, a revision that adds a dependency and keeps the `features` workspace member) asserts the dependency pre-sync ran against the fetched lock BEFORE the merge and succeeded, a failing pre-sync exits 4 with `HEAD` unchanged, the pre-sync never runs on a diverged checkout or under `--dry-run`, `uv sync` of the checked-out tree runs before every restart (after the merge, on the already-up-to-date path, and after a failed fast-forward), `TG_IMPL*` stripped from the restart's environment, a Linux host with the unit restarts through a fake `systemctl --user restart` after stopping a stray detached daemon whose pid is not the unit's `MainPID`, a fetched revision with another `requires-python` exits 4 naming `./install.sh`, the usage-schedule plist renders `[<repo>/bin/tg-ctl, usage-schedule-check]` with `TG_BUN`, install re-renders the enabled definitions before moving links and leaves a link alone while a rig plist runs bun on it, resolution through a `bin/tg` link, and the restart through `bin/tg-ctl`.
- [ ] **Step 2: Run** each file alone: `nice -n19 ionice -c3 bun test tests/ctl-autostart.test.ts` etc. — FAIL.
- [ ] **Step 3: Implement** the edits listed under Files.
- [ ] **Step 4: Run** each touched test file alone — PASS. Full suite in CI.
- [ ] **Step 5: Commit** `feat: route tg, tg-ctl and the service unit through the switch shims (Refs #768)`; version patch bump + CHANGELOG; PR; CI green; ship; on the machine: `scripts/deploy.sh`, then `./install.sh` from the deploy checkout (links move to `bin/*`), then `tg-ctl enable` once so the live unit's `ExecStart` names `bin/tg-ctl`; `tg-impl status` shows `ts` everywhere; `tg-ctl status` shows `impl: ts`.

### Task 4: Parity harness

**Files:**
- Create: `tests/helpers/entry.ts`, `tests/parity/tg.txt`, `tests/parity/call.txt`, `tests/parity/tg-ctl-a.txt`, `tests/parity/tg-ctl.txt`, `tests/parity/{tg,call,tg-ctl-a,tg-ctl}.baseline` (empty), `tests/parity/gated.txt` (empty), `scripts/parity` (stdlib Python 3), `scripts/codemod-entry.py` (one-shot; deleted in the same PR after use)
- Modify: every black-box test file that spawns `tg`, `tg-ctl` or `call-cli` (the codemod's output; `tg-call` tests are untouched and in no manifest), `tests/helpers/daemon-lifecycle.ts` (`spawnDaemon` drops its required `tgCtlPath` option and spawns `entry('tg-ctl')`; the codemod rewrites its 40+ callers and deletes their now-dead `TG_CTL`/`TG_SCRIPT` constants and `join(…, 'tg'|'tg-ctl'|'call-cli')` path builds), `tests/hermetic-env.test.ts` (new cases), `tests/hermetic-env.ts` (`TG_IMPL` defaults to `ts`, `TG_BUN` defaults to `process.execPath`; forwards `TG_IMPL`, `TG_IMPL_*`, `TG_BUN`, `TG_NO_TS_FALLBACK` with `??=`, also into explicit child envs), `.github/workflows/ci.yml` (job `parity`: setup-bun, setup-uv, apt deps as in `test`, `uv sync --frozen`, `scripts/parity <c> --gate` for components in `gated.txt`, `scripts/parity <c> --json` for the rest, upload `parity-*.json`)
- Test: `tests/py/test_parity_script.py`, `tests/py/test_parity_manifests.py`, `tests/entry-helper.test.ts`

**Interfaces:**
- Consumes: `bin/*` (Task 2), the facade's exit 70 (Task 1).
- Produces:
  - `entry(name: 'tg' | 'tg-ctl' | 'call-cli'): string[]` → `[join(REPO, 'bin', name)]`.
  - Manifest line format: `<test file path relative to repo>` optionally followed by `  # py-skip: <reason naming the replacement pytest>`; `#` comment lines allowed.
  - `scripts/parity <component> [--json] [--gate] [--only <file>]`; py-leg environment exactly as spec §2.4 (component entrypoints and already-gated components `py`, everything else `ts`, `TG_NO_TS_FALLBACK=1`); JSON: `{"component", "files": [{"file", "ts": "pass"|"fail", "py": "pass"|"fail"|"skip", "ts_s", "py_s"}], "ts_pass", "py_pass", "py_skip", "gate": "pass"|"fail"|null}`; exit 1 on a gate failure (spec §2.4), 2 on usage or a missing manifest file.
  - `tg-ctl-a.txt` = the stage A subset of `tg-ctl.txt` (files exercising only `status`, `stop`, `enable`, `disable`, `install-hooks`, `voice-setup`, `harness-event`, `codex-usage-hook`, `audit-delivery`, `inbox`, `usage-schedule`, `alert`, `ask`, `withdraw`, `omp-live`).

- [ ] **Step 1: Write the failing tests:** `test_parity_gate_regression_fails` (fake `bun` on PATH that passes under `ts`, fails under `py` for one file → `--gate` exit 1), `test_parity_baseline_ratchet` (file in baseline failing under py → exit 1 even if it also fails under ts), `test_parity_skip_line` (py-skip line not run under py, reported `skip`), `test_parity_json_shape`, `test_parity_py_leg_env` (fake bun records the env: for component `tg` the py leg has `TG_IMPL=ts`, `TG_IMPL_TG=py`, `TG_IMPL_TG_CTL=ts`, and `TG_NO_TS_FALLBACK=1`; with `tg` in `gated.txt`, the `tg-ctl` py leg has both `TG_IMPL_TG=py` and `TG_IMPL_TG_CTL=py`); `test_parity_ts_leg_ignores_inherited_env` (parity started with `TG_IMPL_TG=py` exported: the ts leg still gets `TG_IMPL_TG=ts` and no `TG_NO_TS_FALLBACK`); `tests/py/test_parity_manifests.py::test_manifests_cover_every_entry_spawner` (a pytest that reads the TS sources: every `tests/*.test.ts` that calls `entry(` appears in at least one of `tg.txt`, `call.txt`, `tg-ctl.txt`, and no manifest names a file that does not call it; runs in the CI `python` job so a later test file without a manifest line fails CI); `tests/py/test_parity_manifests.py::test_no_direct_entrypoint_spawns` (no file under `tests/` other than `tests/helpers/entry.ts` builds a path to the repo-root `tg`, `tg-ctl` or `call-cli` — `join(…)` calls whose last segment is exactly `'tg'`, `'tg-ctl'` or `'call-cli'` (so `'tg-call'` does not match), `TG_CTL`/`TG_SCRIPT` constants, `tgCtlPath:` options — so a spawn the codemod missed fails CI); `test_parity_report_mode_enforces_baseline` (no `--gate`: a baseline file failing under py → exit 1; a non-baseline file failing under py → exit 0); `entry-helper.test.ts`: `entry('tg')` is `[<repo>/bin/tg]`; `hermetic-env.test.ts` gains: a child spawned with an explicit env `{PATH: '/usr/bin:/bin', HOME: tmp}` still receives `TG_BUN`, `TG_IMPL` and an exported `TG_IMPL_TG`.
- [ ] **Step 2: Run** `nice -n19 ionice -c3 uv run pytest tests/py/test_parity_script.py -q` and `nice -n19 ionice -c3 bun test tests/entry-helper.test.ts` — FAIL.
- [ ] **Step 3: Implement** `entry.ts`, `scripts/parity`, the manifests (every file the codemod touched lands in at least one of `tg.txt`, `call.txt`, `tg-ctl.txt`; the `tg-ctl` files whose daemon sends through `tg` — `ctl-alert-lifecycle-integration` and any usage-report test — are in `tg.txt` too; `tg-ctl-a.txt` is a subset of `tg-ctl.txt`), run the codemod, delete it, wire `hermetic-env.ts` and CI.
- [ ] **Step 4: Run** the two test files — PASS; three codemodded files alone under `ts` (one per component) — PASS; CI `test` job green (the TS suite unchanged through the shims) and `parity` job green with the report showing every file `ts: pass` and `py: fail` (nothing ported).
- [ ] **Step 5: Commit** `test: parity harness runs the black-box tests against both implementations (Refs #768)`; PR; CI green; ship.

### Task 5: One rig-managed deploy path

Three copies of tg-cli exist on this machine: `~/dev/tg-cli` (development), `~/xp/tg-cli` (stale), `~/.local/share/tg-cli` (what the unit runs). After this task exactly one runs anything, rig installs and supervises it, and the other two run nothing.

**Files:**
- rig-cli (own worktree and PR in `~/dev/rig-cli`): `riglib/plan.py` (`_build_tg_ctl`, ~3599-3703) and `riglib/drift.py` (`_check_tg_ctl`, ~3649-3803) — on Linux with a usable `systemctl --user`, plan `tg-ctl enable` and drift-check that `agenttools-tg-ctl-tg-ctl.service` is enabled and its `ExecStart` is `<tools.items.tg.repo>/bin/tg-ctl run`; on macOS the `ai.hyperide.tg-ctl` plist's `ProgramArguments` become `[<repo>/bin/tg-ctl, run]` with `EnvironmentVariables.TG_BUN` = the absolute bun (spec §5), and drift reports a plist missing either; the repo comes from `tools.items.tg.repo`, falling back to today's `tg_ctl.tg_ctl_path` resolution; tests next to the existing tg_ctl plan/drift tests
- tg-cli: `AGENTS.md` ("This checkout is the live binary" rewritten: the deploy checkout is `${XDG_DATA_HOME:-~/.local/share}/tg-cli`, installed by rig `tools.items.tg`; `~/dev/tg-cli` is for development and worktrees only; how to deploy, switch and roll back), `README.md` (install through rig or `install.sh`), `docs/ROADMAP.md` (port status line)
- Machine (recorded in the ticket, not committed): `~/.config/rig/config.yaml` gains `tools.items.tg: {repo: ~/.local/share/tg-cli}`

**Interfaces:**
- Consumes: `bin/*` and `install.sh` (Tasks 2-3), `tg-ctl enable` writing `ExecStart=<repo>/bin/tg-ctl run` (Task 3).
- Produces: rig action `provision_tg_ctl` on Linux; drift items `tg_ctl.unit_missing`, `tg_ctl.unit_disabled`, `tg_ctl.unit_wrong_execstart` (names follow rig's existing drift id style if it differs).

- [ ] **Step 1: Write the failing rig-cli tests:** Linux plan with `tools.items.tg.repo` set emits `provision_tg_ctl` running `<repo>/bin/tg-ctl enable`; drift reports a unit whose `ExecStart` is `bun …/tg-ctl run` and reports nothing for `<repo>/bin/tg-ctl run` + enabled; macOS plist rendering has `ProgramArguments` `[<repo>/bin/tg-ctl, run]`; a host with no `systemctl --user` plans nothing and reports nothing (today's behaviour).
- [ ] **Step 2: Run** each rig-cli test file alone under `nice -n19 ionice -c3` — FAIL.
- [ ] **Step 3: Implement**; rig-cli PR (its own ticket in rig-cli, linking tg-cli#768); CI green; merge per rig-cli conventions.
- [ ] **Step 4: On the machine:** add `tools.items.tg` to `~/.config/rig/config.yaml`; `rig apply`; then verify and record in the ticket: `readlink -f ~/.local/bin/tg` and `~/.local/bin/tg-ctl` end in `~/.local/share/tg-cli/bin/…`; `systemctl --user cat agenttools-tg-ctl-tg-ctl.service` shows `ExecStart=…/.local/share/tg-cli/bin/tg-ctl run`; `rig status` shows no tg/tg_ctl drift; a second `rig apply` changes nothing; `readlink -f "$(command -v tg)"` and `readlink -f "$(command -v tg-ctl)"` end in `~/.local/share/tg-cli/bin/`; no link, unit or cron entry names `~/xp/tg-cli`, `~/dev/tg-cli` or `~/.files/repos/tg-cli` (`grep -rl` over `~/.local/bin`, `~/.files/bin`, `~/.config/systemd/user`, `crontab -l`).
- [ ] **Step 5:** tg-cli docs commit `docs: one rig-managed deploy path for tg-cli (Refs #768)`; PR; CI green; ship. `~/xp/tg-cli` is listed in the ticket as a leftover for the owner to delete (nothing deletes a checkout outside a worktree automatically).

---

## Phase 1 — `tg` and `call-cli`

Each task below ends the same way, in addition to its own steps: run every black-box file it names under the `tg` py leg, one at a time (`nice -n19 ionice -c3 env TG_IMPL=ts TG_IMPL_TG=py TG_NO_TS_FALLBACK=1 bun test tests/<file>`; for `call-cli` files `TG_IMPL_CALL_CLI=py` too); add the files that pass to `tests/parity/tg.baseline` (or `call.baseline`); a named file that cannot pass because it needs a later task is reported with the missing piece instead (the controller rules where it goes). The task registers its handlers in `tgcli.entry.HANDLERS["tg"]` only for subcommands it ports completely, each reproducing its TS argv-shape guard: `DECLINE` only for the shapes the TS sends as a message, `fall_through` for subcommand shapes not ported yet (spec §2.2), with a test per shape.

### Task 6: Shared config primitives

**Files:**
- Create: `src/tgcli/config/env.py` (from `features/config/env.ts`), `src/tgcli/tg_ctl/lock.py` (path and pid helpers only: `ctlPaths`, `botIdFromToken`, `readPidFile`, `shouldAutoStart` from `features/tg-ctl/lock.ts`), `src/tgcli/tg_ctl/config.py` (`features/tg-ctl/config.ts`), `src/tgcli/auto_attach/feature_flags.py`, `src/tgcli/cli/text_escapes.py`, `src/tgcli/cli/send_output.py`, `src/tgcli/tg_ctl/text_util.py` (adds `format_age` next to Task 1's re-export), `src/tgcli/tg_ctl/guards.py`
- Test: ported pytest of `tests/ctl-lock.test.ts`, `tests/ctl-config.test.ts`, `tests/feature-flags.test.ts`, `tests/send-output.test.ts`, `tests/auth-env-file.test.ts` (env parsing part), plus the text-escapes and text-util cases found by the import grep

**Interfaces:**
- Produces: `load_env(config_dir: Path) -> dict[str, str]`; `parse_env_content(text: str) -> dict[str, str]`; `config_dir(env: Mapping[str, str], home: Path) -> Path` (`TG_CTL_CONFIG_DIR` else `~/.config/tg-cli`); `CtlPaths` (`TypedDict` with every key of TS `ctlPaths`) and `ctl_paths(config_dir: Path, bot_id: str) -> CtlPaths`; `bot_id_from_token(token: str) -> str`; `parse_control_config(text: str) -> ControlConfigRaw`; `resolve_control_config(raw, env) -> ControlConfig`; `apply_feature_flags`, `parse_feature_config`, `resolve_features`, `DEFAULT_FEATURES` (note the TS quirk kept as is: `tg` reads `config.yaml` from `$HOME/.config/tg-cli/`, ignoring `TG_CTL_CONFIG_DIR`, `tg:911`; tested); `decode_text_escapes(s: str) -> str`; `format_send_output(ids: list[int]) -> str` (`OK tg#1 tg#2`); `format_age`; `is_record`.

- [ ] **Step 1: Write the failing tests** (ported cases, Global Constraints rule) plus `test_ctl_paths_matches_ts_fixture` (every key and path for `bot_id="8574086668"` equals a fixture captured from TS `ctlPaths`).
- [ ] **Step 2: Run** `nice -n19 ionice -c3 uv run pytest tests/py/test_config_env.py tests/py/test_ctl_lock.py tests/py/test_ctl_config.py tests/py/test_feature_flags.py tests/py/test_send_output.py tests/py/test_text_util.py -q` — FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** — PASS; ruff, mypy clean.
- [ ] **Step 5: Commit** `feat(py): config, paths and feature flags (Refs #768)`; PR; CI green; ship.

### Task 7: Render layer

**Files:**
- Create: `src/tgcli/render/{html,tag,rich,table,format_help,help_color,prefix}.py`, `src/tgcli/prefix_style/style.py`, `src/tgcli/util/regex.py` (`escape_reg_exp`, port of `features/util/regex.ts`, also used by Task 16's `install_skill.py`)
- Test: ported pytest of `tests/render.test.ts`, `tests/html-auto-detect.test.ts`, `tests/html-sanitize.test.ts`, `tests/rich.test.ts`, `tests/table.test.ts`, `tests/tag.test.ts`, `tests/prefix-agent.test.ts`, `tests/prefix-style.test.ts`, and any other file the import grep finds for these modules

**Interfaces:**
- Consumes: `utf16_len`, `utf16_slice` (Task 1).
- Produces: `escape_html`, `detect_html_tags`, `convert_entities_to_html`, `parse_emoji_helpers`, `strip_html_tags`; `ESCALATION_TAGS`, `validate_tag`, `is_escalation_tag`; `validate_rich`, `RICH_LIMITS` (32768 chars, 500 blocks, 16 nesting, 50 media, 20 columns); `to_table_pre`, `detect_table_kind`, `pipe_table_to_html`; `format_help() -> str` (byte-identical to the TS text); `colorize_help`, `should_colorize`; `build_prefix(...) -> str` with the TS parameter set; `style_task_title`, `style_window_name`.

- [ ] **Step 1: Write the failing tests** (ported) plus `test_format_help_identical` (equals the TS `tg help format` stdout captured into a fixture).
- [ ] **Step 2: Run** the new pytest files — FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** — PASS.
- [ ] **Step 5: Commit** `feat(py): render layer (Refs #768)`; PR; CI green; ship.

### Task 8: Argv parser, help, version and the `tg` entry module

**Files:**
- Create: `src/tgcli/cli/args.py` (`features/cli/args.ts` without the escalation-format check, which moves to text-lint in Task 15), `src/tgcli/cli/report.py`, `src/tgcli/auto_attach/{denylist,snippet}.py`, `src/tgcli/cli/usage.py` (the `USAGE` text, `tg:169-487`, byte-identical), `src/tgcli/tg_main.py` (`main(argv: list[str], env: Mapping[str, str]) -> int`; this task wires help, version, `--format-help`, `tg help format` and `tg help report`; `tg help auth` and `tg help obligations` call `fall_through` until Tasks 16 and 15 port their usage text)
- Modify: `src/tgcli/entry.py` (register `help` and `DEFAULT` under `HANDLERS["tg"]`; the `DEFAULT` handler runs `parse_args`, serves the help/version/format-help actions and calls `fall_through` for everything else)
- Test: ported pytest of `tests/reply-table-args.test.ts` and every args/report/denylist/snippet test found by the import grep; `tests/py/test_args_edge_cases.py` (Review Focus 5)
- Black-box: `tests/cli-subprocess.test.ts`

**Interfaces:**
- Consumes: Tasks 6-7.
- Produces: `ParseResult` (frozen dataclass mirroring the TS `ParseResult` fields in snake_case, `escalation_warning` removed); `parse_args(args: list[str], cwd: Path, home: Path, opts: ParseOptions) -> ParseResult | ParseError`; `build_report_send(args: list[str]) -> list[str] | ParseError`; `is_never_attach(path: str) -> bool`; `parse_snippet_spec(path: str) -> SnippetSpec | None`; `USAGE: str`.

- [ ] **Step 1: Write the failing tests:** ported cases; `test_args_edge_cases` — an argv byte string that is invalid UTF-8 decodes to U+FFFD as in Bun, body `-x` after `--`, `"a\\nb"` escapes, empty body with `--file`, Cyrillic+emoji `--title`, 100 KB body — each `parse_args` result equal to the TS result captured as JSON fixtures (`tests/py/fixtures/args/*.json`, generated by a throwaway Bun script that is not committed); `test_usage_identical` (fixture from `bun tg --help`); `test_version_output_identical` (`tg --version` = TS `versionOutput`: `tg <version> (<git short hash>)` plus the latest CHANGELOG section, fixture from the TS run on the same checkout).
- [ ] **Step 2: Run** the new pytest files — FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** — PASS; black-box `tests/cli-subprocess.test.ts` under `py` (the cases that need credentials or sending fail with exit 70 until Task 10; report which pass).
- [ ] **Step 5: Commit** `feat(py): tg argv parser, usage and help (Refs #768)`; PR; CI green; ship.

### Task 9: Transport, send retry, outbox and message splitting

**Files:**
- Create: `src/tgcli/transport/{send_retry,telegram,outbox}.py`, `src/tgcli/transport/bot_api.py` (request builder shared by sync and async clients: method, JSON or multipart fields in TS order, per-attempt timeout), `src/tgcli/auto_attach/{types,split}.py`
- Test: ported pytest of `tests/send-retry.test.ts`, `tests/send-outbox.test.ts`, `tests/transport-topic.test.ts`, `tests/transport-rich.test.ts`, the split tests found by the import grep; `tests/py/test_split_utf16.py` (Review Focus 1); `tests/py/test_outbox_ts_roundtrip.py` (Review Focus 2: an outbox entry written by the TS writer is read by Python and the reverse, fixtures captured from TS)

**Interfaces:**
- Consumes: `js_stringify`, `atomic_write`, `utf16_*` (Task 1).
- Produces: `SendRetryPolicy` and `send_retry_policy_from_env(env) -> SendRetryPolicy` (budget `TG_SEND_RETRY_BUDGET_MS`, default 60000; transient = transport error or HTTP 429/500/502/503/504); `post_with_retry(client: httpx.Client, request: BotRequest, policy, sleep, now) -> BotResponse` and `async post_with_retry_async(client: httpx.AsyncClient, request: BotRequest, policy, sleep: Callable[[float], Awaitable[None]], now) -> BotResponse` (same request builder, same transient rules; the daemon uses it in Phase 2); `BotRequest` (frozen dataclass: `method`, `fields: tuple[tuple[str, FieldValue], ...]`, `files: tuple[UploadPart, ...]`, `timeout_s` — ONE wall-clock deadline per attempt covering connect, upload and the response headers, as the TS `AbortSignal.timeout` on `fetch` (enforced around the call, e.g. `anyio.fail_after` up to the headers, not httpx's per-operation timeouts that reset on every chunk); attempts after the first use `min(timeout_s, budget left)` as `send-retry.ts:112`; once headers with a non-transient status arrive the attempt is done (`send-retry.ts:118`), and a failure or timeout reading that body is a plain error, never retried or queued (`checkResponse` → `resp.json()`, `telegram.ts:158`, rethrown at `:336` as not `TelegramUnavailable`); tests `test_attempt_deadline_trickling_headers` (a fake server that trickles the upload/headers past the deadline → transient failure at the deadline), `test_slow_200_body_not_retried` (headers `200` in time, body past the deadline → one request, exit 1, no outbox entry) and `test_later_attempt_timeout_capped_by_budget`); `TelegramTransport` with the five primitives of the TS `Transport` (`features/auto-attach/transmitter.ts:34-53`, implemented in `features/transport/telegram.ts`): `send_message`, `send_rich`, `send_photo`, `send_document`, `send_media_group(kind, items, caption, fmt)` (2-10 same-kind items as one album, `attach://` multipart binding, caption on the first item, `features/transport/telegram.ts:463-485`), plus the advisory-thread fallback and queue switch; `write_outbox_entry(paths: CtlPaths, entry: OutboxEntry, files: list[Path]) -> Path`; `MESSAGE_LIMIT = 4096`; `split_message(text: str, limit: int = MESSAGE_LIMIT, fmt: Literal["plain", "html"] = "html") -> list[str]` (UTF-16 units; cut points by the `safeCut` port, not `utf16_slice`; `plain` skips tag balancing (`openTagsAt` only when `htmlAware`, `features/auto-attach/split.ts:81,132`) but `safeCut` still backs a cut up to the last `<` in every format, `split.ts:64-75`, despite the `:76-78` comment; `safeCut` backs up only when `insideTag` holds, i.e. some `>` follows the last `<` before the cut, `split.ts:51-56`; tests `test_split_plain_backs_up_to_lt` (`a<b` before the 4096 cut and a `>` anywhere after it → cut at the `<`) and `test_split_plain_no_gt_no_backup` (same text without any later `>` → hard cut at 4096)).

- [ ] **Step 1: Write the failing tests:** ported cases; `test_split_counts_utf16_units`; `test_outbox_ts_roundtrip`; `test_bot_request_multipart_order` (a `sendDocument` with caption, thread id and reply-to builds the same part names in the same order as the TS, fixture from a fake-API capture); `test_media_group_multipart` (a 3-photo `sendMediaGroup` with a caption: the `media` JSON and the `attach://` parts match the TS capture).
- [ ] **Step 2: Run** the new pytest files — FAIL.
- [ ] **Step 3: Implement** on `httpx`.
- [ ] **Step 4: Run** — PASS.
- [ ] **Step 5: Commit** `feat(py): Bot API transport, retry, outbox and splitting (Refs #768)`; PR; CI green; ship.

### Task 10: Plain and HTML send end to end, history and routes

**Files:**
- Create: `src/tgcli/replies/{history,history_file,outbound}.py`, `src/tgcli/tg_ctl/routes.py`, `src/tgcli/tg_ctl/reactions.py`, `src/tgcli/send/pipeline.py` (the send pipeline of spec §6.1 for text-only sends, outside tmux, with no session: env → parse (parse error exit 1) → credential gate (exit 78 unless `--dry-run`) → `--dry-run` → prefix → split → transmit → outbox on budget exhaustion → reaction, history, routes; Task 15 inserts the text-lint check before the credential gate as spec §6.1 orders it)
- Modify: `src/tgcli/tg_main.py` (the `DEFAULT` handler now runs the send pipeline; it calls `fall_through` when the argv or environment uses anything a later task owns: `--photo`, `--file`, `--table`, `--session`, `--topic`, `--subagent`/`--agent`, `--reply-to` with a history lookup, `$TMUX`/`TMUX_PANE`, `TG_SESSION`, `TG_TOPIC`, `TG_AGENT`/`RIG_AGENT_ID`/`RIG_DETACHED_AGENT`/`RIG_SESSION`, an agent in the process ancestry, active hooks, autolink candidates, and every text gate the TS applies to a send until Task 15 ports them (DICT words, CJK/mixed-script text, the `--tag decision` format check: the pipeline falls through whenever the TS gate would inspect the text) — listed in `tgcli/send/pipeline.py` `NOT_PORTED_FLAGS` and shrunk by each later task)
- Test: ported pytest of `tests/replies-history.test.ts`, `tests/replies-history-file.test.ts`, `tests/ctl-routes.test.ts` (the parts for the functions above); `tests/py/test_routes_lock_interop.py` and `tests/py/test_history_lock_interop.py` (Review Focus 3); `tests/py/test_history_ts_roundtrip.py` (Review Focus 2)
- Black-box: `tests/send-output.test.ts`, `tests/cli-send-outbox.test.ts`, `tests/cli-config-dir-send.test.ts`, `tests/cli-agent-send.test.ts`, `tests/cli-subprocess.test.ts`

**Interfaces:**
- Consumes: Tasks 6-9.
- Produces: `parse_history(blob: str) -> list[HistoryRecord]`; `thread_of_message_in_blob(blob: str, message_id: int) -> int | None`; `append_history_file(paths: CtlPaths, records: list[HistoryRecord]) -> bool` (as `features/replies/history-file.ts:24`, its own lock budget `LOCK_ATTEMPTS = 100` × `LOCK_DELAY_MS = 10`, `features/replies/history-file.ts:20-21`); every caller passes the TS caller's `attempts`/`on_contended` (e.g. obligations dismiss: `attempts=200`, `on_contended="skip"`); `build_outbound_history_records(...)`; `append_route(...)`, `with_routes_lock(lock_path: Path, body: Callable[[], T], *, attempts: int = 50, delay_ms: int = 10, on_contended: Literal["run-unlocked", "skip"] = "run-unlocked") -> T | None` (the port of the generic `withRoutesLock(io, body, opts)`, `routes.ts:160`: any lock path — routes, `history.lock`, obligations, registration, hooks audit — the TS lock-file protocol and stale rule, `None` when skipped); `done_reaction_for_send(...)`; `run_send(parsed: ParseResult, env: Mapping[str, str], deps: SendDeps) -> int`.

- [ ] **Step 1: Write the failing tests:** ported cases; `test_routes_lock_interop`; `test_history_lock_interop` (the TS daemon's `<history>.lock` protocol: a Python `append_history_file` waits on a TS-format lock, honours the same orphan-lock age, and a concurrent TS append and Python append both survive the 5000-line trim); `test_ts_fixtures_roundtrip` (routes.json and history.jsonl produced by the TS `tg` against a fake API, parsed and re-serialized byte-identical).
- [ ] **Step 2: Run** the new pytest files — FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** — PASS; the named black-box files under `py`.
- [ ] **Step 5: Commit** `feat(py): tg text send end to end with history and routes (Refs #768)`; PR; CI green; ship.

### Task 11: Sender identity, sessions and topics

**Files:**
- Create: `src/tgcli/branding/{detect,emoji}.py`, `src/tgcli/agent_role/role.py`, `src/tgcli/tg_ctl/{session_name,session_registry,session_registry_store,session_topics,session_target,omp,host_registry,host_registry_fs,unreachable,discover,question_inbox,agent_name}.py` (only the functions `tg` imports today; the rest of each module comes with tg-ctl), `src/tgcli/cli/session_topic.py` (`askDaemon`, `parseResolvedSession`, `tmuxServerPidFromEnv`)
- Modify: `src/tgcli/send/pipeline.py` (header identity, `--detect-agent`, `--detect-model`, `--ls-emoji-helpers`, `--session-topic`, `--session-id`, `--session`/`TG_SESSION`, `--topic`/`TG_TOPIC`, `--reply-to` thread lookup, the omp worker-broker cut, daemon resolve-session and topic-result)
- Test: ported pytest of `tests/session-name.test.ts`, `tests/session-registry-store.test.ts`, `tests/session-target.test.ts`, `tests/session-topics.test.ts`, the branding/agent-role/omp/discover cases found by the import grep
- Black-box: `tests/cli-sender-attribution.test.ts`, `tests/cli-host-session.test.ts`, `tests/cli-omp-route-notmux.test.ts`, `tests/cli-reply-topic.test.ts`, `tests/cli-session-topic.test.ts`, `tests/cli-topic-send.test.ts`, `tests/tg-omp-session-title-integration.test.ts`, `tests/session-topic-integration.test.ts`, `tests/topic-delivery-integration.test.ts`

**Interfaces:**
- Consumes: Tasks 6-10.
- Produces: `sender_role(subagent: str | None, env) -> SenderRole`; `ProcSource = Callable[[], str]` (default runs `ps -axo pid=,ppid=,command=` on every OS, as the TS does, so the suite's `ps` fakes apply); `detect_sender_ancestry(proc_source: ProcSource, pid: int) -> AgentAncestor | None`; `resolve_session_name(...) -> SessionName`; `ask_daemon(paths: CtlPaths, request: dict[str, object], expect_reply: bool, timeout_s: float = 2.0) -> dict[str, object] | None`; the session-registry read functions with the TS names in snake_case.

- [ ] **Step 1: Write the failing tests** (ported cases).
- [ ] **Step 2: Run** — FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** — PASS; named black-box files under `py`.
- [ ] **Step 5: Commit** `feat(py): sender identity, sessions and topics (Refs #768)`; PR; CI green; ship.

### Task 12: Attachments, tables and PDF

**Files:**
- Create: `src/tgcli/auto_attach/{encoding,file_check,line_spec,extract,normalize,transmitter}.py`, `src/tgcli/cli/{screenshot_guard,file_mention_gate}.py`, `src/tgcli/md_pdf/convert.py`, `src/tgcli/code_pdf/convert.py`
- Modify: `src/tgcli/send/pipeline.py` (`--photo`, `--file`, `--with-original`, `--no-pdf`, `--pdf-device`, `--table`, photo→text→document order, flood cap)
- Test: ported pytest of `tests/line-spec.test.ts`, `tests/html-pdf.test.ts`, and the attachment/PDF/guard cases found by the import grep
- Black-box: `tests/cli-attachment-flood-integration.test.ts`, `tests/cli-no-text-attach-integration.test.ts`, `tests/screenshot-guard-cli.test.ts`, `tests/file-mention-gate-cli.test.ts`, `tests/md-pdf-integration.test.ts`

**Interfaces:**
- Consumes: Tasks 6-11.
- Produces: `build_send_plan(...) -> SendPlan`; `transmit(plan, transport) -> TransmitResult`; `maybe_add_bom(data: bytes) -> bytes`; `check_attachment_file(path) -> AttachmentCheck`; `plan_line_specs(...)`; `mentions_screenshot(text) -> bool`; `unattached_file_mentions(text, cwd, attached) -> list[str]`; `convert_markdown_to_pdf(path, deps) -> Path | None`; `convert_code_to_pdf(path, deps, preset) -> Path | None` (the theme stays inside, from `TG_PDF_THEME`, as in `convert.ts:394`).

- [ ] **Step 1: Write the failing tests** (ported cases).
- [ ] **Step 2: Run** — FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** — PASS; named black-box files under `py`.
- [ ] **Step 5: Commit** `feat(py): attachments, tables and PDF rendering (Refs #768)`; PR; CI green; ship.

### Task 13: Pre-send hooks on agenttools_registry

**Files:**
- Modify: `pyproject.toml` (dependency `agenttools-registry`, uv git source `https://git.hyperide.ai/ultrabricks/agent-tools.git`, `subdirectory = "lib/agenttools_registry"`, pinned `rev`), `uv.lock`, `src/tgcli/send/pipeline.py`, `src/tgcli/entry.py` (register `hooks`)
- Create: `src/tgcli/hooks/{runner,run_photo_hooks,run_text_hooks,cli}.py` (trust state and invocation digest from `agenttools_registry`; `features/hooks/types.ts` has no Python twin)
- Test: ported pytest of `tests/hooks-audit-lock.test.ts` and the hooks cases found by the import grep; `test_trust_strings_from_registry` (a descriptor trusted by the TS runner is trusted by the Python runner: same `invocation_digest`)
- Black-box: `tests/hooks-cli.test.ts`

**Interfaces:**
- Consumes: `agenttools_registry.trust_state`, `invocation_digest`, `Entry`, `TrustState`.
- Produces: `gate_photos(...) -> HookGateResult`, `gate_text(...) -> HookGateResult` (exit 10 on a block), `hooks_active(env, features) -> bool`, `run_hooks_cli(argv) -> int`.

- [ ] **Step 1: Write the failing tests.**
- [ ] **Step 2: Run** — FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** — PASS; `tests/hooks-cli.test.ts` under `py`.
- [ ] **Step 5: Commit** `feat(py): pre-send hooks on agenttools_registry (Refs #768)`; PR; CI green; ship.

### Task 14: Autolinks, reactions, `tg replies`

**Files:**
- Create: `src/tgcli/autolink_tasks/{detect,linear,cache,render,state}.py`, `src/tgcli/autolink_prs/{detect,resolve,cache,render}.py`, `src/tgcli/autolink_msgrefs/{detect,render,preview}.py`, `src/tgcli/autolink_refs/*.py` (as the TS `features/autolink-refs`), `src/tgcli/replies/{inbound,select,args,cli,window}.py`
- Modify: `src/tgcli/send/pipeline.py`, `src/tgcli/entry.py` (register `replies`; `user list|find` alias)
- Test: ported pytest of the autolink and replies test files found by the import grep
- Black-box: `tests/cli-answer-reaction.test.ts` and every autolink/replies black-box file in `tests/parity/tg.txt`

**Interfaces:**
- Produces: `detect_ticket_codes_expanded`, `probe_tickets`, `apply_autolink`, `linkify_tickets_compound`; `detect_refs_expanded`, `probe_repo`, `probe_refs_in_repo`, `linkify_refs_compound`; `detect_msg_refs`, `linkify_msg_refs`, `resolve_msg_refs`, `msg_ref_url`; `inbound_history_records`; `run_replies(argv, deps) -> int`.

- [ ] **Step 1: Write the failing tests.**
- [ ] **Step 2: Run** — FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** — PASS; named black-box files under `py`.
- [ ] **Step 5: Commit** `feat(py): autolinks, reactions and tg replies (Refs #768)`; PR; CI green; ship.

### Task 15: Text checks through text-lint, obligations

Precondition: text-lint v0.4.0 released (text-lint plan task 5: sender scope from `meta`, the automated-send Laya-unreachable report; task 9: public `text_lint.check` API, profiles `tg-bot`, `as-user`, `spoken`). If it is not released when Tasks 6-14 and 16 are done, Task 16 runs first and this task waits; the controller records the wait in the ledger.

**Files:**
- Modify: `pyproject.toml` (dependency `hyper-text-lint`, uv git source `https://git.hyperide.ai/ultrabricks/text-lint.git`, pinned `rev` of the release), `uv.lock`, `src/tgcli/send/pipeline.py` (spec §6.1 position: one check before the credential gate, `Format.Decision` blocks before exit 78, other blocks after it; spec §7 verdict mapping), `src/tgcli/entry.py` (register `obligations`, `report`), `tests/parity/tg.txt` (`py-skip` on the black-box files `dict-gate-cli`, `cjk-guard-cli`, `mixed-script-guard-cli`, `intent-gate-cli`, each naming its replacement test below; the white-box `escalation-gate-args` and `message-structure` tests never pass through the facade and stay until Phase 3)
- Create: `src/tgcli/text_check.py`, `src/tgcli/cli/obligations.py`, `tests/helpers/fake-laya.ts` (a Unix-socket fake answering text-lint's Laya `predict` requests, wire shape in spec §7), `tests/py/fake_laya.py` (the same for pytest)
- Modify (test infrastructure): `tests/hermetic-env.ts` (start the fake once per run, set `TEXT_LINT_LAYA_SOCKET` for every child, drop `TG_LAYA=0` once no gate reads it), `tests/py/conftest.py` (same for pytest)
- Test: `tests/py/test_text_check.py`, `tests/py/test_text_check_cli.py`, ported pytest of `tests/obligations.test.ts`
- Black-box: `tests/dry-run.test.ts`

**Interfaces:**
- Consumes: `text_lint.check(text | InputDocument, *, profile, lang, enforce, laya_mode, dict_path) -> dict` (report@1), `text_lint.TextLintError` (exit-2 cases: configuration, Laya unreachable), input@1 field names.
- Produces: `Profile = Literal["tg-bot", "as-user", "spoken"]`; `TextCheckInput` (frozen dataclass: `title`, `subagent`, `harness_title`, `body`, `table_rows`, `captions`, `markup: Literal["html","plain"]`, `agent_authored: bool`, `automated: bool`, `tag: str | None`, `send_format`, `attachments`, `table` — passed as input@1 `meta`; the `tg-bot` profile applies the sender scope, tg does not filter findings); `check_send_text(inp: TextCheckInput, profile: Profile, env: Mapping[str, str], ignore: tuple[str, ...] = ()) -> TextCheckOutcome` (`TextCheckOutcome` = `Blocked(findings)` | `Warned(findings)` | `Passed(intent)` | `ConfigError(message, path)`); `format_findings(findings) -> str`; obligations `record_obligations(paths, intent, message_ids)` (appends under `with_routes_lock` on the obligations lock, as `tg` does), `settle_obligations(paths, reply_to)`, `run_obligations_cli(argv) -> int`.

- [ ] **Step 1: Write the failing tests:** `test_dict_word_blocks_with_rule_id` (fixture DICT via `TG_DICT_PATH`, `--dry-run` included → exit 1, stderr names `Dict.<id>`); `test_escalation_enforce_off_warns` (`ESCALATION_GATE_ENFORCE=0` → `Format.*` finding printed, exit 0); `test_no_feature_cjk_guard_ignores_script_rules` (a body whose only finding is `Script.StrayCjk` is SENT, exit 0, under `--no-feature cjk-guard` — passed to text-lint when its `check` accepts an ignore list, else filtered in `check_send_text` with the verdict recomputed from the remaining findings); `test_malformed_dict_refuses_naming_file` (`TextLintError` → exit 1 naming the file); `test_profile_chosen_in_code` (a bot send calls `text_lint.check` with `profile="tg-bot"`; there is no flag that changes it; `TG_LAYA=0` changes nothing); `test_meta_carries_sender_scope` (agent ancestor/env marker → `agent_authored=True`; `--automated` → `automated=True`; tag, format, attachments and table passed through); `test_laya_unreachable_authored_refuses` (`TextLintError` → exit 1 with text-lint's message, nothing sent); `test_laya_unreachable_automated_sends` (`--automated`, report with `engines.laya.status == "unreachable"` → warning on stderr, message sent); `test_daemon_sends_pass_automated` (alert and usage-report argv built by tg carry `--automated`); `test_obligations_ts_roundtrip` (an `intent-obligations.jsonl` written by the TS is read and re-serialized byte-identical by Python and the reverse); `test_callers_pass_automated` (records, for tg-ctl's own sends, that `--automated` is in the argv; the external callers are checked by hand and ticketed per spec §7); `test_hermetic_fake_laya` (a black-box `tg` child sees `TEXT_LINT_LAYA_SOCKET` pointing at the fake, never the host's socket); `test_table_rows_checked` (`--table` rows on stdin carrying a DICT word → exit 1 after the credential gate); `test_table_no_creds_exit_78` (`printf '' | tg --table x` without credentials → 78, stdin not read before the gate); `test_decision_format_before_creds` (`--tag decision` malformed body without credentials → exit 1, the format findings, no 78); `test_laya_socket_forwarded` (`TG_LAYA_SOCKET=/x` reaches text-lint as `TEXT_LINT_LAYA_SOCKET=/x`); `test_missing_default_dict_passes`; `test_harness_title_dropped_on_finding` (title from the harness carries a DICT word, body clean → sent, harness title dropped, as today's CJK rule); `test_ci_laya_mode_only_with_ci_env`; `test_followup_intent_records_obligation`; ported obligations cases.
- [ ] **Step 2: Run** — FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** — PASS; `tests/dry-run.test.ts` under `py`.
- [ ] **Step 5: Commit** `feat(py): send text checks through text-lint, obligations (Refs #768, Refs #764)`; PR; CI green; ship.

### Task 16: Bot auth, install-skill, voice setup and daemon autostart

**Files:**
- Modify: `pyproject.toml` (dependency `agenttools-log` from `lib/` for `advertise`, uv git source, pinned `rev`), `uv.lock`, `src/tgcli/entry.py` (register `auth` for `login|status|logout`, `install-skill`, `voice`), `src/tgcli/send/pipeline.py` (after a successful send inside tmux with a detected agent and `control.enabled`: spawn `bin/tg-ctl start --pane … --cwd …` detached, as `tg` does today)
- Create: `src/tgcli/auth/{args,cli,binding,env_file,status}.py`, `src/tgcli/install_skill.py` (calls `advertise.install_skill`; the `# agent-tools-awareness` SessionStart hook and the Claude Code/Codex wiring of `features/install-skill/install.ts` that `advertise` does not cover are added to `advertise` in an agent-tools PR first)
- Test: ported pytest of `tests/auth-env-file.test.ts`, `tests/install-skill.test.ts`, `tests/install-origin.test.ts` and the auth cases found by the import grep
- Black-box: `tests/auth-integration.test.ts`

**Interfaces:**
- Produces: `parse_auth_args(argv) -> AuthArgs | ParseError | None` (`None` = not an auth command → `DECLINE`, as `features/auth/args.ts:9-11`); `run_auth(args, deps) -> int` (bot login prints the Start link and waits like the TS, 130 on SIGINT); `merge_env_content(old: str, updates: Mapping[str, str]) -> str`; `run_install_skill(env) -> int`; `run_voice_setup_passthrough(argv) -> int` (spawns `bin/tg-ctl voice-setup`, 1 h timeout).

- [ ] **Step 1: Write the failing tests.**
- [ ] **Step 2: Run** — FAIL.
- [ ] **Step 3: Implement** (agent-tools PR merged first when `advertise` needs the extra wiring; pin its commit).
- [ ] **Step 4: Run** — PASS; `tests/auth-integration.test.ts` under `py`.
- [ ] **Step 5: Commit** `feat(py): bot auth, install-skill via advertise, voice setup and autostart (Refs #768)`; PR; CI green; ship.

### Task 17: User account, calls, `call-cli`

Precondition: tg-cli#761 merged, or its open TypeScript changes to `features/user-account/` ported in this task.

**Files:**
- Create: `src/tgcli/user_account/{args,cli,sidecar,sidecar_fs,help,messages}.py`
- Modify: `tests/telegram-duplex.test.py` (the three new tests below)
- Modify: `src/tgcli/entry.py` (register `auth user|caller`, `call`, `user send`; `HANDLERS["call-cli"][DEFAULT]`), `features/telegram_client/conversation.py` (text-lint plan task 13 design: inside `Conversation.respond()` the reply is checked with `asyncio.create_subprocess_exec(<resolved text-lint binary>, "check", "--profile", "spoken", "--input-json", "-", "--format", "json")` under `asyncio.wait_for(..., timeout=2)` before `tts.synthesize`; findings are logged and the reply is still spoken; a missing binary, a timeout or exit 2 logs and continues; on timeout or cancellation the process is killed and awaited — the sidecar venv does not get text-lint; the binary is `TG_TEXT_LINT_BIN`, which `tg` sets to `<repo>/.venv/bin/text-lint` in the sidecar's environment, else `text-lint` on PATH)
- Test: ported pytest of `tests/user-account.test.ts`, `tests/user-call-ledger.test.ts` (non-subprocess parts); `test_call_say_dict_word_refused_before_sidecar` (fake sidecar never spawned), `test_call_say_bot_formatting_refused` (`AsUser.BotFormatting`), `test_user_send_profile_as_user`; in `tests/telegram-duplex.test.py`: `test_duplex_reply_findings_logged_still_spoken`, `test_duplex_missing_text_lint_continues`, `test_duplex_uses_tg_text_lint_bin` (no `text-lint` on PATH, `TG_TEXT_LINT_BIN` set → that binary runs); in the user-account tests: `test_sidecar_env_carries_text_lint_bin`
- Black-box: `tests/auth-user-account-integration.test.ts`, `tests/user-account.test.ts`, `tests/user-call-ledger.test.ts`, `tests/user-call-audit-warning.test.ts`

**Interfaces:**
- Consumes: `check_send_text` with `as-user` and `spoken` (Task 15).
- Produces: `parse_user_account_args(argv) -> UserAccountArgs | ParseError | None` (`None` → `DECLINE`); `build_sidecar_argv(args, paths) -> list[str]`; `ensure_sidecar_runtime(env, cache_dir) -> Path` (hashed venv `mtproto-runtime-<lock sha>`, `uv pip install --require-hashes -r requirements-call.txt`; `TG_MTPROTO_SIDECAR` overrides); `run_user_account(args, deps) -> int` (exit 3 when not logged in without starting Python).

- [ ] **Step 1: Write the failing tests.**
- [ ] **Step 2: Run** — FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** — PASS; named black-box files under `py`.
- [ ] **Step 5: Commit** `feat(py): user account, calls and call-cli (Refs #768)`; PR; CI green; ship.

### Task 18: `tg` parity gate and cutover

**Files:**
- Modify: `tests/parity/gated.txt` (add `tg`, `call`), `tests/parity/{tg,call}.baseline` (every non-skip file), `src/tgcli/send/pipeline.py` (`NOT_PORTED_FLAGS` empty and deleted), `src/tgcli/entry.py` (every `tg` subcommand registered), `package.json` and `pyproject.toml` (minor bump), `CHANGELOG.md`, `AGENTS.md` (architecture section: Python `tg`, how to roll back), `README.md`, `docs/ROADMAP.md` (port status)
- Test: `tests/py/test_startup_latency.py` (marker `slow`, not in CI: `bin/tg --dry-run "x"` under `py` within 150 ms of `ts`, median of 5, on the workstation)

- [ ] **Step 0 (precondition, spec §7):** every known program caller of `tg` (tg-ctl's own sends, rig sysmon, agenttools_stall_watchdog, task-cli notifications) passes `--automated` in its deployed version — verified by reading each caller's argv, tickets from Task 15 closed. Until then this task waits and the ledger says so.
- [ ] **Step 1:** CI `parity` job runs `scripts/parity tg --gate` and `scripts/parity call --gate` — expect PASS with every non-skip file `py: pass`. A failure goes back to the owning task's area as a fix PR before this task continues.
- [ ] **Step 2:** Run `tests/py/test_startup_latency.py` on the workstation — PASS (otherwise make the slow imports lazy and re-run).
- [ ] **Step 3:** Commit `feat: tg and call-cli run on Python (Refs #768)`; PR; CI green; ship.
- [ ] **Step 4:** Deploy on the machine: `scripts/deploy.sh` (or `rig apply`); `tg-impl use py tg && tg-impl use py call-cli`; `tg-impl status`.
- [ ] **Step 5:** Live proof (spec §9): `tg --dry-run "проверка"` exit 0; one real `tg` send returns `OK tg#<id>`; a send with a DICT word is refused with the rule id; `tg-ctl alert send` (TS daemon side) posts through `bin/tg` (Python). Record the outputs in the ticket. Rollback drill: `tg-impl use ts tg`, one `--dry-run`, `tg-impl use py tg`.
- [ ] **Step 6:** `tg report` to the owner (Russian): `tg` cut over, rollback command, what is next.

---

## Phase 2 outline — `tg-ctl` (own plan, written after Task 18)

Stage A (facade owns the client subcommands; `DAEMON_TOKENS` keep falling through to the TS daemon while the `tg-ctl-daemon` selection is `ts`; the stage B flip is `tg-impl use py tg-ctl-daemon`, spec §8):

1. agent-tools PR: `pyproject.toml` for `agenttools_hatch_escalation` (`agenttools-hatch-escalation`), public `APPROVED_GRANT_RE`, `request_id(hook_id)` helper; any `agenttools_service` gap (external launchd supervisor, `impl` in status) added to the lib.
2. `status`, `stop`, `enable`, `disable` on `agenttools_service` (deletes `autostart.ts`), lock probes (`/proc/locks`, `lsof -t`), `impl:` line.
3. `install-hooks` (hook-install, Codex hook, rig delegation via `agenttools_rig_delegate`, which reads rig's `agent_tools_source` and drops the `rig-delegate.ts:31` candidate list).
4. `voice-setup` (voice config, whisper probe).
5. `harness-event`, `codex-usage-hook` (limits, overload-retry store).
6. `audit-delivery`, `inbox` (delivery ledger, `agenttools_tg_inbox`).
7. `usage-schedule` enable/disable/check.
8. omp-live client in Python (`tgcli/tg_ctl/omp_live.py`, spec §6.4) and `omp-live install|status|send`.
9. `alert …` (alert-subscriptions incl. the exclusive holder).
10. `ask` (all forms) and `withdraw` clients, signal withdraw.
11. Stage A gate (`tg-ctl-a` manifest), deploy, `tg-impl use py tg-ctl`, rollback drill (py → ts → py), live proofs of spec §9 stage A.

Stage B (the daemon):

12. Socket server, questions, grants, question store and Inbox topic (hatch constants from the agent-tools lib).
13. getUpdates loop, flat-chat routing, tmux inject (`agenttools_tmux_inject`), abduco PTY, omp-live delivery, exactly-once ledger, outbox replay, startup reports.
14. Topics, session registry, topic rename, `/new`, `/agent`, `/tasks` (`agenttools_gantt`), `/spend`.
15. Voice transcription, auto-continue, awareness nudges, schedules, deferred delivery.
16. Full `tg-ctl` gate, deploy, `tg-impl use py tg-ctl`, live proofs of spec §9 stage B, owner report; Phase 3 ticket with a due date seven days out.

## Phase 3 outline — TypeScript removal (own plan, day 7)

One PR: first port the developer scripts that import TS features (`scripts/create-ai-emoji-set.ts`, `scripts/create-tag-emoji.ts`, `scripts/sync-tag-pill-alts.ts`, `scripts/e2e-telegram.ts` with `features/e2e-telegram/`) to Python scripts on `tgcli`; then delete `tg`, `tg-ctl`, `call-cli` TS entrypoints, `features/**/*.ts`, `tools/omp-live-cli.mjs` (replaced in Phase 2 item 8), `scripts/*.ts`, the TS tests whose subjects are gone (black-box tests either ported to pytest against `bin/*` or kept as Bun tests only if Bun stays for omp-live tests), `package.json`, `bunfig.toml`, the facade fall-through, the `ts` branches of the shims and `tg-impl`; move `features/telegram_client` to `src/`; version into `pyproject.toml`; CI without the Bun TS suite (the omp-live `.test.mjs` files keep a small Bun or Node job); `install.sh` without the bun requirement; docs. Owner report.
