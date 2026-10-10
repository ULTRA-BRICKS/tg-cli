// Host discovery for inbound voice transcription — the ONE impure module in
// features/tg-ctl/ (it does filesystem I/O and spawns `which`). It locates an
// existing local Whisper install so the user does not have to reinstall what
// `~/xp` already has, then hands a plain `WhisperProbe` to the PURE
// decideOnboarding() in voice.ts. Kept separate from voice.ts precisely so that
// module stays pure and unit-testable; this one is exercised by the live setup.

import { existsSync, readdirSync, statSync } from 'fs';
import { join } from 'path';
import { PROBE_SPAWN } from '../util/spawn-timeout';
import type { WhisperProbe } from './voice';

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
    const proc = Bun.spawnSync(['which', bin], { stdout: 'pipe', stderr: 'ignore', ...PROBE_SPAWN });
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

function findFasterWhisper(roots: string[]): { python?: string; script?: string } {
  for (const root of roots) {
    const python = join(root, '.venv', 'bin', 'python');
    if (!isExecutableFile(python)) continue;
    // The venv must actually have faster_whisper installed — a bare venv is not
    // a usable runner.
    if (!fasterWhisperImportable(python)) continue;
    // Prefer the project's own transcriber script when present; the entrypoint
    // also ships a generated fallback, but reusing theirs respects their setup.
    // `main.py` is NOT trusted — uv-init ships a "Hello world" main.py that is
    // not a transcriber (the daemon's fasterWhisperScriptPath skips it too).
    for (const name of ['my_faster_whisper.py', 'transcribe.py']) {
      const script = join(root, name);
      if (isFile(script)) return { python, script };
    }
    // venv exists + package importable but no project transcriber — report the
    // python alone; the daemon writes a generated fallback script.
    return { python };
  }
  return {};
}

// Roots to scan, in priority order. ~/xp first (the CTO: "у нас в xp уже есть
// всё, в том числе модель"), then a couple of conventional clone locations.
export function whisperSearchRoots(home: string): { whisperCpp: string[]; fasterWhisper: string[] } {
  const xp = join(home, 'xp');
  return {
    whisperCpp: [join(xp, 'whisper.cpp'), join(home, 'whisper.cpp'), join(home, 'src', 'whisper.cpp')].filter((p) =>
      existsSync(p),
    ),
    fasterWhisper: [join(xp, 'faster-whisper'), join(home, 'faster-whisper')].filter((p) => existsSync(p)),
  };
}

// Probe the host for a usable local Whisper + ffmpeg. Pure-data result handed to
// the pure decideOnboarding().
export function probeWhisper(home: string): WhisperProbe {
  const roots = whisperSearchRoots(home);
  const whisperCppBin = findWhisperCppBin(roots.whisperCpp);
  const whisperCppModels = findWhisperCppModels(roots.whisperCpp);
  const fw = findFasterWhisper(roots.fasterWhisper);
  return {
    whisperCppBin,
    whisperCppModels,
    fasterWhisperPython: fw.python,
    fasterWhisperScript: fw.script,
    ffmpegFound: onPath('ffmpeg') !== undefined,
  };
}
