#!/usr/bin/env bun
// Renders the /chatgpt bot menu from a fixture (fake pm, in-memory ref store) into
// docs/chatgpt-ui/: menu.html (a Telegram-style bubble + inline keyboard), menu.keyboard.json (the
// exact reply_markup), details.html and, when a headless Chrome is installed, menu.png.
// Usage: bun scripts/render-chatgpt-ui.ts [outDir]
import { mkdirSync, writeFileSync } from 'fs';
import { join, resolve } from 'path';
import { buildMenu, handleCallback, type BotDeps, type BotReply } from '../features/chatgpt/bot';
import { fakePm, SESSIONS_FIXTURE } from '../tests/helpers/fake-pm';

const OWNER = 5150;
const outDir = resolve(process.argv[2] ?? join(import.meta.dir, '..', 'docs', 'chatgpt-ui'));
mkdirSync(outDir, { recursive: true });

const pm = fakePm({
  'sessions.list': () => SESSIONS_FIXTURE,
  'sessions.get': (p) => ({ session: { chat: p.chat, title: 'Canvas', status: 'complete', continuation: 'complete', reason: 'quota stop', model: 'gpt-5', effort: 'high', latest_turn: 'turn-glide-canvas-7', last_checked_at: 1_790_000_000 } }),
});
let n = 0;
let store: string | null = null;
const deps: BotDeps = {
  run: pm.run,
  now: () => 1_790_000_000_000,
  randomId: () => `fixture${String(++n).padStart(14, '0')}`,
  readStore: () => store,
  writeStore: (t) => {
    store = t;
  },
  ownerChatId: OWNER,
};

function page(title: string, reply: BotReply): string {
  const rows = (reply.keyboard?.inline_keyboard ?? [])
    .map((row) => `<div class="row">${row.map((b) => `<span class="btn" title="${b.callback_data}">${b.text}</span>`).join('')}</div>`)
    .join('\n');
  const body = reply.html.replace(/\n/g, '<br>');
  return `<!doctype html><meta charset="utf-8"><title>${title}</title>
<style>body{font:15px -apple-system,Segoe UI,sans-serif;background:#0e1621;color:#fff;padding:16px;width:420px}
.bubble{background:#182533;border-radius:12px;padding:10px 12px;line-height:1.35}
code{background:#0e1621;padding:1px 4px;border-radius:4px}.row{display:flex;gap:4px;margin-top:4px}
.btn{flex:1;text-align:center;background:#2b5278;border-radius:8px;padding:7px 4px;font-size:13px}</style>
<div class="bubble">${body}</div>${rows}`;
}

const menu = await buildMenu(deps, 'all');
writeFileSync(join(outDir, 'menu.html'), page('/chatgpt', menu));
writeFileSync(join(outDir, 'menu.keyboard.json'), `${JSON.stringify(menu.keyboard, null, 2)}\n`);
const details = menu.keyboard?.inline_keyboard.flat().find((b) => /^2 Details/.test(b.text));
if (details) {
  const res = await handleCallback(deps, { data: details.callback_data, chatId: OWNER });
  if (res.reply) writeFileSync(join(outDir, 'details.html'), page('details', res.reply));
}
const chrome = Bun.which('google-chrome') ?? Bun.which('chromium') ?? Bun.which('chromium-browser');
if (chrome) {
  const png = Bun.spawnSync([chrome, '--headless=new', '--no-sandbox', '--disable-gpu', `--screenshot=${join(outDir, 'menu.png')}`, '--window-size=470,780', `file://${join(outDir, 'menu.html')}`], { stdout: 'ignore', stderr: 'ignore', timeout: 30_000 });
  process.stdout.write(`${png.exitCode === 0 ? 'menu.png written' : 'headless chrome failed; PNG skipped'}\n`);
} else process.stdout.write('no headless Chrome found; PNG skipped\n');
process.stdout.write(`rendered into ${outDir}\n`);
