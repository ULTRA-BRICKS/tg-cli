# #761 material review fixes

Scope: the four P2 findings only, against the user-approved staged integration.
Changes remain unstaged for the main worker's formal review and shipping.
All evidence below is offline: generated audio, temporary stores and fake transports.
No credentials, provider requests, Telegram messages or calls were used.

## Red → green evidence

- **Asynchronous preparation:** the new async fake was never awaited by the
  synchronous service; cancellation timed out. Production synthesis and joining
  now await an owned subprocess, with text carried in stdin JSON. Existing immediate
  fakes remain supported. The worker owns provider/host/ffmpeg descendants, and
  cleanup completes before the call's temporary directory is removed.
  Nine preparation tests pass, including real sleeping host/ffmpeg processes with
  nested SIGTERM-ignoring children, timeout, repeated cancellation and cancellation
  during process creation. Owned PID/group probes fail with `ProcessLookupError`
  before cancellation returns; an unrelated sleeping process remains alive.
  The actual service records `cancelled` and never dials. A successful production
  worker generated a 100 ms fixture WAV and joined it to 200 ms with real local
  ffmpeg, preserving private files and the documented nested `tts.json` schema.
- **Speech splitting:** `'x' + ' ' * 999` failed after mirroring with `TEXT_EMPTY`;
  the regression now completes using fake transport without an empty synthesis.
  Speech uses the TTS limit of 1,000 Python characters, prefers whitespace boundaries
  and skips blank fragments. Literal source/spoken transcripts remain unchanged.
  Tests include emoji, unbroken words, exact boundaries and oversized metadata intros.
- **History indexing:** both new and existing-store query-plan tests failed with
  `SCAN events`. Normal write setup now creates `events_call_id` on `events(call_id)`;
  both plans use `SEARCH events USING INDEX events_call_id (call_id=?)`, without a
  temporary sort. Six tests cover migration, event order, permanent token claims,
  private file modes, missing stores and unchanged old/unknown schemas on reads.
- **Signal metrics:** the 30-second relative performance regression failed before
  the fix (1.048366 s evaluator versus 0.891818 s allocation-heavy reference loop).
  Window-sized standard-library arrays and native integer `math.sumprod` replace
  per-sample byte slicing/conversion. All 21 metrics tests pass, including clipping
  edges at every PCM width, silence edges, partial windows, sample rates,
  opposite-phase stereo and PCM24 precision. The performance assertion uses process
  CPU time relative to the reference, avoiding a fixed wall-clock deadline.

## Measured performance

Complete evaluator wall time on generated mono PCM, comparing the staged implementation
with the fix on this host (single representative runs, not provider latency):

| Sample | Before | After |
| --- | ---: | ---: |
| 30 seconds, 44.1 kHz, PCM16 | 0.817095 s | 0.254451 s |
| 120 seconds, 48 kHz, PCM24 | 4.017302 s | 1.709505 s |

Peak, clipping and silence matched exactly. The 120-second RMS differed by
`8.87e-12`: integer square sums remove accumulated floating rounding, without
quantizing PCM24. Clipping remains magnitude ≥ 0.999; silence remains RMS below
−40 dBFS in 10 ms windows. Temporary sample storage is bounded to one window
(about 60 KiB at supported maximum rate/channels), alongside the existing bounded
PCM buffer. Python ≥ 3.12 is already the declared package requirement.

An actual `Journal.history(limit=100)` fixture with 300,000 events (100 matching
events, 299,900 unrelated) measured **1.105827 s → 0.001537 s**, returning identical
rows. This measures selective history; returning hundreds of thousands of matching
transitions still requires decoding those transitions.

## Validation boundaries

Independent review passed for the journal, metrics and asynchronous/speech fixes.
Review caught and repaired cleanup of groups whose leader already exited and
unbounded captured host-engine output. Linux workers adopt and reap descendants;
the parent always terminates the owned group and awaits its worker, including
repeated cancellation. macOS cleanup was reviewed but not exercised on macOS.

The four affected TypeScript suites passed: **32 tests**, covering user-account,
ledger/frontdoors, offline runtime and TTS diagnostics. The host Bun wrapper emitted
a read-only cache-directory warning; test execution itself exited 0. No full Bun
suite was attempted. A separate file-and-name-filtered run of
`tests/telegram-client.test.ts` passed **10 affected Python-suite wrappers**,
with four unrelated wrappers filtered out (134 embedded tests, one existing skip).
Both new regression suites are included in normal test discovery. `git diff --check`
is clean. Formal external review, commits, staging and deployment remain
with the main worker. Live provider/voice/call acceptance remains outside this task.
