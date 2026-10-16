import { expect, test } from 'bun:test';
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tempDir } from './helpers/test-temp';

type Step = { name?: string; run?: string; uses?: string; if?: string; with?: Record<string, unknown> };
type Workflow = { env: Record<string, string>; jobs: Record<string, { steps: Step[] }> };
const workflow = Bun.YAML.parse(readFileSync(join(import.meta.dir, '../.github/workflows/codeql.yml'), 'utf8')) as Workflow;
function script(name: string): string {
  const step = Object.values(workflow.jobs).flatMap((job) => job.steps).find((step) => step.name === name);
  if (!step?.run) throw new Error(`Missing executable workflow step: ${name}`);
  return step.run;
}
function fixture() {
  const dir = tempDir('codeql-budget-');
  const bin = join(dir, 'bin');
  mkdirSync(bin);
  const capture = join(dir, 'argv.jsonl');
  writeFileSync(join(bin, 'codeql'), '#!/usr/bin/env python3\nimport os,json,sys\nwith open(os.environ["CODEQL_ARGS"],"a") as f: f.write(json.dumps(sys.argv[1:])+"\\n")\n');
  chmodSync(join(bin, 'codeql'), 0o755);
  const env = { ...process.env, ...workflow.env, PATH: `${bin}:${process.env.PATH}`, CODEQL_ARGS: capture,
    LANGUAGE: 'javascript-typescript', BUILD_MODE: 'none', RUNNER_TEMP: join(dir, 'runner'), GITHUB_STEP_SUMMARY: join(dir, 'summary') };
  return { dir, capture, run: (body: string) => {
    const path = join(dir, 'step.sh');
    writeFileSync(path, body);
    return Bun.spawnSync(['bash', '--noprofile', '--norc', '-eo', 'pipefail', path], {
      cwd: dir, env, stdout: 'pipe', stderr: 'pipe', timeout: 10000,
    });
  } };
}
function analyzeArgs(body: string): string[] {
  const f = fixture();
  const result = f.run(body);
  expect(result.exitCode).toBe(0);
  const calls = readFileSync(f.capture, 'utf8').trim().split('\n').map((line) => JSON.parse(line) as string[]);
  expect(calls).toHaveLength(2);
  const analyze = calls.find((args) => args[0] === 'database' && args[1] === 'analyze');
  if (!analyze) throw new Error('The workflow never executed analysis');
  return analyze;
}

test('real analyze step passes explicit resources and the complete security suite to CodeQL', () => {
  const args = analyzeArgs(script('Perform CodeQL Analysis (CodeQL CLI)'));
  expect(args).toContain('--ram=4096');
  expect(args).toContain('--threads=2');
  expect(args).toContain('codeql/javascript-queries:codeql-suites/javascript-security-extended.qls');
  expect(args).toContain('--format=sarif-latest');
  expect(args).not.toContain('--threads=0');
});

test('commenting out resource flags is visible in executed argv, even if the text remains', () => {
  const original = script('Perform CodeQL Analysis (CodeQL CLI)');
  const mutated = original.replace(/--(?:threads|ram)="\$CODEQL_(?:THREADS|RAM_MB)"/g, '')
    + '\n# --threads="$CODEQL_THREADS" --ram="$CODEQL_RAM_MB"\n';
  expect(mutated).not.toBe(original);
  const args = analyzeArgs(mutated);
  expect(args).not.toContain('--ram=4096');
  expect(args).not.toContain('--threads=2');
});

for (const mode of ['missing', 'warning', 'clean'] as const) {
  test(`real SARIF gate ${mode === 'clean' ? 'accepts' : 'rejects'} ${mode} results`, () => {
    const f = fixture();
    if (mode !== 'missing') {
      mkdirSync(join(f.dir, 'sarif-results'));
      const results = mode === 'warning' ? [{ ruleId: 'test/unsuppressed', level: 'warning', message: { text: 'fixture finding' },
        locations: [{ physicalLocation: { artifactLocation: { uri: 'fixture.ts' }, region: { startLine: 1 } } }] }] : [];
      writeFileSync(join(f.dir, 'sarif-results/javascript-typescript.sarif'), JSON.stringify({ version: '2.1.0', runs: [{ results }] }));
    }
    const result = f.run(script('Gate on SARIF findings'));
    expect(result.exitCode).toBe(mode === 'clean' ? 0 : 1);
    const text = result.stdout.toString() + result.stderr.toString();
    expect(text).toContain(mode === 'missing' ? 'No SARIF produced' : mode === 'warning' ? 'gated=1' : '0 gated');
  });
}

test('SARIF upload uses the pinned Forgejo-compatible action and retains the complete report', () => {
  const upload = Object.values(workflow.jobs).flatMap((job) => job.steps).find((step) => step.name === 'Upload SARIF artifact');
  expect(upload?.uses).toBe('https://code.forgejo.org/forgejo/upload-artifact@16871d9e8cfcf27ff31822cac382bbb5450f1e1e');
  expect(upload?.if).toBe("always() && steps.detect.outputs.has_source == 'true'");
  expect(upload?.with?.path).toBe('sarif-results/*.sarif');
  expect(upload?.with?.['retention-days']).toBe(30);
});
