// Shared permission-menu fixtures for tg-cli#309 (unit + daemon integration tests).
//
// Two DIFFERENT commands sharing their first 99 characters — exactly what
// hook-normalize's 100-char question summary keeps (truncateWithEllipsis: 99 chars +
// "…"). The shared prefix ends right before a space in both, so a prefix +
// word-boundary match cannot tell them apart.
export const SHARED_99 = 'cd /home/ultra/projects/service-alpha-2 && docker compose -f deploy/compose.production.yml run --rm';
export const SAFE_LONG = `${SHARED_99} migrate --dry-run`;
export const DANGEROUS_LONG = `${SHARED_99} migrate --drop-all-tables --force`;

// A live Claude Code Bash permission box for `command`, in the shape real captures show.
export const permissionBoxFor = (command: string): string =>
  [' Bash command', '', `   ${command}`, '', ' Do you want to proceed?', ' ❯ 1. Yes', '   2. No', '', ' Esc to cancel'].join('\n');
