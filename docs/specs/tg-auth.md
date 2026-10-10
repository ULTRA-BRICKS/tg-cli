# `tg auth` — one-action Telegram connection (tg-cli#561)

Status: implemented in 1.56.0; user-account subcommands joined in 1.57.0. Authoritative for
`tg auth` (one parser, one help, one status for the bot AND the user's own account), the
send-path "not connected" hint, and the daemon's `/start <nonce>` claim.

## 1. Why

`tg` and `tg-ctl` read `TG_BOT_TOKEN` and `TG_CHAT_ID` from `<configDir>/.env`
(`~/.config/tg-cli/.env`, or `$TG_CTL_CONFIG_DIR/.env`). Until now a user wrote both by hand,
and the chat id is a number the Bot API cannot look up from a username: people had to find it
with a third-party bot or a raw `getUpdates` call, and could paste the wrong one.

`tg auth` replaces that with one command: paste the BotFather token (or pass it), tap **Start**
in Telegram, done. Proof of control is Telegram's own bot deep link
(`https://t.me/<bot>?start=<payload>`, https://core.telegram.org/api/links#bot-links): only a
person who opened the link the terminal printed can send `/start <payload>` to the bot.

## 2. Command surface

`auth` is an exact-match leading token, like `replies` / `voice` / `hooks`: `tg auth`,
`tg auth <subcommand> …` and `tg auth --flag …` are the command; `tg "auth is broken"` (one
argv token) and `tg auth is broken` (second token neither a subcommand nor a flag) still send
as ordinary messages.

| Command | What it does |
|---|---|
| `tg auth` | Already connected → prints the status (§5) and exits 0. Otherwise runs `login`. |
| `tg auth login` (alias `tg auth bot`) | Always (re)binds: token → `getMe` → deep link → wait for `/start` → write `.env`. |
| `tg auth status` | Bot, target chat, config path, daemon state, and the user/caller accounts (§5). Exit 78 when the bot is not configured. |
| `tg auth logout` | Removes `TG_BOT_TOKEN` and `TG_CHAT_ID` from the `.env` (asks first). Bot only. |
| `tg auth user [status\|logout] …` | The user's OWN Telegram account over MTProto (§9). |
| `tg auth caller [status\|logout] …` | A second account that rings the user (§9). |
| `tg auth --help` (= `tg help auth`, = `tg auth user --help`) | One usage text for all of the above. |

Flags:

- `--token <token>` (login): use this BotFather token. `--token -` reads it from stdin (first
  line). Without the flag, login reuses the configured token; with none configured it prompts
  on a terminal and fails with exit 2 elsewhere (an agent's piped shell never hangs on a prompt).
- `--timeout <seconds>` (login): how long to wait for the Start tap. Default 300.
- `--test` (login): after binding, send one short confirmation message to the chat. Default
  is to send nothing.
- `--yes` (logout): skip the confirmation. Without a terminal, logout requires it (exit 2).

A value-taking flag never swallows the next flag: `--token --test` and `--timeout --yes` are
usage errors (exit 2), not a token `--test`. `--token=<v>` / `--timeout=<v>` are accepted;
`--token -` (stdin) is the one dash value allowed in the separated form. A boolean flag given a
value (`--yes=no`, `--test=1`) is a usage error too, never a silent "yes".

**One parser.** `parseAuthArgs` (`features/auth/args.ts`) owns every `tg auth …` argv. When the
second word is `user` or `caller` it delegates the rest to the user-account parser
(`parseAccountAuth`, `features/user-account/args.ts`) and returns `{ account }`; `tg` runs that
through the sidecar runner. Help for either half is the same `AUTH_USAGE`.

## 3. Login flow

1. **Token.** `--token` → stdin (`--token -`) → configured token (`.env`, then the process
   environment, which wins as everywhere in tg) → interactive prompt. A token must look like
   `<digits>:<secret>`; anything else is exit 2.
2. **Validate.** `getMe`. HTTP 401/404 (Telegram's answer for a revoked or mistyped token) is
   exit 3; a network error or another API error is exit 1. Nothing is written yet.
3. **Nonce.** 24 random bytes, base64url → a 32-character start payload (Telegram allows
   `[A-Za-z0-9_-]`, ≤ 64). Single-use, expires at `now + timeout`.
4. **Pending file.** `<configDir>/tg-ctl.<botId>.auth-pending.json` (0600, atomic write):
   `{ v: 1, nonceHash: sha256-hex(nonce), expiresAt: <ms>, status: "waiting" }`. Only the hash
   is on disk. The file is what a running daemon reads (§4); it is removed when login ends,
   on success, timeout, error or Ctrl-C — and only while it still holds this login's hash. One
   login per bot at a time: the check-and-write runs under `<pending>.lock` (the same O_EXCL +
   pid-liveness lock as `routes.json`); while another login's record is still `waiting` and
   unexpired, or its lock is held, a second `tg auth login` is refused (exit 1) — overwriting
   it would silently kill the first link. A record left by a killed process is replaced once
   it expires.
5. **Link.** Prints `https://t.me/<bot_username>?start=<nonce>` and, when `qrencode` is on
   PATH and stdout is a terminal, the same link as a terminal QR code (for a phone).
6. **Wait** for `/start <nonce>` — by the daemon or by tg auth itself (§4).
7. **Accept** only when ALL hold: the message text is exactly `/start <nonce>`, the chat is
   `private` (a user's DM with the bot — never a group a third party could be in), the
   pending file is still `waiting` and not past `expiresAt`, and `sha256(nonce)` equals
   `nonceHash`. Anything else is ignored and the wait continues.
8. **Persist** `TG_BOT_TOKEN` and `TG_CHAT_ID` into `<configDir>/.env` (§6).
9. **Report** the bound bot and chat (status block, §5). With `--test`, send the confirmation.
   When a running daemon polls a DIFFERENT bot than the one just bound, print
   `tg-ctl restart` as the next step (the daemon keeps the token it started with).

## 4. Who reads the `/start` update — daemon coordination

Telegram allows ONE `getUpdates` consumer per bot. A second concurrent long-poll makes one of
them fail with HTTP 409, and every update a consumer confirms (via `offset`) is gone for the
other. tg auth therefore never competes with a running `tg-ctl` for the same bot:

| Situation | Who polls | Why |
|---|---|---|
| A live `tg-ctl` daemon for this bot (pidfile pid alive) and tg auth uses the token in the `.env` | **the daemon** | It already holds the poll; tg auth only writes the pending file and watches it. |
| No live daemon, no chat bound yet (first-time setup) | tg auth, **confirming** offsets (long-poll) | Nothing else needs those updates: the daemon cannot run without a chat. |
| No live daemon, a chat already bound (rebind) | tg auth, **peeking** (short polls, no offset advance) | The stopped daemon still needs every pending update for the bound chat; confirming would lose them. A peek sees at most the oldest 100 pending updates — documented limit. |
| tg auth's own poll gets 409 | **the daemon**, if one is now alive; else exit 5 | A daemon started mid-flow takes over through the pending file. Without a local daemon the other consumer is another machine or a webhook — tg auth names it and stops rather than fight it. |

Pausing the daemon so tg auth could poll (the alternative) was rejected: it needs a stop/start
the user did not ask for, loses the daemon's in-flight state handling during the window, and a
crashed tg auth would leave the daemon down. Asking the daemon over its hook socket was
rejected too: a request that blocks for minutes ties up a socket slot, and an old daemon
without the handler would drop it silently, while a file survives a daemon restart mid-flow.

tg auth never passes `allowed_updates`: Telegram remembers that setting server-side, and a
narrower list would silently drop the daemon's `callback_query` updates until its next poll.

**Daemon side** (`tg-ctl run`, each non-empty batch, before routing):

- `daemonAuthStep` (pure) matches the batch against the pending file with the §3.7 rules.
- On a match the daemon writes `TG_CHAT_ID` into the `.env` (same merge, §6), rewrites the
  pending file to `status: "bound"` with the chat (`id`, `type`, `title`/`first_name`,
  `username`), and keeps running: from the NEXT batch on, `ctx.chatId` (the inbound filter,
  every reply, the delivery ledger's chat) is the new chat — the batch that carried the tap is
  routed and ledgered against the one chat it was received for, so an old-chat message in it
  still reaches its pane. Re-binding the same chat is a no-op switch. A failed `.env` write is
  recorded as `status: "failed"` with the error, changes nothing, and tg auth reports it
  (exit 1). After a hand-off tg auth does not rewrite the `.env` the daemon already wrote.
- Every message whose text is `/start <32-char base64url>` is dropped from routing — the
  matched one and any stale/duplicate deep-link tap — so a Start tap is never typed into an
  agent's pane. The update still enters the delivery ledger as received and processed (the
  update-id audit sees no gap, a replay skips it) and the offset still advances.
- Known limits of a rebind to a DIFFERENT chat: a new-chat message that lands in the very same
  `getUpdates` batch as the tap is filtered as foreign (the long-poll returns as soon as the tap
  arrives, so this needs two updates within milliseconds); reply routes (`routes.json`) are keyed
  by message id only, so a reply in the new chat whose id matches an old route can resolve to
  the old pane — the same as a manual `.env` edit plus restart today.

The daemon refuses to start without `TG_CHAT_ID` (it is single-chat); its error names
`tg auth`. A supervised daemon (launchd `KeepAlive`, systemd `Restart=on-failure`) relaunches
by itself once tg auth has written the chat.

## 5. Status

`tg auth status` (and a bare `tg auth` on a connected config) — one view of every identity tg
can act as:

```
bot:    @my_bot (My Bot) · id 123456
chat:   Alex (@alex) · private · id 42
config: /home/alex/.config/tg-cli/.env
daemon: running (pid 4242)
user:   id 777000 (logged in by tg)
caller: not logged in — run `tg auth caller`
```

Chat name: a group/channel's `title`, else `first_name last_name`; `@username` when it has
one. `getChat` failures (the user blocked the bot, a wrong id) print
`chat:   id 42 — unreachable: <Telegram description>` and exit 1. A variable set in the process
environment that overrides the file is flagged `(from environment)`. No bot token →
``bot:    not connected — run `tg auth` `` plus the config path, exit 78.

`user:` / `caller:` are read OFFLINE from `<configDir>/mtproto/{personal,caller}.json` — no
Python, no network, the session string is never printed: `id N (logged in by tg)`,
`id N (imported — online use needs --source-idle-confirmed)`, `not logged in — run …`, or
``session file unreadable — run `tg auth user logout`, then `tg auth user` ``. They are always
printed (also when the bot part fails) and never change the exit code, which stays the bot's
(scripts keep their 78). `tg auth user status --online` is the account check that connects.

## 6. Config file format

`<configDir>/.env` stays the flat `KEY=VALUE` file `features/config/env.ts` reads (no quotes,
no expansion). The writer (`mergeEnvContent`, pure):

- replaces the FIRST line defining a key in place, drops later duplicates of it, appends keys
  not yet present, removes keys asked to be removed;
- keeps every other line byte-for-byte (comments, blank lines, unrelated keys, order);
- ends the file with one newline; refuses a value containing a newline or `\r` (it would forge
  another key).

The write is atomic (temp file + rename) with mode 0600; the config dir is created 0700 when
missing.

## 7. Not configured → hint

A `tg` send with no `TG_BOT_TOKEN` or `TG_CHAT_ID` prints

```
Error: tg is not connected to Telegram — TG_BOT_TOKEN and TG_CHAT_ID must be set in <configDir>/.env.
Run `tg auth` to connect in one step (BotFather token + one Start tap).
```

and exits **78** (`EX_CONFIG`), distinct from a failed send (1). `--dry-run`, `--help`,
`--version` and the other local actions still work without credentials.

## 8. Exit codes (`tg auth`)

| Code | Meaning |
|---|---|
| 0 | success (bound / status OK / logged out / nothing to log out) |
| 1 | Telegram or network error, chat unreachable, `.env` write failed, logout declined at the prompt, another login for the bot still waiting |
| 2 | usage error: unknown subcommand/flag, a flag given as another flag's value, bad token shape, no token and no terminal, logout without `--yes` and no terminal |
| 3 | Telegram rejected the token (`getMe` 401/404) |
| 4 | timed out waiting for the Start tap. The message says "nothing was changed" only when the `.env` still holds the chat it had at the start; if a daemon saved a chat but its confirmation never arrived, it names that chat and `tg auth status` |
| 5 | another consumer holds this bot's updates (409 with no local daemon, or a webhook) |
| 78 | not configured (`status`; also the `tg` send gate, §7) |

`tg auth user|caller …` keeps the sidecar's codes: 0 ok, 2 usage, 3 not logged in / refused,
1 failed (docs/specs/independent-telegram-clients.md §1).

## 9. `tg auth user` / `tg auth caller`

The user-account (MTProto) login — so tg can send as the user and place calls — lives under
the same command. Its flow, storage (`<configDir>/mtproto/`, 0700/0600) and sidecar are
specified in docs/specs/independent-telegram-clients.md; here only the shared surface:

- `tg auth user` logs in the user's own account (phone + code + 2FA, or `--qr`);
  `tg auth caller` logs in the account that rings the user (an account cannot ring itself).
- `tg auth user|caller status [--online]` and `tg auth user|caller logout` are per account;
  plain `tg auth status` shows both accounts next to the bot (§5); plain `tg auth logout`
  touches only the bot keys.
- `user` and `caller` are never bot subcommands, and `tg auth login|status|logout` never reach
  the sidecar.

## 10. Code map

- `features/auth/env-file.ts` — `mergeEnvContent` (§6).
- `features/auth/binding.ts` — nonce, deep link, pending-file format, `matchStart`,
  `daemonAuthStep` (§3–§4).
- `features/auth/args.ts` — `parseAuthArgs` (exact-match dispatch, flags, `user`/`caller`
  delegation) and `AUTH_USAGE` (the one help text).
- `features/auth/status.ts` — status block formatting, including the account lines.
- `features/auth/cli.ts` — `runAuth`: the orchestration, every effect injected
  (`fetch`, file read/atomic write/unlink, clock/sleep, stdin, daemon liveness, output).
- `tg` — wires real I/O into `runAuth`; the send-path hint (§7).
- `tg-ctl` — `daemonAuthStep` in the poll loop; `ctlPaths().authPending`.
