// PURE parsing of the /chatgpt slash command for stepUpdates.

import { isWorkspaceScope, type WorkspaceScope } from './model';

// `/chatgpt`, `/chatgpt home`, `/chatgpt@bot glide.vc`. No argument → all accounts; anything that
// is not a workspace → null (the daemon answers with usage instead of guessing).
export function parseChatgptMenuArg(rest: string): WorkspaceScope | null {
  const args = rest.trim().split(/\s+/).filter(Boolean);
  if (args.length === 0) return 'all';
  if (args.length > 1) return null;
  const arg = args[0].toLowerCase();
  return isWorkspaceScope(arg) ? arg : null;
}
