# Approved execution plan: issue #761

Implement in `test/761-call-integration-complete`, based on main 218a7a4 (1.71.0).
Reuse the unfinished draft from `call-integration-761` without changing that worktree.
Default verification must be offline, credential-free, and exercise real frontdoors and
shared Python services. Only Telegram/Fish external boundaries may be replaced.

- [x] Copy existing draft and merge package scripts without changing version.
- [x] Audit fixture boundaries and trace every requirement to named tests.
- [x] Run focused baseline; reproduce failures before minimal repairs, including PR #776 streaming WAV.
- [x] Finish fail-closed JSON/JUnit runner and ordinary Bun discovery.
- [x] Run affected short checks; record exact results and server commands.
- [x] Write handoff with gaps and independent-review readiness.

Full/heavy verification belongs on server 65.21.40.51, arranged by the orchestrator.
No live credentials, external APIs, calls, sends, SSH, commits, pushes or deployment.
Live TTS remains `--block tts:tool-denied`; dependent calls and unsupported two-way
speech must remain blocked. No generated proof or offline test establishes listening.

Server full-manifest verification and independent review remain the orchestrator’s next steps; neither is claimed complete.

## Approved audit follow-up

- [x] Reproduce remaining owner, detached child, command-exit, replay and inventory gaps.
- [x] Repair verification boundaries only; keep real concatenation and PR776 regressions.
- [x] Prove existing journal read-only behavior and add strict mutation inventory.
- [x] Run bounded affected checks and generate explicitly incomplete local reports.
- [x] Independent read-only final review; repair and re-review its exited-leader finding.
- [x] Document original audit dispositions, red/green counts and exact main/server commands.

Orchestrator-supplied evidence: the prior 33-case integration snapshot passed on server
65.21.40.51 with ffmpeg in 16.236 s. Final 35-case integration and mutation/full-manifest
execution remain main’s work. No local full repository suite or live stage is authorized.
