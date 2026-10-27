# Configuration schema and help

## Goal

Make every supported `config.yaml` setting discoverable in CLI help, editor
completion, and a checked-in reference without changing configuration semantics.
The source audit identifies 10 control settings, 6 voice settings, and 12 outbound
feature flags. Runtime defaults remain authoritative, including
`control.enabled: true` and `voice.runner: whisper.cpp`.

## Design

- A pure `features/config/schema.ts` registry generates the editor schema and
  full CLI reference. Metadata describes canonical YAML names; defaults come
  from the existing runtime modules. Optional `session` and `threads` defaults
  are described as runtime choices rather than invented literal values.
- Strict editor diagnostics cover the known `control`, `voice`, and `features`
  blocks. This is advisory validation; the existing scalar readers, legacy
  accepted forms, and fallback behavior stay unchanged.
- Exact `tg help config`, `tg config help`, `tg config --help`, and `tg config -h`
  commands print static help before config or credential access. Longer prose
  beginning with those words remains an ordinary message.
- Exact `tg config validate` (and its `help`/`--help`/`-h` forms) reads only
  `config.yaml`, reusing the generated schema's types, enums, ranges and keys.
  It scans lines like the runtime readers, so shapes they silently skip
  (inline blocks, nested mappings, duplicates, quoted section names) are errors,
  and values they would ignore or heal are errors. Forms the runtime accepts but
  the editor schema flags (`yes`/`no`, quoted `voice.enabled`/`voice.threads`)
  are warnings. Exit 1 on any error or unreadable file; a missing file is valid.
  It never writes, never initializes metadata, never reads credentials.
- Normal config I/O maintains a sibling schema and canonical leading modeline.
  Metadata refresh is best-effort, makes one lock attempt, and skips replacements
  that would break hardlinks or change ownership; it also skips read-only parent
  directories. It preserves other YAML text, comments, permissions, ownership,
  and config/schema symlinks. Optional editor
  support must not prevent reading usable settings. Help and dry runs do not
  initialize files.
- Explicit setting writes wait a bounded time for the application's lock. They
  normally replace single-link files atomically. When hardlinks, ownership, or
  a read-only parent directory prevent replacement, a permitted explicit write
  updates the original file in place under the lock after identity/content checks. This
  fallback preserves the inode and ownership but is not atomic to concurrent
  readers; schema writes never use it. Writers with the same effective OS user
  and canonical config path share a private lock independent of HOME/TMPDIR;
  other users, independent hardlink aliases, and external editors are not
  synchronized.
- `scripts/generate-config-schema.ts` generates `config.schema.json` and
  `docs/configuration.md`; the latter embeds the same help renderer. Check mode
  detects drift without writing. All paths are relative to the script's own
  checkout, independent of the caller's working directory.

## Build and release fit

This CLI is executed directly by Bun and has no compilation stage. Installation
links the checkout and deployment fast-forwards tracked files. The artifacts
therefore ship through existing installation and deployment paths. CI runs
`schema:check`; equality tests run in the ordinary suite, including the remote
runner named in `.ship-config`. No synthetic build hook or automatic git
staging/commit command is added.

## Acceptance

Schema defaults and keys match the runtime types/maps. Help aliases work with
empty credentials and missing or malformed config, preserve filesystem state,
and do not intercept longer prose. Generated artifacts match the registry;
missing/stale artifacts fail checks without changes. Config maintenance is
idempotent, preserves unrelated bytes, permissions, ownership, and symlinks, and
tolerates read-only metadata locations. Explicit writes retain support for
writable hardlinked or group-writable config files. Tests use temporary files and offline mocks; this change
does not require a live Telegram send, deployment, or daemon restart.
