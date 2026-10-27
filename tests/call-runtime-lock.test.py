"""Offline regression for #761's unsatisfiable call runtime lock.

Run directly with Python and packaging (also pinned in the call runtime).
Frozen Requires-Dist constraints come from PyPI wheel metadata; this checks
compatibility without importing providers or contacting Telegram. The opt-in
resolver check requires package-index access or an already populated uv cache.
"""

import os
from pathlib import Path
import subprocess
import sys
import unittest

from packaging.requirements import Requirement


ROOT = Path(__file__).resolve().parents[1]
# https://pypi.org/pypi/aiohttp/3.14.4/json
# https://pypi.org/pypi/yarl/1.25.1/json
METADATA = {
    ("aiohttp", "3.14.4"): (
        "aiohappyeyeballs>=2.5.0", "aiosignal>=1.4.0", "attrs>=17.3.0",
        "frozenlist>=1.1.1", "multidict>=4.5,<7.0", "propcache>=0.2.0",
        "typing-extensions>=4.4; python_full_version<'3.13'",
        "async-timeout>=4.0,<6.0; python_full_version<'3.11'",
        "yarl>=1.25.1,<2.0",
    ),
    ("yarl", "1.25.1"): ("idna>=2.0", "multidict>=4.0", "propcache>=0.2.1"),
}


def read_pins():
    pins = {}
    for line in (ROOT / "requirements-call.txt").read_text().splitlines():
        if not line.strip() or line.startswith("#"):
            continue
        requirement = Requirement(line.split(" --hash=")[0])
        specifiers = list(requirement.specifier)
        if len(specifiers) != 1 or specifiers[0].operator != "==":
            raise AssertionError(f"unfrozen requirement: {requirement}")
        pins[requirement.name] = specifiers[0].version
    return pins


class CallRuntimeLockTests(unittest.TestCase):
    def test_frozen_dependency_constraints(self):
        pins = read_pins()
        for (name, version), dependencies in METADATA.items():
            self.assertEqual(pins[name], version, f"refresh frozen metadata for {name}")
            for python_version in ("3.12.0", "3.13.16", "3.14.4"):
                environment = {"python_full_version": python_version,
                               "python_version": python_version.rsplit(".", 1)[0]}
                for dependency in dependencies:
                    requirement = Requirement(dependency)
                    if requirement.marker and not requirement.marker.evaluate(environment):
                        continue
                    with self.subTest(package=name, python=python_version, dependency=dependency):
                        self.assertIn(requirement.name, pins)
                        self.assertIn(pins[requirement.name], requirement.specifier)

    def test_reported_old_pin_violates_published_constraint(self):
        constraint = Requirement(METADATA[("aiohttp", "3.14.4")][-1]).specifier
        for version in ("1.23.0", "1.25.0", "2.0.0"):
            self.assertNotIn(version, constraint)
        self.assertIn("1.25.1", constraint)

    @unittest.skipUnless(os.environ.get("CALL_RUNTIME_LOCK_RESOLVE") == "1",
                         "opt-in: needs uv and package-index metadata")
    def test_real_hash_required_resolver(self):
        result = subprocess.run(
            ["uv", "pip", "install", "--dry-run", "--reinstall", "--require-hashes",
             "--default-index", "https://pypi.org/simple",
             "--python", os.environ.get("CALL_RUNTIME_LOCK_PYTHON", sys.executable),
             "-r", str(ROOT / "requirements-call.txt")],
            text=True, capture_output=True, timeout=120,
        )
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)


if __name__ == "__main__":
    unittest.main()
