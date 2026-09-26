import { expect, test } from 'bun:test';
import { readFileSync } from 'fs';
import { join } from 'path';

// install.sh pulls and installs whatever its clone's origin serves, so it must recognise the real
// repo by HOST and PATH — never by substring — before trusting a clone. These cases run the origin
// functions of the real install.sh in bash, isolated from the rest of the installer.

const INSTALL_SH = readFileSync(join(import.meta.dir, '..', 'install.sh'), 'utf8');
const REPO = /^REPO="([^"]+)"$/m.exec(INSTALL_SH)![1];
const BLOCK = /^_url_host_path\(\) \{[\s\S]*?^_origin_is_legacy\(\) \{[\s\S]*?^\}$/m.exec(INSTALL_SH)![0];

function classify(url: string): [boolean, boolean] {
  const script =
    `REPO=${REPO}\n${BLOCK}\n` +
    'c=no; l=no; _origin_is_canonical "$1" && c=yes; _origin_is_legacy "$1" && l=yes; echo "$c $l"\n';
  const proc = Bun.spawnSync(['bash', '-c', script, '_', url]);
  expect(proc.exitCode).toBe(0);
  const [c, l] = proc.stdout.toString().trim().split(' ');
  return [c === 'yes', l === 'yes'];
}

const CANONICAL = [
  `https://git.hyperide.ai/ultrabricks/${REPO}.git`,
  `https://git.hyperide.ai/ultrabricks/${REPO}/`,
  `https://alex@git.hyperide.ai/ultrabricks/${REPO}.git`,
  `https://git.hyperide.ai:443/ultrabricks/${REPO}.git`,
  `git@git.hyperide.ai:ultrabricks/${REPO}.git`,
  `ssh://git@git.hyperide.ai:2222/ultrabricks/${REPO}.git`,
];
const LEGACY = [`https://github.com/alex-mextner/${REPO}.git`, `git@github.com:alex-mextner/${REPO}.git`];
const FOREIGN = [
  `https://git.hyperide.ai.evil.example/ultrabricks/${REPO}.git`,
  `https://git.hyperide.ai@evil.example/ultrabricks/${REPO}.git`,
  `https://evil.example\\@git.hyperide.ai/ultrabricks/${REPO}.git`,
  `https://evil.example/git.hyperide.ai/ultrabricks/${REPO}.git`,
  `https://evil.example/x@git.hyperide.ai/ultrabricks/${REPO}.git`,
  `https://git.hyperide.ai/ultrabricks/${REPO}-evil.git`,
  `https://github.com.evil.example/alex-mextner/${REPO}.git`,
  `/home/u/src/${REPO}`,
];

test('install.sh accepts the Forgejo repo in https, ssh and scp form', () => {
  for (const url of CANONICAL) expect([url, classify(url)]).toEqual([url, [true, false]]);
});

test('install.sh recognises the archived GitHub mirror as legacy', () => {
  for (const url of LEGACY) expect([url, classify(url)]).toEqual([url, [false, true]]);
});

test('install.sh refuses lookalike hosts and other repos', () => {
  for (const url of FOREIGN) expect([url, classify(url)]).toEqual([url, [false, false]]);
});
