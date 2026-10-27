"""The common suite manifest: one integration (E2E-hermetic) suite plus labeled regressions.

Regressions are existing suites kept in the same entrypoint so one command proves the whole
call surface; they are NOT end-to-end and the runner labels them so in its report.
Cancellation/child-reaping lives in telegram-call-preparation (regression, not re-tested).
"""
from collections import namedtuple

Suite = namedtuple("Suite", "id path kind label requires", defaults=((),))

INTEGRATION = Suite("integration", "tests/telegram-761-call-integration.test.py", "python", "integration", ("bun", "ffmpeg"))

REGRESSION_PYTHON = tuple(
    Suite(name, f"tests/{name}.test.py", "python", "regression") for name in (
        "telegram-client", "telegram-conversation", "telegram-duplex", "telegram-providers",
        "telegram-call-lib", "telegram-user-account", "telegram-call-service", "telegram-call-journal",
        "telegram-cli-hardening", "telegram-call-preparation", "telegram-tts", "telegram-tts-metrics",
        "telegram-761-tts-integration", "telegram-761-watch", "telegram-761-identity",
        "telegram-761-verify-calls", "telegram-761-runner-safety", "telegram-761-probe-contracts", "telegram-761-nested-process",
        "telegram-761-process-bounds",
    ))

REGRESSION_BUN = tuple(
    Suite(name, f"tests/{name}.test.ts", "bun", "regression", ("bun",)) for name in (
        "user-account", "user-call-ledger", "user-call-tts", "user-call-offline-runtime",
        "user-call-audit-warning", "call-lib-adapter",
    ))

GROUPS = {
    "integration": (INTEGRATION,),
    "regression-python": REGRESSION_PYTHON,
    "regression-bun": REGRESSION_BUN,
    "regression-mutations": (Suite("mutation-controls", "tests/support/call_mutation_controls.py", "mutation", "regression", ("bun", "ffmpeg")),),
}
DEFAULT_GROUPS = ("integration", "regression-python", "regression-bun", "regression-mutations")
