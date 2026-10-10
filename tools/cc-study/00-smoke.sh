#!/usr/bin/env bash
# Finding 0: the lab works — Claude Code starts interactively in the isolated
# HOME inside the private tmux server and shows its input prompt. Also records
# the auth situation (isolated HOME => "Not logged in" without the token env).
source "$(dirname "$0")/lib.sh"
cc_setup 00-smoke
cc_log "auth probe 1: isolated HOME + config dir, nothing else"
cc_probe_auth auth-1-no-token
cc_log "auth probe 2: + a copy of the CURRENT keychain credentials as ~/.claude/.credentials.json"
( umask 077; security find-generic-password -s 'Claude Code-credentials' -w > "$CC_HOME/.claude/.credentials.json" )
cc_probe_auth auth-2-credentials-file
rm -f "$CC_HOME/.claude/.credentials.json"
cc_log "auth probe 3: + CLAUDE_CODE_OAUTH_TOKEN from the keychain (what run-claude.sh does)"
tok="$(security find-generic-password -s 'Claude Code-credentials' -w | python3 -c 'import json,sys;print(json.load(sys.stdin)["claudeAiOauth"]["accessToken"])')"
cc_probe_auth auth-3-oauth-token-env CLAUDE_CODE_OAUTH_TOKEN="$tok"
unset tok
cc_launch
sleep 3
cc_snapshot startup
cc_quit_claude
cc_log "done"
