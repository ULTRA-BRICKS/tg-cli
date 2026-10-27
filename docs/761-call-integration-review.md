# Independent read-only audit follow-up review — #761

Reviewer: separate agent `/root/final_safety_review`, same isolated worktree, no edits.
Final verdict: **no remaining material blocker found**. This is peer review of the
verification implementation, not a staged commit gate marker or live acceptance.

The reviewer found an additional P1 after the first descendant-tree repair: when the
leader exited first, a detached child no longer had a discoverable parent link and
could hold pipes open. Its safe two-second reproduction made a 0.2-second timeout
last 2.03 seconds. The disposable Linux subreaper repair retains ownership across
leader exit and cleans adopted descendants on normal exit too. The same independent
reproduction then returned exit 0 in 0.06 seconds. A16 covers open and closed pipes.

Independently executed by the reviewer:

- `PYTHONDONTWRITEBYTECODE=1 timeout 35s python3 tests/telegram-761-verify-calls.test.py`:
  57 passed, 0 skipped, 15.411 s (before the final supervisor addition).
- The initial 12 safety regressions: 12 passed in 3.519 s.
- Final `DetachedCleanup` selection after the supervisor repair: 3 passed in 2.584 s,
  including real preparation timeout/cancel, exited leaders and unrelated sleepers.
- Existing-journal I20: 1 passed in 0.731 s, through real primary fixture frontdoors.

Source review accepted the verified-owner guard, nonzero-exit handling, durable claim
before live effects, blocked-prerequisite ordering, fixed scenario inventory, required
mutation manifest and existing-journal read-only proof. The reviewer also checked the
last metadata label adjustment and confirmed the verdict without weakening inventory,
skips or pass/fail checks. No optional style concerns are being used to defer completion.

No full integration/mutation/repository batch, credentials, network, live checks,
commits or deployment were performed by the reviewer. Main owns final combined server
verification and any formal review/commit gates. Original draft and earlier reports
remain unchanged; current incomplete local reports use the `761-audit-*` names.

Concurrent runtime-lock/CI/release edits appeared in final worktree status and are
owned/documented by their separate workers. The verdict above does not substitute for
main’s combined-head review or package-install/CI execution of those changes.
