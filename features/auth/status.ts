// --- `tg auth status` block (docs/specs/tg-auth.md §5) ---
//
// Which bot tg sends as and which chat it sends to, by name — the "where do my
// messages go" answer a bare numeric TG_CHAT_ID never gave. Pure formatting.
import type { AuthChat } from './binding';

export interface BotInfo {
  id: number;
  username: string;
  first_name: string;
}

export type ChatState =
  | { kind: 'ok'; chat: AuthChat }
  | { kind: 'unbound' }
  | { kind: 'error'; id: string; description: string };

export function botLabel(bot: BotInfo): string {
  return `@${bot.username} (${bot.first_name}) · id ${bot.id}`;
}

export function chatLabel(chat: AuthChat): string {
  const name = chat.title ?? [chat.first_name, chat.last_name].filter(Boolean).join(' ');
  const handle = chat.username ? ` (@${chat.username})` : '';
  const type = chat.type ? ` · ${chat.type}` : '';
  return name ? `${name}${handle}${type} · id ${chat.id}` : `id ${chat.id}${type}`;
}

export function formatStatus(s: {
  bot: BotInfo;
  chat: ChatState;
  envPath: string;
  daemonPid: number | null;
  fromEnvironment: readonly string[]; // keys a process env var overrides the file for
}): string {
  const note = (key: string): string => (s.fromEnvironment.includes(key) ? ` (${key} from environment)` : '');
  const chat =
    s.chat.kind === 'ok'
      ? chatLabel(s.chat.chat)
      : s.chat.kind === 'unbound'
        ? 'not bound — run `tg auth`'
        : `id ${s.chat.id} — unreachable: ${s.chat.description}`;
  return [
    `bot:    ${botLabel(s.bot)}${note('TG_BOT_TOKEN')}`,
    `chat:   ${chat}${note('TG_CHAT_ID')}`,
    `config: ${s.envPath}`,
    `daemon: ${s.daemonPid === null ? 'not running' : `running (pid ${s.daemonPid})`}`,
  ].join('\n');
}
