# Release verification for identified calls (#761)

The host policy prohibits the full tg-cli suite on the workstation. `.ship-config`
therefore runs the entire checkout through the existing `tg-remote-test` command
on an ephemeral Runpod instance. This is the documented committed test-command
configuration of `gh ship`, not a skip-CI flag, test-only environment override,
subset, cached pass, or weakened gate. A runner error remains a failed check.

The installed runner was stale. It was replaced by the existing clean
`remote-test` worktree revision after all 21 of that runner's offline tests passed.
Its original installed copy is retained in the private task evidence directory.
No API key is copied into the repository. Source uploads exclude ignored files.

The exploratory pre-review run was stopped before tests so the next release
check will run corrected code. Its ephemeral pod deletion was confirmed.

This release still requires the final staged review, commit, normal ship gate,
and verified deployment. Do not label local affected-suite success as a full
repository pass or a live voice call.
