"""Check results, JSON/JUnit reports and exit codes.

Statuses are first-class: `blocked` (a capability could not be exercised, with a reason) and
`not_run` are never a pass. The overall result is green only if every PLANNED check passed.
Details are fixed codes or bounded plain data; exception text and credentials never enter a
report (callers pass codes, `clean()` bounds everything else).
"""
import os
import re
from datetime import UTC, datetime
from pathlib import Path
from xml.sax.saxutils import quoteattr

PASS, FAIL, BLOCKED, NOT_RUN = "pass", "fail", "blocked", "not_run"
STATUSES = (PASS, FAIL, BLOCKED, NOT_RUN)
SCOPES = ("fixture", "real")
EXIT_OK, EXIT_FAILED, EXIT_BLOCKED, EXIT_NOT_RUN, EXIT_USAGE = 0, 1, 2, 3, 64
SECRET_SHAPES = re.compile(r"(?i)(api[_-]?key|api[_-]?hash|session|token|password|secret)\s*[=:]\s*\S+")


def utc_now():
    return datetime.now(UTC).strftime("%Y-%m-%dT%H:%M:%SZ")


def clean(value, limit=200):
    """Bounded plain data for evidence: no exception reprs, no secret-looking assignments."""
    if isinstance(value, bool) or value is None or isinstance(value, (int, float)):
        return value
    if isinstance(value, str):
        return SECRET_SHAPES.sub("[redacted]", value)[:limit]
    if isinstance(value, (list, tuple)):
        return [clean(item, limit) for item in list(value)[:50]]
    if isinstance(value, dict):
        return {str(key)[:80]: clean(item, limit) for key, item in list(value.items())[:50]}
    return type(value).__name__


class Check:
    def __init__(self, id, title, capability, scope, depends=()):
        assert scope in SCOPES
        self.id, self.title, self.capability, self.scope = id, title, capability, scope
        self.depends = tuple(depends)
        self.status = NOT_RUN
        self.detail = "not_started"
        self.evidence = {}

    def settle(self, status, detail, **evidence):
        assert status in STATUSES
        self.status, self.detail = status, clean(str(detail), 120)
        self.evidence = clean(evidence)
        return self

    def passed(self, detail="ok", **evidence):
        return self.settle(PASS, detail, **evidence)

    def failed(self, detail, **evidence):
        return self.settle(FAIL, detail, **evidence)

    def blocked(self, detail, **evidence):
        return self.settle(BLOCKED, detail, **evidence)

    def as_dict(self):
        return {"id": self.id, "title": self.title, "capability": self.capability, "scope": self.scope,
                "status": self.status, "detail": self.detail, "evidence": self.evidence,
                "depends_on": list(self.depends)}


def exit_code(checks):
    """0 all passed; 1 any failed; 2 blocked (none failed); 3 not run (none failed/blocked)."""
    statuses = {check.status for check in checks}
    if not checks:
        return EXIT_NOT_RUN
    if FAIL in statuses:
        return EXIT_FAILED
    if BLOCKED in statuses:
        return EXIT_BLOCKED
    if NOT_RUN in statuses:
        return EXIT_NOT_RUN
    return EXIT_OK


def overall(checks):
    return {EXIT_OK: "pass", EXIT_FAILED: "fail", EXIT_BLOCKED: "incomplete_blocked",
            EXIT_NOT_RUN: "incomplete_not_run"}[exit_code(checks)]


def build(metadata, checks, unsupported):
    counts = {status: sum(1 for c in checks if c.status == status) for status in STATUSES}
    return {"schema": 1, "run": metadata, "checks": [c.as_dict() for c in checks],
            "unsupported_capabilities": list(unsupported),
            "summary": {"overall": overall(checks), "exit_code": exit_code(checks), "counts": counts,
                        "total": len(checks)}}


def junit(report):
    """JUnit XML where only `pass` is green: blocked/not_run are errors, never skips."""
    summary, run = report["summary"], report["run"]
    cases = []
    for check in report["checks"]:
        name = quoteattr(check["id"])
        classname = quoteattr(f"verify-calls.{check['capability']}.{check['scope']}")
        body = ""
        if check["status"] == FAIL:
            body = f"<failure type=\"fail\" message={quoteattr(check['detail'])}/>"
        elif check["status"] in (BLOCKED, NOT_RUN):
            body = f"<error type={quoteattr(check['status'])} message={quoteattr(check['detail'])}/>"
        cases.append(f"  <testcase classname={classname} name={name}>{body}</testcase>")
    counts = summary["counts"]
    errors = counts[BLOCKED] + counts[NOT_RUN]
    head = (f"<testsuite name=\"verify-calls\" tests=\"{summary['total']}\" failures=\"{counts[FAIL]}\" "
            f"errors=\"{errors}\" skipped=\"0\" timestamp={quoteattr(run['utc'])}>")
    properties = {"overall": summary["overall"]}
    for source in ("tested", "deployed"):
        for key in ("sha", "code_sha256", "version"):
            properties[f"{source}_{key}"] = run[source].get(key)
    properties["tested_verification_sha256"] = run["tested"].get("verification_sha256")
    props = "  <properties>" + "".join(
        f"<property name={quoteattr(name)} value={quoteattr(str(value))}/>"
        for name, value in properties.items()) + "</properties>"
    return "<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n" + "\n".join([head, props, *cases, "</testsuite>"]) + "\n"


class ReportPathError(Exception):
    """Fixed-code failure writing a requested report; never carries OS error text."""


def write_create_only(path, text):
    """Atomic, private (0600), create-only: never overwrites, follows no symlink, chmods nothing."""
    target = Path(path)
    parent = target.parent
    if os.path.lexists(target):
        raise ReportPathError("REPORT_EXISTS")
    if not parent.is_dir() or parent.is_symlink():
        raise ReportPathError("REPORT_DIRECTORY_INVALID")
    temp = parent / f".{target.name}.{os.getpid()}.tmp"
    try:
        fd = os.open(temp, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
    except OSError:
        raise ReportPathError("REPORT_NOT_WRITABLE") from None
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as out:
            out.write(text)
            out.flush()
            os.fsync(out.fileno())
        try:
            os.link(temp, target)
        except FileExistsError:
            raise ReportPathError("REPORT_EXISTS") from None
        except OSError:
            raise ReportPathError("REPORT_NOT_WRITABLE") from None
    finally:
        try:
            os.unlink(temp)
        except OSError:
            pass
