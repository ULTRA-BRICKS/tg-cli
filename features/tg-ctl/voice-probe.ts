// Host discovery for inbound voice transcription — the ONE impure module in
// features/tg-ctl/ (it does filesystem I/O and spawns `which`). It locates an
// existing local Whisper install so the user does not have to reinstall what
// `~/xp` (or a previous `tg voice setup`) already has, reads the host facts that
// pick an install plan (OS, NVIDIA GPU, brew, uv), then hands a plain
// `WhisperProbe` to the PURE decideOnboarding() in voice.ts. Kept separate from
// voice.ts precisely so that module stays pure and unit-testable; this one is
// exercised by the voice-setup integration tests and the live setup.

import { existsSync, readdirSync, readFileSync, statSync } from 'fs';
import { availableParallelism } from 'os';
import { join } from 'path';
import {
  ct2ModelComplete,
  FASTER_WHISPER_DEFAULT_MODEL,
  isNvidiaGpu,
  managedVoicePaths,
  parsePhysicalCores,
  type VoiceHost,
  type WhisperProbe,
} from './voice';

function isFile(p: string): boolean {
  try {
    return statSync(p).isFile();
  } catch {
    return false;
  }
}

function isExecutableFile(p: string): boolean {
  if (!isFile(p)) return false;
  try {
    // X_OK = 1. Bun/Node expose constants via fs, but the bit test is simplest.
    return (statSync(p).mode & 0o111) !== 0;
  } catch {
    return false;
  }
}

function onPath(bin: string): string | undefined {
  try {
    const proc = Bun.spawnSync(['which', bin], { stdout: 'pipe', stderr: 'ignore' });
    if (proc.exitCode === 0) {
      const out = proc.stdout.toString().trim();
      if (out) return out;
    }
  } catch {
    // ignore — treated as not found
  }
  return undefined;
}

// whisper.cpp build dirs to probe, most-likely first. The standard build puts
// binaries under build/bin/.
const WHISPER_CPP_BIN_NAMES = ['whisper-cli', 'main'];

function findWhisperCppBin(roots: string[]): string | undefined {
  for (const root of roots) {
    for (const sub of ['build/bin', 'build', '']) {
      for (const name of WHISPER_CPP_BIN_NAMES) {
        const candidate = join(root, sub, name);
        if (isExecutableFile(candidate)) return candidate;
      }
    }
  }
  // The Homebrew bottle is on PATH whenever brew is.
  return onPath('whisper-cli') ?? onPath('whisper.cpp');
}

function findWhisperCppModels(roots: string[]): string[] {
  const out: string[] = [];
  for (const root of roots) {
    const dir = join(root, 'models');
    try {
      for (const entry of readdirSync(dir)) {
        if (entry.startsWith('ggml-') && entry.endsWith('.bin')) {
          out.push(join(dir, entry));
        }
      }
    } catch {
      // no models dir here — keep scanning the other roots
    }
  }
  return out;
}

// Verify the venv python can actually `import faster_whisper`. A bare uv venv
// with the executable present but the package NOT installed must NOT be reported
// as ready — otherwise setup persists an enabled runner that fails every note
// with ModuleNotFoundError instead of staying in onboarding. Short timeout; a
// hang or any nonzero exit counts as "not usable".
function fasterWhisperImportable(python: string): boolean {
  try {
    const r = Bun.spawnSync([python, '-c', 'import faster_whisper'], {
      stdout: 'ignore',
      stderr: 'ignore',
      timeout: 15_000,
    });
    return r.exitCode === 0;
  } catch {
    return false;
  }
}

function findFasterWhisper(
  roots: string[],
  managedModelDir: string,
): { python?: string; script?: string; modelDir?: string } {
  for (const root of roots) {
    const python = join(root, '.venv', 'bin', 'python');
    if (!isExecutableFile(python)) continue;
    // The venv must actually have faster_whisper installed — a bare venv is not
    // a usable runner.
    if (!fasterWhisperImportable(python)) continue;
    // A downloaded large-v3-turbo CT2 model next to the venv (what `tg voice
    // setup` installs) beats the size token, which downloads on the first note.
    // Complete by the same bar as a configured model (ct2ModelComplete), so a
    // cut-off download is finished whether or not it reached config.yaml.
    const modelDir = join(root, 'models', FASTER_WHISPER_DEFAULT_MODEL);
    const complete = ct2ModelComplete(modelDir, isFile, managedModelDir);
    const found = { python, ...(complete ? { modelDir } : {}) };
    // Prefer the project's own transcriber script when present; the entrypoint
    // also ships a generated fallback, but reusing theirs respects their setup.
    // `main.py` is NOT trusted — uv-init ships a "Hello world" main.py that is
    // not a transcriber (the daemon's fasterWhisperScriptPath skips it too).
    for (const name of ['my_faster_whisper.py', 'transcribe.py']) {
      const script = join(root, name);
      if (isFile(script)) return { ...found, script };
    }
    // venv exists + package importable but no project transcriber — report the
    // python alone; the daemon writes a generated fallback script.
    return found;
  }
  return {};
}

// Where `tg voice setup` installs (XDG data dir; NOT ~/.local/share/tg-cli,
// which install.sh owns as the repo checkout).
export function voiceInstallRoot(home: string): string {
  return join(process.env.XDG_DATA_HOME || join(home, '.local', 'share'), 'tg-cli-voice');
}

// Roots to scan, in priority order. ~/xp first (the CTO: "у нас в xp уже есть
// всё, в том числе модель"), then a couple of conventional clone locations,
// then what `tg voice setup` installed.
export function whisperSearchRoots(home: string): { whisperCpp: string[]; fasterWhisper: string[] } {
  const xp = join(home, 'xp');
  const managed = managedVoicePaths(voiceInstallRoot(home));
  return {
    whisperCpp: [
      join(xp, 'whisper.cpp'),
      join(home, 'whisper.cpp'),
      join(home, 'src', 'whisper.cpp'),
      managed.whisperCppRoot,
    ].filter((p) => existsSync(p)),
    fasterWhisper: [join(xp, 'faster-whisper'), join(home, 'faster-whisper'), managed.fasterWhisperRoot].filter((p) =>
      existsSync(p),
    ),
  };
}

// An NVIDIA GPU on the PCI bus. sysfs, not `nvidia-smi`: the card must count
// even while its driver is not loaded (e.g. an unsigned module under Secure
// Boot), so the CUDA wheels are already there once the driver comes up.
function hasNvidiaGpu(): boolean {
  const bus = '/sys/bus/pci/devices';
  try {
    return readdirSync(bus).some((dev) => {
      try {
        return isNvidiaGpu(readFileSync(join(bus, dev, 'vendor'), 'utf8'), readFileSync(join(bus, dev, 'class'), 'utf8'));
      } catch {
        return false;
      }
    });
  } catch {
    return false;
  }
}

function probeHost(home: string): VoiceHost {
  return {
    platform: process.platform,
    nvidiaGpu: process.platform === 'linux' && hasNvidiaGpu(),
    brew: onPath('brew'),
    uv: onPath('uv'),
    installRoot: voiceInstallRoot(home),
  };
}

// Probe the host for a usable local Whisper + ffmpeg. Pure-data result handed to
// the pure decideOnboarding().
export function probeWhisper(home: string): WhisperProbe {
  const roots = whisperSearchRoots(home);
  const host = probeHost(home);
  const fw = findFasterWhisper(roots.fasterWhisper, managedVoicePaths(host.installRoot).fasterWhisperModelDir);
  return {
    whisperCppBin: findWhisperCppBin(roots.whisperCpp),
    whisperCppModels: findWhisperCppModels(roots.whisperCpp),
    fasterWhisperPython: fw.python,
    fasterWhisperScript: fw.script,
    fasterWhisperModelDir: fw.modelDir,
    ffmpegFound: onPath('ffmpeg') !== undefined,
    host,
  };
}

// Physical cores for whisper.cpp's -t (hyperthreads make Whisper slower). On
// Apple Silicon the performance cores only. Capped by the CPUs this process may
// use; falls back to that count when the core topology is unknown. Memoized —
// the daemon asks once per voice note.
let physicalCoreCount: number | undefined;
export function physicalCores(): number {
  if (physicalCoreCount !== undefined) return physicalCoreCount;
  let found: number | undefined;
  if (process.platform === 'darwin') {
    for (const key of ['hw.perflevel0.physicalcpu', 'hw.physicalcpu']) {
      const n = Number(Bun.spawnSync(['sysctl', '-n', key], { stdout: 'pipe', stderr: 'ignore' }).stdout.toString().trim());
      if (Number.isInteger(n) && n > 0) {
        found = n;
        break;
      }
    }
  } else {
    try {
      found = parsePhysicalCores(readFileSync('/proc/cpuinfo', 'utf8'));
    } catch {
      // no /proc (not Linux) — the logical count below
    }
  }
  const usable = availableParallelism();
  physicalCoreCount = Math.max(1, Math.min(found ?? usable, usable));
  return physicalCoreCount;
}
