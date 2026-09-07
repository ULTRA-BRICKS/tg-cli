import { afterEach, beforeEach, expect, test } from 'bun:test';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { runPreSendPhotoHooks, toolHooksDir } from '../features/hooks/run-photo-hooks';

// HYP-1120 (narrowed scope, Alex tg#10233 "Option C"): pre_send_photo.py's hard
// block on an unstyled/broken/blank render stays the DEFAULT — this file proves
// the one ADDED bypass: a live, per-send Telegram hatch approval
// (RIG_HATCH_REQUEST_PRE_SEND_PHOTO="<justification>") that the hook itself
// requests via agent-tools' `agenttools_hatch_escalation` helper.
//
// `agenttools_hatch_escalation` is stubbed here with a FAKE module on PYTHONPATH
// that mirrors the real module's contract (HatchApprovalResult.should_stop keyed
// to env_present, request_hatch_approval reading RIG_HATCH_REQUEST_<HOOK_ID> from
// the passed env) — this is a test double for the Telegram round trip only
// (`tg-ctl ask` is not invoked in a test), NOT a mock of pre_send_photo.py's own
// logic: decide_from_review_result / _consume_live_hatch_approval, the code this
// suite actually exercises, run for real, end-to-end through the real Python
// executable — same pattern as tests/hooks-review-descriptor.test.ts.

const REPO = join(import.meta.dir, '..');
const PY_HOOK = join(REPO, 'features', 'hooks', 'review-descriptor', 'pre_send_photo.py');

let home: string;
let binDir: string;
let pyLibDir: string;
let pngPath: string;
let savedPath: string | undefined;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'tg-hatch-hook-'));
  binDir = join(home, 'bin');
  mkdirSync(binDir, { recursive: true });
  pngPath = join(home, 'shot.png');
  writeFileSync(pngPath, 'PNGDATA');
  savedPath = process.env.PATH;
  process.env.PATH = `${binDir}:${savedPath}`;

  // Fake `agenttools_hatch_escalation` module, importable via PYTHONPATH.
  pyLibDir = join(home, 'pylib');
  const modDir = join(pyLibDir, 'agenttools_hatch_escalation');
  mkdirSync(modDir, { recursive: true });
  writeFileSync(
    join(modDir, '__init__.py'),
    `
class HatchApprovalResult:
    def __init__(self, requested, approved, reason, env_var, env_present=False):
        self.requested = requested
        self.approved = approved
        self.reason = reason
        self.env_var = env_var
        self.env_present = env_present

    @property
    def should_stop(self):
        return self.env_present


def hatch_env_var(hook_id):
    canonical = hook_id.strip().upper().replace("-", "_")
    return f"RIG_HATCH_REQUEST_{canonical}"


def request_hatch_approval(hook_id, context, *, cwd, env=None, command=None,
                            tg_ctl_candidates=None, timeout_s=900.0, process_margin_s=30.0):
    import os
    env_map = env if env is not None else os.environ
    env_var = hatch_env_var(hook_id)
    raw = env_map.get(env_var)
    if raw is None:
        return HatchApprovalResult(
            requested=False, approved=False,
            reason=f"{env_var} is not set; Telegram hatch escalation not requested",
            env_var=env_var, env_present=False,
        )
    value = raw.strip()
    if value.startswith("approve"):
        return HatchApprovalResult(
            requested=True, approved=True,
            reason="fake tg-ctl ask: approved by test double",
            env_var=env_var, env_present=True,
        )
    return HatchApprovalResult(
        requested=True, approved=False,
        reason="fake tg-ctl ask: denied by test double",
        env_var=env_var, env_present=True,
    )
`,
  );
});

afterEach(() => {
  if (savedPath !== undefined) process.env.PATH = savedPath;
  rmSync(home, { recursive: true, force: true });
});

function mockReviewRollback(): void {
  const review = join(binDir, 'review');
  writeFileSync(
    review,
    `#!/usr/bin/env bash\ncat <<'JSON'\n{"decision":"rollback","reason":"Unstyled render (score 0.10): no stylesheets"}\nJSON\nexit 10\n`,
  );
  chmodSync(review, 0o755);
}

function installDescriptor(): void {
  const dir = toolHooksDir(home);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, 'review-visual.pre-send-photo.json'),
    JSON.stringify({
      id: 'review-visual',
      point: 'pre-send-photo',
      cmd: PY_HOOK,
      timeout_ms: 60000,
      on_error: 'open',
    }),
  );
  // No trust.json — the tg-cli hook loader trusts by default (only re-quarantines
  // under the opt-in AGENTS_HOOKS_TRUST guard, which these tests never set).
}

test('(a) no hatch requested, hatch module IS importable → still BLOCKED (regression-safe default)', () => {
  mockReviewRollback();
  installDescriptor();
  const env = { ...process.env, PYTHONPATH: pyLibDir };
  delete env.RIG_HATCH_REQUEST_PRE_SEND_PHOTO;
  const v = runPreSendPhotoHooks({ imagePath: pngPath, caption: 'broken' }, env, home);
  expect(v.blocked).toBe(true);
  expect(v.blockMessage).toContain('Unstyled render');
});

test('(a2) no hatch requested, hatch module NOT importable at all → still BLOCKED (fail-closed to default)', () => {
  mockReviewRollback();
  installDescriptor();
  // No PYTHONPATH to the fake module, and PYTHONNOUSERSITE=1 so this process
  // cannot accidentally pick up a real agent-tools install from user site-packages
  // on a dev machine that happens to have one — proves _load_hatch_escalation's
  // ImportError branch falls through to the pre-existing unconditional block().
  const env = { ...process.env, PYTHONNOUSERSITE: '1' };
  delete env.PYTHONPATH;
  delete env.RIG_HATCH_REQUEST_PRE_SEND_PHOTO;
  const v = runPreSendPhotoHooks({ imagePath: pngPath, caption: 'broken' }, env, home);
  expect(v.blocked).toBe(true);
  expect(v.blockMessage).toContain('Unstyled render');
});

test('(b) a valid live hatch approval ALLOWS the send through despite the rollback verdict', () => {
  mockReviewRollback();
  installDescriptor();
  const env = {
    ...process.env,
    PYTHONPATH: pyLibDir,
    RIG_HATCH_REQUEST_PRE_SEND_PHOTO: 'approve: manually verified, real warning toast feature',
  };
  const v = runPreSendPhotoHooks({ imagePath: pngPath, caption: 'broken' }, env, home);
  expect(v.blocked).toBe(false);
});

test('a DENIED live hatch approval still BLOCKS, with the denial reason surfaced', () => {
  mockReviewRollback();
  installDescriptor();
  const env = {
    ...process.env,
    PYTHONPATH: pyLibDir,
    RIG_HATCH_REQUEST_PRE_SEND_PHOTO: 'deny this one',
  };
  const v = runPreSendPhotoHooks({ imagePath: pngPath, caption: 'broken' }, env, home);
  expect(v.blocked).toBe(true);
  expect(v.blockMessage).toContain('hatch escalation denied');
});

test('(c) an approval granted for one send does NOT leak into a later send that never requested one', () => {
  mockReviewRollback();
  installDescriptor();

  // First send: hatch requested and approved.
  const approvedEnv = {
    ...process.env,
    PYTHONPATH: pyLibDir,
    RIG_HATCH_REQUEST_PRE_SEND_PHOTO: 'approve: first send, verified',
  };
  const first = runPreSendPhotoHooks({ imagePath: pngPath, caption: 'broken' }, approvedEnv, home);
  expect(first.blocked).toBe(false);

  // Second, independent send for a DIFFERENT image: no hatch var this time — must
  // still hard-block. There is no persistent store keyed by image/send that could
  // let the first approval bleed into this unrelated invocation.
  const secondImage = join(home, 'shot2.png');
  writeFileSync(secondImage, 'PNGDATA2');
  const noHatchEnv = { ...process.env, PYTHONPATH: pyLibDir };
  delete noHatchEnv.RIG_HATCH_REQUEST_PRE_SEND_PHOTO;
  const second = runPreSendPhotoHooks({ imagePath: secondImage, caption: 'broken' }, noHatchEnv, home);
  expect(second.blocked).toBe(true);
  expect(second.blockMessage).toContain('Unstyled render');
});
