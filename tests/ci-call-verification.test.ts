/** CI contract, exercised by bun test against parsed workflow shell scripts.
 * Interpreter boundaries are stubbed: this test never installs packages or calls Telegram.
 * #761 needs resolver failures to block verification rather than reuse prior evidence.
 */
import { expect, test } from 'bun:test';
import { chmodSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tempDir } from './helpers/test-temp';

function field(value: unknown, key: string): unknown {
  if (typeof value !== 'object' || value === null) throw new Error(`Expected object for ${key}`);
  return Reflect.get(value, key);
}
function text(value: unknown): string {
  if (typeof value !== 'string') throw new Error('Expected workflow string');
  return value;
}
function steps(file = 'ci.yml'): unknown[] {
  const parsed: unknown = Bun.YAML.parse(readFileSync(join(import.meta.dir, '../.github/workflows', file), 'utf8'));
  const result = field(field(field(parsed, 'jobs'), file === 'ci.yml' ? 'test' : 'analyze'), 'steps');
  if (!Array.isArray(result)) throw new Error('Expected workflow steps');
  return result;
}
function named(name: string): unknown {
  const step = steps().find(step => field(step, 'name') === name);
  if (!step) throw new Error(`Missing CI step: ${name}`);
  return step;
}

function execute(failure = '') {
  const script = text(field(named('Verify clean call runtime'), 'run'));
  const dir = tempDir('ci-call-contract-');
  try {
    const bin = join(dir, 'bin');
    const runnerTemp = join(dir, 'runner temp');
    mkdirSync(bin);
    mkdirSync(runnerTemp);
    const log = join(dir, 'argv.jsonl');
    writeFileSync(log, '');
    for (const tool of ['ffmpeg', 'ffprobe']) {
      writeFileSync(join(bin, tool), '#!/bin/sh\nexit 0\n');
      chmodSync(join(bin, tool), 0o755);
    }
    const python = join(bin, 'python3');
    writeFileSync(python, `#!${process.execPath}
import {appendFileSync, mkdirSync, copyFileSync, chmodSync} from 'node:fs';
import {join} from 'node:path';
const args = process.argv.slice(2);
appendFileSync(process.env.CALL_TEST_LOG, JSON.stringify([process.argv[1], ...args]) + '\\n');
if (args[0] === '-m' && args[1] === 'venv') {
  const bin = join(args[2], 'bin'); mkdirSync(bin, {recursive:true});
  copyFileSync(process.argv[1], join(bin, 'python')); chmodSync(join(bin, 'python'), 0o755);
}
if ((process.env.CALL_TEST_FAIL === 'install' && args.includes('install')) ||
    (process.env.CALL_TEST_FAIL === 'runner' && args.includes('scripts/verify-calls.py'))) process.exit(23);
`);
    chmodSync(python, 0o755);
    const result = Bun.spawnSync(['bash', '--noprofile', '--norc', '-eo', 'pipefail', '-c', script], {
      cwd: join(import.meta.dir, '..'),
      env: { PATH: `${bin}:${process.env.PATH}`, RUNNER_TEMP: runnerTemp,
        CALL_TEST_LOG: log, CALL_TEST_FAIL: failure },
      timeout: 10000, stdout: 'pipe', stderr: 'pipe',
    });
    const calls = readFileSync(log, 'utf8').trim().split('\n').filter(Boolean).map(line => {
      const value: unknown = JSON.parse(line);
      if (!Array.isArray(value) || !value.every(item => typeof item === 'string')) throw new Error('Invalid argv log');
      return value.map(item => text(item));
    });
    return { code: result.exitCode, calls, runnerTemp };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test('CI installs the source hash lock and verifies through the same fresh runtime', () => {
  const first = execute();
  const second = execute();
  expect(first.code).toBe(0);
  expect(second.code).toBe(0);
  const create = first.calls.find(call => call[2] === 'venv');
  expect(create).toBeDefined();
  const runtime = create?.[3] ?? '';
  expect(runtime.startsWith(`${first.runnerTemp}/call-verification.`)).toBe(true);
  expect(second.calls.find(call => call[2] === 'venv')?.[3]).not.toBe(runtime);
  const install = first.calls.find(call => call.includes('install')) ?? [];
  expect(install).toEqual([`${runtime}/bin/python`, '-m', 'pip', 'install', '--require-hashes', '-r', 'requirements-call.txt']);
  expect(first.calls).toContainEqual([`${runtime}/bin/python`, '-m', 'pip', 'check']);
  const metadata = first.calls.find(call => call.includes('tests/call-runtime-lock.test.py')) ?? [];
  expect(metadata).toEqual([`${runtime}/bin/python`, 'tests/call-runtime-lock.test.py',
    'CallRuntimeLockTests.test_frozen_dependency_constraints',
    'CallRuntimeLockTests.test_reported_old_pin_violates_published_constraint']);
  const runner = first.calls.find(call => call.includes('scripts/verify-calls.py')) ?? [];
  expect(runner).toEqual([`${runtime}/bin/python`, 'scripts/verify-calls.py', '--hermetic',
    '--report-json', `${runtime}/reports/calls.json`, '--report-junit', `${runtime}/reports/calls.xml`]);
});

test('install and verifier failures fail the step without a later successful runner', () => {
  const install = execute('install');
  expect(install.code).toBe(23);
  expect(install.calls.some(call => call.includes('scripts/verify-calls.py'))).toBe(false);
  const runner = execute('runner');
  expect(runner.code).toBe(23);
  expect(runner.calls.filter(call => call.includes('scripts/verify-calls.py'))).toHaveLength(1);
});

test('CI retains full suite, prerequisites, bound and pinned Forgejo report upload', () => {
  const parsed: unknown = Bun.YAML.parse(readFileSync(join(import.meta.dir, '../.github/workflows/ci.yml'), 'utf8'));
  expect(field(field(field(parsed, 'jobs'), 'test'), 'timeout-minutes')).toBe(30);
  expect(field(named('Test'), 'run')).toBe('ci/test/bun-test-watchdog.sh');
  const prerequisites = text(field(named('Install media and status tools (PDF, call concatenation, daemon status)'), 'run'));
  for (const tool of ['ffmpeg', 'python3-venv', 'python3-dev', 'build-essential']) expect(prerequisites).toContain(tool);
  const upload = named('Upload call verification reports');
  const codeql = steps('codeql.yml').find(step => field(step, 'name') === 'Upload SARIF artifact');
  expect(field(upload, 'uses')).toBe(field(codeql, 'uses'));
  expect(text(field(upload, 'uses'))).toMatch(/^https:\/\/code\.forgejo\.org\/forgejo\/upload-artifact@[0-9a-f]{40}$/);
  expect(field(upload, 'if')).toBe('always()');
  expect(field(field(upload, 'with'), 'path')).toBe('${{ runner.temp }}/call-verification.*/reports/*');
  expect(field(field(upload, 'with'), 'if-no-files-found')).toBe('error');
  expect(field(named('Verify clean call runtime'), 'continue-on-error')).toBeUndefined();
  expect(field(named('Verify clean call runtime'), 'env')).toBeUndefined();
});
