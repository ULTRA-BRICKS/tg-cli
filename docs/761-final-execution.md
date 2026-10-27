# Call integration final execution — #761 / PR #802

The preserved commits a4b9358, d429e80 and 2281540 are integrated with main25fb691
in `test/761-call-integration-finish`. Configuration schema and Python port changes
are preserved; the executable package version is 1.72.1. Python port packaging metadata is preserved
from main; its version command reads the canonical package.json dynamically.

Audit regressions reproduced configuration/schema writes from plain daemon status
and unrelated failures accepted as killed mutations. The probe uses the supported
`status --dry-run` command. Mutation reports require the baseline and each named
expected scenario signal and expose all nine outcomes in JSON/JUnit.

Focused red/green logs are retained in the private final evidence directory.
Fresh final-source server results and formal review are recorded in the private
`~/.cache/call-integration-final-20261027/` evidence directory; historical reports
checked into this branch do not establish final acceptance. The 35-case file contains 26 classified
integration scenarios, five classified regression scenarios, and four helpers.
There are 20 Python and six Bun regression suites in the default manifest.

Live synthesis remains `--block tts:tool-denied`; dependent calling is blocked.
Telegram writes are not requested. Unsupported two-way conversation stays blocked.
Read-only deployment evidence remains separate from synthetic integration evidence.
The live install is main25fb691 / 1.72.0, so it must fail the branch-equivalence check
until normal merge/deployment. Its offline plan additionally reports missing ffmpeg
and call libraries. No production sessions or secrets are copied to the server.

The staged lint gate required helper extraction in the preserved verifier and process
fixtures. No thresholds, exclusions, hooks or test bounds were changed. The 1.72.1 release section is in CHANGELOG.md; older release sections are preserved
in linked archives to satisfy the existing file-length gate. Python packaging metadata
(`pyproject.toml`, `uv.lock`) is 1.72.1 like `package.json`, as `tests/py/test_version.py` requires.
