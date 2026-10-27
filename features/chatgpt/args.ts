// PURE argument parser for `tg chatgpt …`. Anything it does not recognise is a usage error: the
// entrypoint exits 2 and NEVER falls through to a Telegram send.

import { WORKSPACES, isChatId, isRequestId, isWorkspace, isWorkspaceScope, type Workspace, type WorkspaceScope } from './model';

export type MutatingAction = 'watch' | 'unwatch' | 'pause' | 'resume' | 'continue';

export type ChatgptCommand =
  | { kind: 'help' }
  | { kind: 'accounts' }
  | { kind: 'list'; workspace: WorkspaceScope }
  | { kind: 'show'; workspace: Workspace; chat: string }
  | { kind: 'events'; workspace: WorkspaceScope }
  | { kind: 'requests'; requestId: string | null }
  | { kind: 'action'; action: Exclude<MutatingAction, 'continue'>; workspace: Workspace; chat: string }
  | { kind: 'continue'; workspace: Workspace; chat: string }
  | { kind: 'service'; action: 'service-start' | 'service-stop'; workspace: Workspace }
  | { kind: 'connector-list' }
  | { kind: 'connector-request' };

export interface ParsedChatgpt {
  json: boolean;
  command: ChatgptCommand;
}

export type ParseResult = { ok: true; parsed: ParsedChatgpt } | { ok: false; message: string };

export const CHATGPT_USAGE = `Usage:
  tg chatgpt accounts                              ChatGPT accounts: service + monitor health
  tg chatgpt list [--workspace home|glide.vc|all]  watched sessions per account (default: all)
  tg chatgpt show <workspace> <chat>               one session in detail (incl. latest turn)
  tg chatgpt events [--workspace home|glide.vc|all]  recent monitor events
  tg chatgpt requests [<request-id>]               approval requests and their status
  tg chatgpt watch|unwatch|pause|resume <workspace> <chat>
                                                   ask pm to change what the guardian does
  tg chatgpt continue <workspace> <chat>           ask to send "go" on the CURRENT latest turn
  tg chatgpt service start|stop <workspace>        ask to start/stop an account's guardian service
  tg chatgpt connector list                        known connectors and install state
  tg chatgpt connector request guardian            ask to install the reviewed guardian connector
  tg chatgpt help                                  this text

Global option: --json  prints one machine envelope: {"ok":true,"result":…} or {"ok":false,"error":{"code","message"}}.

<workspace> is home or glide.vc (mutations never accept "all"). Every command above calls
\`pm chatgpt api\`; tg adds no policy. watch/unwatch/pause/resume/continue/service/connector
request only QUEUE an approval request inside pm — nothing runs until the owner approves it in the
Telegram approval prompt. "continue" first reads the session, binds its current latest turn and
is refused when the turn is unknown; it is never auto-retried.

Exit codes: 0 ok · 1 pm refused or answered badly · 2 usage error · 69 pm unavailable ·
75 mutating request outcome unknown (timeout/kill: check \`tg chatgpt requests\`, do not retry).
The same sessions are controllable from Telegram with the owner-only /chatgpt command.`;

const ACTIONS = ['watch', 'unwatch', 'pause', 'resume'] as const;

function fail(message: string): ParseResult {
  return { ok: false, message };
}

function ok(json: boolean, command: ChatgptCommand): ParseResult {
  return { ok: true, parsed: { json, command } };
}

export function parseChatgptArgs(argv: readonly string[]): ParseResult {
  let json = false;
  let help = false;
  let workspace: string | null = null;
  const positional: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--json') json = true;
    else if (arg === '--help' || arg === '-h') help = true;
    else if (arg === '--workspace') {
      const value = argv[++i];
      if (value === undefined) return fail('--workspace needs a value: home, glide.vc or all');
      workspace = value;
    } else if (arg.startsWith('--workspace=')) workspace = arg.slice('--workspace='.length);
    else if (arg.startsWith('-')) return fail(`unknown option ${JSON.stringify(arg)}`);
    else positional.push(arg);
  }
  if (help) return ok(json, { kind: 'help' });
  const [verb, ...rest] = positional;
  if (verb === undefined || verb === 'help') return rest.length === 0 && workspace === null ? ok(json, { kind: 'help' }) : fail('help takes no arguments');
  if (workspace !== null && verb !== 'list' && verb !== 'events') return fail('--workspace only applies to list and events');
  if (workspace !== null && !isWorkspaceScope(workspace)) return fail(`unknown workspace ${JSON.stringify(workspace)} (use home, glide.vc or all)`);
  const scope: WorkspaceScope = workspace === null ? 'all' : (workspace as WorkspaceScope);

  switch (verb) {
    case 'accounts':
      return rest.length === 0 ? ok(json, { kind: 'accounts' }) : fail('accounts takes no arguments');
    case 'list':
      return rest.length === 0 ? ok(json, { kind: 'list', workspace: scope }) : fail('list takes no positional arguments');
    case 'events':
      return rest.length === 0 ? ok(json, { kind: 'events', workspace: scope }) : fail('events takes no positional arguments');
    case 'requests': {
      if (rest.length === 0) return ok(json, { kind: 'requests', requestId: null });
      if (rest.length === 1 && isRequestId(rest[0])) return ok(json, { kind: 'requests', requestId: rest[0] });
      return fail('requests takes at most one valid <request-id>');
    }
    case 'show':
    case 'continue':
    case 'watch':
    case 'unwatch':
    case 'pause':
    case 'resume': {
      if (rest.length !== 2) return fail(`${verb} needs exactly <workspace> <chat>`);
      const [ws, chat] = rest;
      if (!isWorkspace(ws)) return fail(`<workspace> must be ${WORKSPACES.join(' or ')} for ${verb}${ws === 'all' ? ' ("all" is never accepted for a single-session command)' : ''}`);
      if (!isChatId(chat)) return fail('<chat> must be a chat id (letters, digits, "_", ".", ":", "-"; at most 128 characters)');
      if (verb === 'show') return ok(json, { kind: 'show', workspace: ws, chat });
      if (verb === 'continue') return ok(json, { kind: 'continue', workspace: ws, chat });
      return ok(json, { kind: 'action', action: verb as (typeof ACTIONS)[number], workspace: ws, chat });
    }
    case 'service': {
      const [sub, ws, ...extra] = rest;
      if ((sub !== 'start' && sub !== 'stop') || ws === undefined || extra.length > 0) return fail('service needs: start|stop <workspace>');
      if (!isWorkspace(ws)) return fail(`<workspace> must be ${WORKSPACES.join(' or ')} for service ${sub}`);
      return ok(json, { kind: 'service', action: sub === 'start' ? 'service-start' : 'service-stop', workspace: ws });
    }
    case 'connector': {
      const [sub, name, ...extra] = rest;
      if (sub === 'list' && name === undefined) return ok(json, { kind: 'connector-list' });
      if (sub === 'request' && name === 'guardian' && extra.length === 0) return ok(json, { kind: 'connector-request' });
      return fail('connector needs: list | request guardian');
    }
    default:
      return fail(`unknown subcommand ${JSON.stringify(verb)}`);
  }
}
