"""Black-box switch transactions; services and CLI runtimes are hermetic fakes."""

import fcntl
import json
import os
import pathlib
import shutil
import subprocess
import sys
import tempfile
import time
import unittest

from test_switch import Sandbox

FAKE = """#!/usr/bin/env python3
import json, os, pathlib, sys, time
r=pathlib.Path(os.environ['TEST_REPO']); args=sys.argv[1:]; name=pathlib.Path(sys.argv[0]).name
statepath=r/'service.json'; s=json.loads(statepath.read_text())
with open(os.environ['TEST_LOG'],'a') as log:
 log.write(json.dumps(
  [name,args,{k:v for k,v in os.environ.items() if k.startswith('TG_IMPL')}]
 )+'\\n')
def restart():
 s['restarted']=True; s['restarts']=s.get('restarts',0)+1; s['polls']=0
 statepath.write_text(json.dumps(s))
 slot=min(s['restarts'],2)
 (r/'desired').write_text(str(slot) if s.get('successor_lock',True) else '-1')
 deadline=time.monotonic()+2
 while s.get('successor_lock',True) and (r/'ready').read_text()!=str(slot):
  if time.monotonic()>deadline: sys.exit(9)
  time.sleep(.01)
if name=='bun':
 name=pathlib.Path(args.pop(0)).name
if name in ('systemctl','launchctl'):
 if 'restart' in args or 'kickstart' in args:
  restart()
 if '--property=ExecStart' in args:
  print(s.get('effective_exec', '{ path='+str(r/'bin/tg-ctl')+
   ' ; argv[]='+str(r/'bin/tg-ctl')+' run ; ignore_errors=no ; }'))
 elif 'show' in args:
  print((s['pids'][2] if s.get('restarts',0)>1 else s.get('main',s['pids'][1]))
   if s.get('restarted') else s.get('oldmain',s['pids'][0]))
 if 'list' in args: sys.exit(0 if s.get('launchd') else 1)
 sys.exit(0)
if name=='python': sys.exit(s.get('selfcheck_fail',0))
if args and args[0]=='status':
 if not s.get('running',True): print('tg-ctl: not running'); sys.exit(1)
 if s.get('status_fail') and s.get('restarted'): sys.exit(1)
 if s.get('restarted') and s.get('polls',0)<s.get('gap_polls',0):
  s['polls']=s.get('polls',0)+1
  statepath.write_text(json.dumps(s))
  print('tg-ctl: not running'); sys.exit(1)
 old=not s.get('restarted') or s.get('polls',0)<s.get('old_polls',0)
 s['polls']=s.get('polls',0)+1; statepath.write_text(json.dumps(s))
 print('tg-ctl: running (pid %s)' % (s.get('oldpid',s['pids'][0]) if old else
  (s['pids'][2] if s.get('restarts',0)>1 else s.get('newpid',s['pids'][1]))))
 print('impl: '+s.get('impl','ts')+' 1.0.0'); sys.exit(0)
if args and args[0]=='restart':
 restart()
sys.exit(s.get('version_fail',0) if args and args[0] in ('--version','--help') else 0)
"""


FLOCK_WORKER = """import fcntl, os, pathlib, sys, time
lock, control, ready, slot = map(pathlib.Path, sys.argv[1:])
gates = os.environ.get('FLOCK_WORKER_GATES')
def gate(name):
 if gates:
  pathlib.Path(gates, name + '.reached.' + str(slot)).write_text('1')
  while pathlib.Path(gates, name).exists(): time.sleep(.005)
with lock.open('rb') as stream:
 held=False
 while True:
  selected=control.read_text()==str(slot)
  if selected and not held:
   try: fcntl.flock(stream,fcntl.LOCK_EX|fcntl.LOCK_NB); held=True; ready.write_text(str(slot))
   except BlockingIOError: pass
  if held and not selected:
   ready.write_text('-1')
   gate('release')
   fcntl.flock(stream,fcntl.LOCK_UN); held=False
  time.sleep(.005)
"""


def flock_held(path):
    with path.open("rb") as stream:
        try:
            fcntl.flock(stream, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            return True
        fcntl.flock(stream, fcntl.LOCK_UN)
        return False


class ImplTests(Sandbox):
    def setUp(self):
        super().setUp()
        self.env.pop("TG_BOT_TOKEN", None)
        self.lock = self.home / ".config/tg-cli/tg-ctl.123.lock"
        self.lock.parent.mkdir(parents=True)
        self.lock.touch()
        (self.lock.parent / ".env").write_text("TG_BOT_TOKEN=123:fake\n")
        (self.repo / "desired").write_text("0")
        (self.repo / "ready").write_text("")
        worker = FLOCK_WORKER
        self.workers = [
            subprocess.Popen(
                [
                    sys.executable,
                    "-c",
                    worker,
                    str(self.lock),
                    str(self.repo / "desired"),
                    str(self.repo / "ready"),
                    str(slot),
                ]
            )
            for slot in range(3)
        ]
        self.addCleanup(self.close_workers)
        self.wait_slot(0)
        self.settings = {"pids": [process.pid for process in self.workers]}
        self.configure()
        for name in ("bun", "systemctl", "launchctl"):
            self.executable("fakebin/" + name, FAKE)
        for name in ("tg", "tg-ctl", "call-cli", "python"):
            self.executable(".venv/bin/" + name, FAKE)
        (self.repo / "tests/parity/gated.txt").write_text("tg\ncall\ntg-ctl-a\ntg-ctl\n")

    def unrelated_process(self):
        process = subprocess.Popen(["/bin/sleep", "60"])

        def cleanup():
            if process.poll() is None:
                process.terminate()
            process.wait(timeout=3)

        self.addCleanup(cleanup)
        return process

    def close_workers(self):
        for process in self.workers:
            if process.poll() is None:
                process.terminate()
            process.wait(timeout=3)

    def wait_slot(self, slot):
        # -1 is published while the old owner still holds the lock; it only means
        # "no owner" once the lock is actually free.
        deadline = time.monotonic() + 3
        while (self.repo / "ready").read_text() != str(slot) or (
            slot == -1 and flock_held(self.lock)
        ):
            self.assertLess(time.monotonic(), deadline, "flock fixture did not become ready")
            time.sleep(0.01)

    def configure(self, **values):
        if values.get("running") is False:
            (self.repo / "desired").write_text("-1")
            self.wait_slot(-1)
        self.settings.update(values)
        (self.repo / "service.json").write_text(json.dumps(self.settings))

    def impl(self, *args):
        return self.run_command(self.repo / "scripts/tg-impl", *args)

    def selected(self, name):
        return (self.home / ".local/state/tg-cli/impl" / name).read_text().strip()

    def calls(self):
        log = self.home / "log"
        return [json.loads(line) for line in log.read_text().splitlines()] if log.exists() else []

    def unit(self, shim=True):
        path = self.home / ".config/systemd/user/agenttools-tg-ctl-tg-ctl.service"
        path.parent.mkdir(parents=True)
        command = '"%s" run' % (self.repo / "bin/tg-ctl") if shim else "bun /old/tg-ctl run"
        path.write_text("[Service]\nExecStart=" + command + "\n")
        if not shim:
            self.configure(
                effective_exec="{ path=bun ; argv[]=bun /old/tg-ctl run ; ignore_errors=no ; }"
            )

    def assert_ok(self, result):
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)

    def test_impl_status_json(self):
        self.state("call-cli", "py")
        result = self.impl("status", "--json")
        self.assert_ok(result)
        rows = {row["name"]: row for row in json.loads(result.stdout)}
        self.assertEqual(
            rows["tg"],
            {
                "name": "tg",
                "selection": "ts",
                "source": "default",
                "target": str(self.repo / "tg"),
            },
        )
        self.assertEqual(rows["call-cli"]["source"], "state")
        self.assertEqual(rows["call-cli"]["target"], str(self.repo / ".venv/bin/call-cli"))

    def test_impl_status_warns_env_override(self):
        self.env["TG_IMPL_TG"] = "py"
        result = self.impl("status", "--json")
        self.assertIn("TG_IMPL", result.stderr)
        self.assertIn("service", result.stderr)
        self.assertEqual(json.loads(result.stdout)[0]["source"], "env:TG_IMPL_TG")

    def test_impl_use_tg_writes_and_verifies(self):
        self.assert_ok(self.impl("use", "py", "tg"))
        self.assertEqual(self.selected("tg"), "py")
        self.assertIn(["python", ["-m", "tgcli.entry", "--self-check", "tg"], {}], self.calls())

    def test_impl_use_tg_failed_verify_restores(self):
        self.configure(version_fail=1)
        self.assertEqual(self.impl("use", "py", "tg").returncode, 1)
        self.assertEqual(self.selected("tg"), "ts")

    def test_impl_use_call_cli_verifies_help(self):
        self.assert_ok(self.impl("use", "py", "call-cli"))
        self.assertIn(["call-cli", ["--help"], {}], self.calls())

    def test_impl_use_tg_ctl_requires_shim_unit(self):
        self.unit(False)
        result = self.impl("use", "py", "tg-ctl")
        self.assertEqual(result.returncode, 1)
        self.assertIn("tg-ctl enable", result.stderr)

    def test_impl_use_tg_ctl_macos_rig_plist_hint(self):
        self.configure(launchd=True)
        path = self.home / "Library/LaunchAgents/ai.hyperide.tg-ctl.plist"
        path.parent.mkdir(parents=True)
        import plistlib

        path.write_bytes(plistlib.dumps({"ProgramArguments": ["bun", "/old/tg-ctl", "run"]}))
        result = self.impl("use", "py", "tg-ctl")
        self.assertEqual(result.returncode, 1)
        self.assertIn("rig apply", result.stderr)

    def test_impl_use_tg_ctl_restarts_unit(self):
        self.unit()
        self.assert_ok(self.impl("use", "py", "tg-ctl"))
        self.assertIn(
            [
                "systemctl",
                ["--user", "restart", "agenttools-tg-ctl-tg-ctl.service"],
                {},
            ],
            self.calls(),
        )

    def test_impl_use_tg_ctl_impl_mismatch_restores(self):
        self.state("tg-ctl", "py")
        result = self.impl("use", "py", "tg-ctl-daemon")
        self.assertEqual(result.returncode, 1)
        self.assertEqual(self.selected("tg-ctl-daemon"), "ts")

    def test_impl_rollback_never_reselects_py(self):
        self.state("tg-ctl", "py")
        self.configure(status_fail=True)
        self.assertEqual(self.impl("use", "ts", "tg-ctl").returncode, 1)
        self.assertEqual(self.selected("tg-ctl"), "ts")

    def test_impl_waits_for_new_pid(self):
        self.configure(old_polls=2)
        self.assert_ok(self.impl("use", "py", "tg-ctl"))
        self.assertGreaterEqual(sum(c[1][-1:] == ["status"] for c in self.calls()), 4)

    def test_impl_ts_accepts_impl_unknown(self):
        self.configure(impl="unknown")
        self.assert_ok(self.impl("use", "ts", "tg-ctl"))

    def test_impl_stage_a_accepts_impl_unknown(self):
        self.configure(impl="unknown")
        self.assert_ok(self.impl("use", "py", "tg-ctl"))

    def test_impl_restarts_inactive_unit(self):
        self.unit()
        self.configure(oldmain=0)
        self.assert_ok(self.impl("use", "py", "tg-ctl"))
        self.assertTrue(any(c[0] == "systemctl" and "restart" in c[1] for c in self.calls()))
        self.assertFalse(any(c[0] == "tg-ctl" and c[1] == ["restart"] for c in self.calls()))

    def test_impl_stops_stray_before_unit_restart(self):
        process = self.workers[0]
        self.unit()
        self.configure(oldmain=0)
        self.assert_ok(self.impl("use", "py", "tg-ctl"))
        self.assertEqual(process.wait(timeout=2), -15)

    def test_impl_lock_holder_must_be_main_pid(self):
        process = self.workers[1]
        self.unit()
        self.configure(main=self.workers[2].pid)
        self.assertEqual(self.impl("use", "py", "tg-ctl").returncode, 1)
        self.assertEqual(process.wait(timeout=2), -15)
        self.assertEqual(self.selected("tg-ctl"), "ts")

    def test_impl_use_all(self):
        self.configure(running=False)
        self.assert_ok(self.impl("use", "py", "all"))
        self.assertEqual(
            [self.selected(n) for n in ("tg", "call-cli", "tg-ctl", "tg-ctl-daemon")],
            ["py"] * 4,
        )

    def test_impl_refuses_ungated_py(self):
        (self.repo / "tests/parity/gated.txt").unlink()
        self.assertEqual(self.impl("use", "py", "tg").returncode, 1)
        self.assertFalse((self.home / ".local/state/tg-cli/impl/tg").exists())
        self.assert_ok(self.impl("use", "py", "tg", "--ungated"))

    def test_impl_component_mapping(self):
        (self.repo / "tests/parity/gated.txt").write_text("call\ntg-ctl-a\n")
        self.configure(running=False)
        self.assert_ok(self.impl("use", "py", "all"))
        self.assertEqual(self.selected("call-cli"), "py")
        self.assertEqual(self.selected("tg-ctl"), "py")
        self.assertFalse((self.home / ".local/state/tg-cli/impl/tg").exists())
        self.assertEqual(self.impl("use", "py", "tg-ctl-daemon").returncode, 1)
        self.state("tg-ctl-daemon", "py")
        self.assertEqual(self.impl("use", "py", "tg-ctl").returncode, 1)

    def test_impl_does_not_start_stopped_daemon(self):
        self.unit()
        self.configure(running=False)
        result = self.impl("use", "py", "tg-ctl")
        self.assert_ok(result)
        self.assertIn("next start", result.stdout)
        self.assertFalse(any(c[0] in ("systemctl", "launchctl") for c in self.calls()))

    def test_impl_use_ignores_shell_env(self):
        self.env.update(TG_IMPL_TG="py", TG_IMPL="py", TG_IMPL_FUTURE="py")
        (self.repo / ".venv/bin/python").unlink()
        self.assert_ok(self.impl("use", "ts", "tg"))
        self.assertTrue(all(c[2] == {} for c in self.calls()))
        self.assertFalse(any(c[0] == "python" for c in self.calls()))

    def test_impl_use_tg_ctl_without_service_manager(self):
        (self.repo / "fakebin/systemctl").unlink()
        self.env["PATH"] = str(self.repo / "fakebin")
        for name, target in (
            ("python3", sys.executable),
            ("readlink", "/usr/bin/readlink"),
            ("sed", "/usr/bin/sed"),
        ):
            (self.repo / "fakebin" / name).symlink_to(target)
        self.assert_ok(self.impl("use", "py", "tg-ctl"))
        self.assertTrue(any(c[0] == "tg-ctl" and c[1] == ["restart"] for c in self.calls()))

    def test_broken_venv_does_not_block_daemon_rollback(self):
        self.state("tg-ctl", "py")
        (self.repo / ".venv/bin/python").unlink()
        self.assert_ok(self.impl("use", "ts", "tg-ctl"))
        self.assertEqual(self.selected("tg-ctl"), "ts")
        self.assertTrue(any(c[0] == "bun" and c[1][-1:] == ["restart"] for c in self.calls()))

    def test_unknown_status_is_not_treated_as_stopped(self):
        self.executable("fakebin/bun", "#!/bin/sh\necho status-unavailable >&2\nexit 1\n")
        result = self.impl("use", "py", "tg-ctl")
        self.assertEqual(result.returncode, 1)
        self.assertFalse((self.home / ".local/state/tg-cli/impl/tg-ctl").exists())

    def test_missing_handler_dependency_restores_ts(self):
        self.configure(selfcheck_fail=1)
        self.assertEqual(self.impl("use", "py", "tg").returncode, 1)
        self.assertEqual(self.selected("tg"), "ts")

    def test_daemon_python_requires_python_facade(self):
        self.assertEqual(self.impl("use", "py", "tg-ctl-daemon").returncode, 1)
        self.assertFalse((self.home / ".local/state/tg-cli/impl/tg-ctl-daemon").exists())

    def test_service_definition_must_launch_run(self):
        self.unit()
        path = self.home / ".config/systemd/user/agenttools-tg-ctl-tg-ctl.service"
        path.write_text(path.read_text().replace(" run", " --help"))
        executable = str(self.repo / "bin/tg-ctl")
        self.configure(
            effective_exec="{ path="
            + executable
            + " ; argv[]="
            + executable
            + " --help ; ignore_errors=no ; }"
        )
        result = self.impl("use", "py", "tg-ctl")
        self.assertEqual(result.returncode, 1)
        self.assertIn("tg-ctl enable", result.stderr)

    def test_reused_pid_without_lock_survives_and_does_not_start_daemon(self):
        process = self.unrelated_process()
        (self.repo / "desired").write_text("-1")
        self.wait_slot(-1)
        self.unit()
        self.configure(oldpid=process.pid, oldmain=0)
        result = self.impl("use", "py", "tg-ctl")
        self.assert_ok(result)
        self.assertIsNone(process.poll(), result.stderr)
        self.assertFalse(any(c[0] in ("systemctl", "launchctl") for c in self.calls()))
        self.assertIn("next start", result.stdout)

    def test_status_and_mainpid_agreeing_without_lock_cannot_verify(self):
        self.unit()
        self.configure(successor_lock=False)
        result = self.impl("use", "py", "tg-ctl")
        self.assertEqual(result.returncode, 1)
        self.assertEqual(self.selected("tg-ctl"), "ts")
        self.assertIsNone(self.workers[1].poll())

    def test_restart_polls_through_not_running_startup_gap(self):
        self.unit()
        self.configure(gap_polls=2)
        self.assert_ok(self.impl("use", "py", "tg-ctl"))
        self.assertGreaterEqual(sum(c[1][-1:] == ["status"] for c in self.calls()), 4)

    def test_valid_base_wrong_dropin_is_refused_without_manager_calls_when_stopped(
        self,
    ):
        self.unit()
        self.configure(running=False)
        (self.repo / "desired").write_text("-1")
        self.wait_slot(-1)
        path = self.home / ".config/systemd/user/agenttools-tg-ctl-tg-ctl.service.d/override.conf"
        path.parent.mkdir()
        path.write_text("[Service]\nExecStart=\nExecStart=/frozen/tg-ctl run\n")
        result = self.impl("use", "py", "tg-ctl")
        self.assertEqual(result.returncode, 1)
        self.assertIn("tg-ctl enable", result.stderr)
        self.assertFalse(any(c[0] in ("systemctl", "launchctl") for c in self.calls()))

    def test_loaded_wrong_execstart_is_refused(self):
        self.unit()
        self.configure(
            effective_exec=(
                "{ path=/frozen/tg-ctl ; argv[]=/frozen/tg-ctl run ; ignore_errors=no ; }"
            )
        )
        result = self.impl("use", "py", "tg-ctl")
        self.assertEqual(result.returncode, 1)
        self.assertIn("tg-ctl enable", result.stderr)
        self.assertFalse(any("restart" in c[1] for c in self.calls()))

    def lsof_probe(self, records):
        import runpy

        scope = runpy.run_path(str(self.repo / "scripts/tg-impl"))
        self.executable(
            "fakebin/lsof",
            "#!/usr/bin/env python3\nprint(" + repr(records) + ', end="")\n',
        )
        return scope, lambda: scope["lsof_lock_owner"](self.lock, self.lock.stat(), self.env)

    def test_macos_lock_field_proves_owner_without_taking_flock(self):
        from unittest.mock import patch

        stat = self.lock.stat()
        records = f"p{self.workers[0].pid}\nf3\nD0x{stat.st_dev:x}\ni{stat.st_ino}\nlW\n"
        _, probe = self.lsof_probe(records)
        with patch("fcntl.flock", side_effect=AssertionError("status must not acquire a lock")):
            self.assertEqual(probe(), self.workers[0].pid)

    def test_macos_plain_opener_is_not_a_lock_owner(self):
        stat = self.lock.stat()
        records = f"p{self.workers[0].pid}\nf3\nD0x{stat.st_dev:x}\ni{stat.st_ino}\n"
        scope, probe = self.lsof_probe(records)
        with self.assertRaises(scope["VerificationError"]):
            probe()

    def test_macos_wrong_file_write_lock_is_not_accepted(self):
        stat = self.lock.stat()
        records = f"p{self.workers[0].pid}\nf3\nD0x{stat.st_dev:x}\ni{stat.st_ino + 1}\nlW\n"
        scope, probe = self.lsof_probe(records)
        with self.assertRaises(scope["VerificationError"]):
            probe()

    def test_macos_ambiguous_lock_owners_fail_closed(self):
        stat = self.lock.stat()
        records = "".join(
            f"p{process.pid}\nf3\nD0x{stat.st_dev:x}\ni{stat.st_ino}\nlW\n"
            for process in self.workers[:2]
        )
        scope, probe = self.lsof_probe(records)
        with self.assertRaises(scope["VerificationError"]):
            probe()

    def test_kernel_pid_namespace_must_match_identity_not_only_depth(self):
        import runpy
        from types import SimpleNamespace
        from unittest.mock import patch

        scope = runpy.run_path(str(self.repo / "scripts/tg-impl"))
        original = type(self.lock).stat

        def stat(path, *args, **kwargs):
            if str(path) == "/proc/123/ns/pid":
                own = original(type(path)("/proc/self/ns/pid"))
                return SimpleNamespace(st_dev=own.st_dev, st_ino=own.st_ino + 1)
            return original(path, *args, **kwargs)

        with (
            patch.object(type(self.lock), "stat", stat),
            self.assertRaises(scope["VerificationError"]),
        ):
            scope["local_lock_pid"](123)

    def test_running_unit_uses_loaded_config_instead_of_unloaded_disk_change(self):
        self.unit()
        path = self.home / ".config/systemd/user/agenttools-tg-ctl-tg-ctl.service.d/unloaded.conf"
        path.parent.mkdir()
        path.write_text("[Service]\nExecStart=\nExecStart=/unloaded/other run\n")
        self.assert_ok(self.impl("use", "py", "tg-ctl"))

    def test_unowned_successor_pid_is_never_signalled(self):
        process = self.unrelated_process()
        self.unit()
        self.configure(newpid=process.pid, main=self.workers[2].pid)
        self.assertEqual(self.impl("use", "py", "tg-ctl").returncode, 1)
        self.assertIsNone(process.poll())

    def test_stopped_daemon_rejects_spaced_execstart_dropin_without_manager_calls(self):
        self.unit()
        self.configure(running=False)
        path = self.home / ".config/systemd/user/agenttools-tg-ctl-tg-ctl.service.d/override.conf"
        path.parent.mkdir()
        path.write_text("[Service]\nExecStart =\nExecStart = /frozen/tg-ctl run\n")
        result = self.impl("use", "py", "tg-ctl")
        self.assertEqual(result.returncode, 1)
        self.assertIn("tg-ctl enable", result.stderr)
        self.assertFalse(any(c[0] in ("systemctl", "launchctl") for c in self.calls()))

    def test_launchd_explicit_program_cannot_override_shim_arguments(self):
        import plistlib

        path = self.home / "Library/LaunchAgents/ai.hyperide.tg-ctl.plist"
        path.parent.mkdir(parents=True)
        path.write_bytes(
            plistlib.dumps(
                {
                    "Program": "/frozen/bun",
                    "ProgramArguments": [str(self.repo / "bin/tg-ctl"), "run"],
                }
            )
        )
        result = self.impl("use", "py", "tg-ctl")
        self.assertEqual(result.returncode, 1)
        self.assertIn("rig apply", result.stderr)
        self.assertFalse(any("kickstart" in call[1] for call in self.calls()))
        self.assertFalse((self.home / ".local/state/tg-cli/impl/tg-ctl").exists())

    def test_launchd_matching_explicit_program_accepts_shim(self):
        import plistlib

        path = self.home / "Library/LaunchAgents/ai.hyperide.tg-ctl.plist"
        path.parent.mkdir(parents=True)
        shim = str(self.repo / "bin/tg-ctl")
        path.write_bytes(
            plistlib.dumps(
                {
                    "Program": shim,
                    "ProgramArguments": [shim, "run"],
                }
            )
        )
        self.assert_ok(self.impl("use", "py", "tg-ctl"))
        self.assertTrue(any("kickstart" in call[1] for call in self.calls()))


class FlockWorkerHandoffTests(unittest.TestCase):
    """A releasing owner must publish -1 while it still holds the lock.

    Publishing after unlocking lets the next owner's ready=<slot> be overwritten
    with -1, so a restart fake polling for the new slot never sees it (CI run 8785).
    The worker's `release` gate pins the interleaving between the two release steps.
    """

    def start(self, slot, gates):
        return subprocess.Popen(
            [
                sys.executable,
                "-c",
                FLOCK_WORKER,
                str(self.lock),
                str(self.control),
                str(self.ready),
                str(slot),
            ],
            env={**os.environ, "FLOCK_WORKER_GATES": str(gates)},
        )

    def wait_for(self, condition, what):
        deadline = time.monotonic() + 5
        while not condition():
            self.assertLess(time.monotonic(), deadline, what)
            time.sleep(0.005)

    def test_release_publishes_before_unlock_so_next_owner_ready_survives(self):
        root = pathlib.Path(tempfile.mkdtemp())
        self.addCleanup(shutil.rmtree, root, True)
        self.lock, self.control, self.ready = root / "lock", root / "desired", root / "ready"
        gates = root / "gates"
        gates.mkdir()
        self.lock.touch()
        self.control.write_text("0")
        self.ready.write_text("")
        (gates / "release").touch()
        workers = [self.start(slot, gates) for slot in (0, 1)]

        def stop():
            for worker in workers:
                worker.terminate()
            for worker in workers:
                worker.wait(timeout=5)

        self.addCleanup(stop)
        self.wait_for(lambda: self.ready.read_text() == "0", "owner 0 never became ready")

        self.control.write_text("1")
        self.wait_for((gates / "release.reached.0").exists, "owner 0 never reached release")

        # Owner 0 is parked between its two release steps: the successor must not
        # be able to own the lock yet, and -1 must already be published.
        self.assertTrue(flock_held(self.lock), "lock released before -1 was published")
        self.assertEqual(self.ready.read_text(), "-1")

        (gates / "release").unlink()
        self.wait_for(lambda: self.ready.read_text() == "1", "successor never published ready")
        self.wait_for(lambda: flock_held(self.lock), "successor does not hold the lock")
        self.assertEqual(self.ready.read_text(), "1")
