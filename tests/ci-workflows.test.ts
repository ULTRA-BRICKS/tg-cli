// tests/ci-workflows.test.ts — the CI gate workflows can't silently skip their scan (tg-cli#326).
//
// - CodeQL's "detect source" step decides whether a language is analysed at all. Piping
//   `git ls-files | grep -q` under pipefail turns a found match into SIGPIPE (141) when the file
//   list is longer than the pipe buffer, so the language was skipped and the gate went green.
//   The step's real bash is extracted from the workflow and run against a large index.
// - dependency-review must always run the trusted dep-audit.sh over the PR head as data: no
//   "is the Dependency Graph on?" probe that skips the gate (always skipped on Forgejo), no
//   install step, no PR checkout onto the workspace.
// - leftover-grep must fetch enough history for a merge-base instead of a --depth=1 head.
import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

const WORKFLOWS = join(import.meta.dir, '..', '.github', 'workflows');

interface Step {
  id?: string;
  name?: string;
  if?: string;
  uses?: string;
  run?: string;
  with?: Record<string, string>;
}
interface Workflow {
  on: Record<string, unknown>;
  jobs: Record<string, { steps: Step[] }>;
}

function workflow(file: string): Workflow {
  return Bun.YAML.parse(readFileSync(join(WORKFLOWS, file), 'utf8')) as Workflow;
}

function onlyJobSteps(wf: Workflow): Step[] {
  const jobs = Object.values(wf.jobs);
  expect(jobs).toHaveLength(1);
  return jobs[0].steps;
}

const cleanups: string[] = [];
afterEach(() => {
  for (const d of cleanups.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe('codeql.yml detect step', () => {
  test('finds source listed first in an index far larger than the pipe buffer', () => {
    const detect = onlyJobSteps(workflow('codeql.yml')).find((s) => s.id === 'detect');
    expect(detect?.run).toBeDefined();
    const dir = mkdtempSync(join(tmpdir(), 'codeql-detect-'));
    cleanups.push(dir);
    const git = (args: string[], stdin?: string) => {
      const p = Bun.spawnSync(['git', ...args], {
        cwd: dir,
        stdin: stdin === undefined ? undefined : Buffer.from(stdin),
        stdout: 'pipe',
        stderr: 'pipe',
        env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' },
      });
      if (p.exitCode !== 0) throw new Error(`git ${args.join(' ')}: ${p.stderr.toString()}`);
      return p.stdout.toString().trim();
    };
    git(['init', '-q']);
    const blob = git(['hash-object', '-w', '--stdin'], 'x\n');
    // ~1 MB of `git ls-files` output; `a.ts` sorts first, so `grep -q` exits on line one.
    const entries = [`100644 ${blob}\ta.ts`];
    for (let i = 0; i < 20000; i++) entries.push(`100644 ${blob}\tz/${String(i).padStart(6, '0')}-${'n'.repeat(40)}.txt`);
    git(['update-index', '--index-info'], entries.join('\n') + '\n');
    const output = join(dir, 'github-output');
    writeFileSync(output, '');
    writeFileSync(join(dir, 'detect.sh'), detect?.run ?? '');
    // GitHub/Forgejo run a `shell: bash` step as `bash --noprofile --norc -eo pipefail {0}`.
    const p = Bun.spawnSync(['bash', '--noprofile', '--norc', '-eo', 'pipefail', join(dir, 'detect.sh')], {
      cwd: dir,
      env: { ...process.env, LANGUAGE: 'javascript-typescript', GITHUB_OUTPUT: output, GIT_CONFIG_GLOBAL: '/dev/null' },
      stdout: 'pipe',
      stderr: 'pipe',
    });
    expect(p.exitCode).toBe(0);
    expect(readFileSync(output, 'utf8')).toBe('has_source=true\n');
  });
});

describe('dependency-review.yml', () => {
  const wf = workflow('dependency-review.yml');
  const steps = onlyJobSteps(wf);

  test('runs on the base copy under pull_request_target', () => {
    expect(Object.keys(wf.on)).toContain('pull_request_target');
    expect(Object.keys(wf.on)).not.toContain('pull_request');
  });

  test('no step can skip the audit', () => {
    expect(steps.filter((s) => s.if !== undefined)).toEqual([]);
  });

  test('audits the PR head with the trusted dep-audit.sh', () => {
    const audit = steps.find((s) => s.run?.includes('ci/dependency-review/dep-audit.sh'));
    expect(audit?.run).toContain('"$AUDIT_DIR"');
    const fetch = steps.find((s) => s.run?.includes('git worktree add'));
    expect(fetch?.run).toContain('$HEAD_SHA');
  });

  test('never installs packages or checks the PR head out onto the workspace', () => {
    for (const s of steps) {
      expect(s.run ?? '').not.toMatch(/\b(bun|npm|pnpm|yarn|pip) (install|ci|i)\b/);
      expect(s.with?.ref ?? '').not.toMatch(/head|merge/);
    }
  });
});

describe('leftover-grep.yml', () => {
  test('fetches the PR head with history and verifies a merge-base', () => {
    const fetch = onlyJobSteps(workflow('leftover-grep.yml')).find((s) => s.run?.includes('git fetch'));
    expect(fetch?.run).not.toMatch(/^\s*git fetch[^\n]*--depth=1/m);
    expect(fetch?.run).toContain('git merge-base');
  });
});
