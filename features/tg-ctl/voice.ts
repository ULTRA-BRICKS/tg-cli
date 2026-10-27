// Inbound voice transcription for tg-ctl (STT, speech→text).
//
// A Telegram VOICE note becomes agent INPUT: the daemon downloads the OGG/OPUS,
// transcodes it to WAV 16 kHz mono with ffmpeg, runs a local Whisper, cleans the
// transcript, then routes the text to the SAME pane a typed reply would reach.
//
// Everything here is PURE — no spawns, no fetch, no file I/O. The tg-ctl
// entrypoint owns the ffmpeg/whisper spawns and the download; this module only
// parses the `voice:` config block, builds the ffmpeg + whisper argv, cleans the
// raw whisper stdout, and decides the onboarding state. The `tg` CLI owns the
// interactive `tg voice setup` discovery.

// --- config (the `voice:` block in ~/.config/tg-cli/config.yaml) ---

// Which local Whisper runner the daemon shells out to. 'whisper.cpp' is the
// native arm64 binary (dependency-free, OGG-capable); 'faster-whisper' shells a
// venv python. Default = whisper.cpp once a model+binary is discovered.
export type WhisperRunner = 'whisper.cpp' | 'faster-whisper';

export interface VoiceConfig {
  // Master switch. OFF until `tg voice setup` (or the auto-onboarding) writes a
  // working binary+model — an unconfigured voice note triggers onboarding, it is
  // never silently dropped.
  enabled: boolean;
  runner: WhisperRunner;
  // whisper.cpp: the whisper-cli (or legacy `main`) executable.
  // faster-whisper: the venv python that imports faster_whisper.
  binPath: string;
  // whisper.cpp: a ggml-*.bin model file path.
  // faster-whisper: a model SIZE token ('large-v3-turbo', 'base', …) or a CT2 dir.
  modelPath: string;
  // BCP-47-ish language token or 'auto'. Default 'auto' (ru+en covered).
  language: string;
  // CPU threads. Unset = the physical core count (hyperthreads make Whisper slower).
  // Passed to the built-in faster-whisper script as --threads, so a project
  // transcribe.py that sets it must accept that flag.
  threads?: number;
}

export const DEFAULT_VOICE: VoiceConfig = {
  enabled: false,
  runner: 'whisper.cpp',
  binPath: '',
  modelPath: '',
  language: 'auto',
};

const TRUE_TOKENS = new Set(['true', 'yes', 'on', '1']);
const FALSE_TOKENS = new Set(['false', 'no', 'off', '0']);
const RUNNERS = new Set<string>(['whisper.cpp', 'faster-whisper']);

const unquote = (s: string): string => s.replace(/^["']|["']$/g, '');

// Parse the top-level `voice:` block. Same hand-rolled one-level reader as
// config.ts (parseControlConfig) — no yaml dependency. Anything outside the
// exact `voice:` / `  key: value` shape is ignored.
export function parseVoiceConfig(yaml: string): Partial<VoiceConfig> {
  const out: Partial<VoiceConfig> = {};
  let inVoice = false;
  for (const rawLine of yaml.split('\n')) {
    const line = rawLine.replace(/\s+#.*$/, '');
    if (!line.trim() || line.trim().startsWith('#')) continue;

    const indent = line.length - line.trimStart().length;
    if (indent === 0) {
      inVoice = line.trim().replace(/:.*$/, '') === 'voice';
      continue;
    }
    if (!inVoice) continue;

    const trimmed = line.trim();
    const colon = trimmed.indexOf(':');
    if (colon === -1) continue;
    const key = unquote(trimmed.slice(0, colon).trim());
    const value = trimmed.slice(colon + 1).trim();
    if (!value) continue;

    switch (key) {
      case 'enabled': {
        // Unquote before the token test so a quoted `enabled: "true"` /
        // `enabled: "false"` is honored, not silently ignored — important here
        // because a quoted "false" must still register as the explicit opt-out.
        const v = unquote(value).toLowerCase();
        if (TRUE_TOKENS.has(v)) out.enabled = true;
        else if (FALSE_TOKENS.has(v)) out.enabled = false;
        break;
      }
      case 'runner':
        out.runner = unquote(value) as WhisperRunner; // resolve normalizes garbage
        break;
      case 'bin_path':
        out.binPath = unquote(value);
        break;
      case 'model_path':
        out.modelPath = unquote(value);
        break;
      case 'language':
        out.language = unquote(value);
        break;
      case 'threads': {
        const n = Number(unquote(value));
        if (Number.isInteger(n) && n > 0) out.threads = n;
        break;
      }
    }
  }
  return out;
}

// Merge a parsed partial over the defaults, healing invalid values: a runner
// outside the union → 'whisper.cpp'; an empty language → 'auto'.
export function resolveVoiceConfig(partial: Partial<VoiceConfig>): VoiceConfig {
  const cfg: VoiceConfig = {
    enabled: partial.enabled ?? DEFAULT_VOICE.enabled,
    runner: partial.runner !== undefined && RUNNERS.has(partial.runner) ? partial.runner : DEFAULT_VOICE.runner,
    binPath: partial.binPath ?? DEFAULT_VOICE.binPath,
    modelPath: partial.modelPath ?? DEFAULT_VOICE.modelPath,
    language: (partial.language && partial.language.trim()) || DEFAULT_VOICE.language,
  };
  if (partial.threads !== undefined && Number.isInteger(partial.threads) && partial.threads > 0) {
    cfg.threads = partial.threads;
  }
  return cfg;
}

// Serialize back to the `voice:` config block (for `tg voice setup` to persist).
// Quoted scalars so paths with spaces survive the one-level reader.
export function renderVoiceConfigBlock(cfg: VoiceConfig): string {
  return [
    'voice:',
    `  enabled: ${cfg.enabled ? 'true' : 'false'}`,
    `  runner: ${cfg.runner}`,
    `  bin_path: "${cfg.binPath}"`,
    `  model_path: "${cfg.modelPath}"`,
    `  language: ${cfg.language}`,
    ...(cfg.threads ? [`  threads: ${cfg.threads}`] : []),
    '',
  ].join('\n');
}

// Replace the top-level `voice:` block (and its indented children) in an
// existing config.yaml with a fresh rendering, or append one when absent. Other
// top-level blocks are preserved verbatim. A top-level line has zero leading
// whitespace; the block ends at the next such line (blank lines inside the block
// keep the scan going). Pure — config round-trip is tested through this.
export function upsertVoiceBlock(yaml: string, cfg: VoiceConfig): string {
  const eol = yaml.match(/\r?\n/)?.[0] ?? '\n';
  const block = renderVoiceConfigBlock(cfg).replace(/\n/g, eol);
  // Keep byte offsets into the original text rather than split/join: untouched
  // blocks and comments retain their original (including mixed) line endings.
  const lines = [...yaml.matchAll(/[^\n]*\n|[^\n]+$/g)];
  const startIdx = lines.findIndex((match) => /^voice:\s*$/.test(match[0].replace(/\r?\n$/, '')));
  if (startIdx === -1) {
    const sep = yaml.length === 0 || yaml.endsWith('\n') ? '' : eol;
    return `${yaml}${sep}${block}`;
  }
  let end = yaml.length;
  for (let i = startIdx + 1; i < lines.length; i++) {
    const text = lines[i][0].replace(/\r?\n$/, '');
    if (!text.trim()) continue;
    if (text.length === text.trimStart().length) {
      end = lines[i].index!;
      break;
    }
  }
  return `${yaml.slice(0, lines[startIdx].index!)}${block}${yaml.slice(end)}`;
}

// A voice note is configured iff enabled AND both paths are non-empty. The
// entrypoint additionally checks the files exist on disk before transcribing;
// this is the cheap config-level gate the step function uses to decide whether
// to emit a transcribe action or an onboarding reply.
export function isVoiceConfigured(cfg: VoiceConfig): boolean {
  return cfg.enabled && cfg.binPath.trim() !== '' && cfg.modelPath.trim() !== '';
}

// The configured binary and model are on disk. whisper.cpp's model is always a
// file; a faster-whisper model is EITHER a size token ('large-v3-turbo' —
// downloaded on demand, nothing to check) OR a CT2 directory path, which must
// be complete (ct2ModelComplete) — a dir left by a cut-off download is not a
// model. `managedModelDir` is the dir `tg voice setup` downloads into
// (managedVoicePaths). `exists` is injected so this stays pure; the daemon
// gates every voice note on it, and `tg voice setup` keeps a config that passes it.
export function voiceArtifactsPresent(
  cfg: VoiceConfig,
  exists: (path: string) => boolean,
  managedModelDir: string,
): boolean {
  if (!exists(cfg.binPath)) return false;
  if (cfg.runner === 'whisper.cpp') return exists(cfg.modelPath);
  if (!cfg.modelPath.includes('/')) return true;
  return ct2ModelComplete(cfg.modelPath, exists, managedModelDir);
}

// A CT2 Whisper dir faster-whisper can load: weights, config and the vocabulary
// CTranslate2 needs (vocabulary.json; older conversions ship vocabulary.txt). A
// user's own conversion may lack tokenizer.json (faster-whisper then falls back
// to a hub tokenizer), so only the dir `tg voice setup` downloads — whose repo
// ships one — also needs it: missing there, the download was cut off. Shared by
// the daemon gate, setup's keep decision and the probe, so all meet one bar.
export function ct2ModelComplete(dir: string, exists: (path: string) => boolean, managedModelDir: string): boolean {
  const base = dir.replace(/\/+$/, '');
  return (
    exists(`${base}/model.bin`) &&
    exists(`${base}/config.json`) &&
    (exists(`${base}/vocabulary.json`) || exists(`${base}/vocabulary.txt`)) &&
    (base !== managedModelDir.replace(/\/+$/, '') || exists(`${base}/tokenizer.json`))
  );
}

// --- ffmpeg transcode (OGG/OPUS → WAV 16 kHz mono PCM, what Whisper wants) ---

export function buildFfmpegArgv(inputPath: string, wavPath: string): string[] {
  // -y overwrite, -ar 16000 sample rate, -ac 1 mono, -f wav. -nostdin so a
  // spawned ffmpeg never steals the daemon's stdin. -loglevel error keeps the
  // daemon log clean.
  return [
    'ffmpeg',
    '-nostdin',
    '-loglevel',
    'error',
    '-y',
    '-i',
    inputPath,
    '-ar',
    '16000',
    '-ac',
    '1',
    '-f',
    'wav',
    wavPath,
  ];
}

// --- whisper transcribe argv (runner-specific) ---

// whisper.cpp: emit clean text to STDOUT — `-nt` (no timestamps), `-np` (no
// prints / no banner), language token, `-f <wav>`. We do NOT use `-otxt` (that
// writes a sidecar file); stdout is enough and avoids a temp-file dance.
// `-t`: whisper.cpp defaults to 4 threads; the physical core count (or
// voice.threads) is what the encoder scales with.
export function buildWhisperCppArgv(cfg: VoiceConfig, wavPath: string, physicalCores: number): string[] {
  const threads = String(cfg.threads ?? physicalCores);
  return [cfg.binPath, '-m', cfg.modelPath, '-f', wavPath, '-l', cfg.language, '-t', threads, '-nt', '-np'];
}

// Self-contained faster-whisper transcriber the daemon writes to the config dir
// when the probed venv ships no project script (it rewrites the file when this
// text changes). Reads --input_audio / --model / optional --language and
// --threads, prints plain segment text to stdout (cleanTranscript handles the
// rest). Needs only faster_whisper (+ its ctranslate2), which the venv has by
// definition.
export const FASTER_WHISPER_FALLBACK_SCRIPT = `"""tg-ctl's built-in voice-note transcriber (runner: faster-whisper).

tg-ctl writes this file and runs it per voice note:
  <venv python> tg-faster-whisper.py --input_audio <wav> --model <size|CT2 dir> [--language <code>] [--threads <n>]
and reads plain text from stdout. tg-ctl rewrites it when its built-in copy changes; to
customise, put a transcribe.py in the venv's project dir, which tg-ctl prefers.

Speed (i7-11800H, large-v3-turbo int8, 15 s note: 5.3 s here vs 10.5 s stock):
- Auto language in ONE encoder pass: language=None runs the encoder twice (a separate
  detection pass, then decoding); multilingual=True detects each 30 s window's language
  from the decoding pass's own encoder output.
- CPU: int8 on the physical cores; hyperthreads make it slower.
- NVIDIA GPU: float16 on CUDA, and CPU whenever CUDA fails to load or to decode.
"""

import argparse
import glob
import inspect
import os
import subprocess
import sys

# Seeds the tokenizer only: with multilingual=True every window re-detects its language.
SEED_LANGUAGE = "en"
CUDA_REEXEC_MARK = "TG_VOICE_CUDA_LIBS"


def physical_cores():
    found = None
    if sys.platform == "darwin":
        # perflevel0 = performance cores on Apple Silicon; older Macs only have physicalcpu.
        for key in ("hw.perflevel0.physicalcpu", "hw.physicalcpu"):
            try:
                out = subprocess.run(["sysctl", "-n", key], capture_output=True, text=True, timeout=5)
                found = int(out.stdout)
                break
            except (OSError, ValueError, subprocess.SubprocessError):
                continue
    else:
        try:
            cores, package = set(), None
            with open("/proc/cpuinfo") as cpuinfo:
                for line in cpuinfo:
                    key, _, value = line.partition(":")
                    key = key.strip()
                    if key == "physical id":
                        package = value.strip()
                    elif key == "core id":
                        cores.add((package, value.strip()))
            found = len(cores) or None
        except OSError:
            pass
    try:
        usable = len(os.sched_getaffinity(0))
    except AttributeError:
        usable = os.cpu_count() or 1
    return max(1, min(found or usable, usable))


def cuda_device_count():
    try:
        import ctranslate2

        return ctranslate2.get_cuda_device_count()
    except Exception:
        return 0


def ensure_cuda_libs_on_path():
    # The nvidia-cublas-cu12 / nvidia-cudnn-cu12 wheels put their .so files under
    # site-packages/nvidia/*/lib, which the dynamic loader never searches, and it reads
    # LD_LIBRARY_PATH only at process start: prepend them and re-exec once. Runs before
    # anything imports ctranslate2, so the re-exec costs only an interpreter start.
    if sys.platform != "linux" or os.environ.get(CUDA_REEXEC_MARK):
        return
    wheel_dirs = sorted({d for base in sys.path if base for d in glob.glob(os.path.join(base, "nvidia", "*", "lib"))})
    current = [d for d in os.environ.get("LD_LIBRARY_PATH", "").split(":") if d]
    missing = [d for d in wheel_dirs if d not in current]
    if not missing:
        return
    os.environ["LD_LIBRARY_PATH"] = ":".join(missing + current)
    os.environ[CUDA_REEXEC_MARK] = "1"
    os.execv(sys.executable, [sys.executable, *sys.argv])


def transcribe(model_name, audio, language, threads):
    from faster_whisper import WhisperModel

    auto = language in (None, "", "auto")
    # multilingual= arrived in faster-whisper 1.1; an older venv detects the old way
    # (language=None: a separate detection pass), which is slower but still works.
    one_pass = auto and "multilingual" in inspect.signature(WhisperModel.transcribe).parameters
    options = dict(
        language=SEED_LANGUAGE if one_pass else (None if auto else language),
        beam_size=5,
        vad_filter=True,
        condition_on_previous_text=False,
        without_timestamps=True,
    )
    if one_pass:
        options["multilingual"] = True
    if cuda_device_count() > 0:
        try:
            segments, _ = WhisperModel(model_name, device="cuda", compute_type="float16").transcribe(audio, **options)
            # Decoding is lazy: a missing cuDNN surfaces only while iterating.
            return [segment.text.strip() for segment in segments]
        except Exception as err:  # a broken driver or CUDA libs must not lose the note
            print(f"CUDA failed, transcribing on CPU: {err}", file=sys.stderr)
    model = WhisperModel(model_name, device="cpu", compute_type="int8", cpu_threads=threads)
    segments, _ = model.transcribe(audio, **options)
    return [segment.text.strip() for segment in segments]


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--input_audio", required=True)
    ap.add_argument("--model", default="large-v3-turbo")
    ap.add_argument("--language", default=None)
    ap.add_argument("--threads", type=int, default=None)
    args = ap.parse_args()
    ensure_cuda_libs_on_path()
    threads = args.threads if args.threads and args.threads > 0 else physical_cores()
    for line in transcribe(args.model, args.input_audio, args.language, threads):
        print(line)


if __name__ == "__main__":
    main()
`;

// faster-whisper: run the project's transcriber via the venv python. We pass the
// model size, language and the wav; the script prints `text` lines we then clean.
// The runner script path is derived from the configured python's project dir by
// the entrypoint; here we just assemble the argv given an explicit script path.
// --threads only when voice.threads is set: a project transcribe.py may not
// accept it, and the built-in script finds the physical cores itself.
export function buildFasterWhisperArgv(
  pythonBin: string,
  scriptPath: string,
  cfg: VoiceConfig,
  wavPath: string,
): string[] {
  const argv = [pythonBin, scriptPath, '--input_audio', wavPath, '--model', cfg.modelPath];
  if (cfg.language && cfg.language !== 'auto') argv.push('--language', cfg.language);
  if (cfg.threads) argv.push('--threads', String(cfg.threads));
  return argv;
}

// --- transcript cleaning ---

// whisper.cpp with `-nt -np` still occasionally prefixes a `[blank_audio]`,
// `[silence]`, `(...)` artefact and emits leading/trailing whitespace and
// CR/newlines. faster-whisper's plain `--input_audio` script prints one line per
// segment, sometimes with a `[0.00s -> 1.20s]` timestamp prefix and a leading
// "Detected language ..." banner. This collapses all of that to one clean line.
const TIMESTAMP_PREFIX_RE = /^\s*\[\s*\d+(?:\.\d+)?s?\s*->\s*\d+(?:\.\d+)?s?\s*\]\s*/;
const BRACKET_NOISE_RE = /\[(?:_*blank_*audio_*|silence|music|inaudible|noise|sound)\]/gi;
const PAREN_NOISE_RE = /\((?:blank_?audio|silence|music|inaudible|noise)\)/gi;

export function cleanTranscript(raw: string): string {
  const lines = raw
    .split('\n')
    .map((l) => l.replace(/\r/g, ''))
    // drop faster-whisper's diagnostic banners; keep real segments.
    .filter((l) => !/^\s*(Detected language|Using (CPU|CUDA) device)\b/i.test(l))
    .map((l) => l.replace(TIMESTAMP_PREFIX_RE, ''))
    .map((l) => l.trim())
    .filter((l) => l.length > 0);

  return lines.join(' ').replace(BRACKET_NOISE_RE, ' ').replace(PAREN_NOISE_RE, ' ').replace(/\s+/g, ' ').trim();
}

// Present a transcript as a 🎤-marked quote before it is injected into the agent pane,
// mirroring the `↩ «…»` reply-anchor style. The 🎤 + guillemets tell the agent (and a
// human glancing at the pane) that this is MACHINE-TRANSCRIBED speech — it may carry
// recognition errors and is not text the user typed verbatim — so it is never mistaken
// for a literal instruction string. Pure; the entrypoint wraps the cleaned transcript
// with this before handing it to wrapInbound/the inject plan.
export function formatVoiceTranscript(text: string): string {
  return `🎤 «${text.trim()}»`;
}

// --- onboarding discovery (pure: given probe inputs, decide the verdict) ---

// The host facts that pick a runner and an install plan (voice-probe.ts reads them).
export interface VoiceHost {
  platform: string; // process.platform: 'darwin' | 'linux' | …
  nvidiaGpu: boolean; // an NVIDIA display controller on the PCI bus, driver loaded or not
  brew?: string; // the Homebrew executable, when installed
  uv?: string; // the uv executable, when installed
  installRoot: string; // where setup installs what it downloads (managedVoicePaths)
}

// What the entrypoint/CLI finds when probing the host for a Whisper install.
export interface WhisperProbe {
  // whisper.cpp candidates discovered under ~/xp (or wherever): an executable
  // path that exists and is a file, plus the ggml models found next to it.
  whisperCppBin?: string;
  whisperCppModels?: string[]; // ggml-*.bin paths, real models only
  // faster-whisper candidates: a venv python that imports faster_whisper, the
  // runner script path, and the project's large-v3-turbo CT2 model dir.
  fasterWhisperPython?: string;
  fasterWhisperScript?: string;
  fasterWhisperModelDir?: string;
  ffmpegFound: boolean;
  // Absent = unknown host: no install plan, generic guidance.
  host?: VoiceHost;
}

// One command `tg voice setup` runs (never through a shell).
export interface InstallStep {
  label: string;
  argv: string[];
}

export type OnboardingVerdict =
  | { kind: 'ready'; cfg: VoiceConfig } // a runner+model was found — persist & enable
  | { kind: 'install'; summary: string; steps: InstallStep[] } // `tg voice setup` installs, prebuilt only
  | { kind: 'need-ffmpeg'; hint: string } // ffmpeg is missing and setup cannot install it
  | { kind: 'need-install'; hint: string }; // nothing found, nothing to install with — guide the user

// The configured voice block and whether its binary/model are on disk
// (voiceArtifactsPresent) — what a `tg voice setup` re-run keeps.
export interface CurrentVoice {
  cfg: VoiceConfig;
  present: boolean;
}

// faster-whisper resolves this name to mobiuslabsgmbh/faster-whisper-large-v3-turbo
// (CT2). Turbo = large-v3 with 4 decoder layers instead of 32: near-large-v3
// accuracy at several times the speed.
export const FASTER_WHISPER_DEFAULT_MODEL = 'large-v3-turbo';
// faster-whisper 1.2.1 (latest) passes av.open(metadata_errors=…), which PyAV 16
// removed: every transcription would raise TypeError.
const FASTER_WHISPER_PACKAGES = ['faster-whisper==1.2.1', 'av<16'];
// CTranslate2 4.x on CUDA needs cuBLAS 12 and cuDNN 9; the driver ships neither.
const CUDA_WHEELS = ['nvidia-cublas-cu12', 'nvidia-cudnn-cu12==9.*'];
// Every dependency has a cp312 wheel on macOS arm64/x86_64 and manylinux x86_64/aarch64.
const VENV_PYTHON = '3.12';
const FASTER_WHISPER_DOWNLOAD =
  'import sys; from faster_whisper import download_model; download_model(sys.argv[1], output_dir=sys.argv[2])';
// q8_0: near-lossless against f16 at half the size; Metal runs it as fast.
const WHISPER_CPP_MODEL_FILE = 'ggml-large-v3-turbo-q8_0.bin';
const WHISPER_CPP_MODEL_URL = `https://huggingface.co/ggerganov/whisper.cpp/resolve/main/${WHISPER_CPP_MODEL_FILE}`;

// Where `tg voice setup` installs: one faster-whisper project (uv venv + CT2
// model) and one whisper.cpp models dir. voice-probe.ts scans both roots, so a
// finished install is found like any other.
export function managedVoicePaths(installRoot: string) {
  const fasterWhisperRoot = `${installRoot}/faster-whisper`;
  const whisperCppRoot = `${installRoot}/whisper.cpp`;
  return {
    fasterWhisperRoot,
    venvDir: `${fasterWhisperRoot}/.venv`,
    venvPython: `${fasterWhisperRoot}/.venv/bin/python`,
    fasterWhisperModelDir: `${fasterWhisperRoot}/models/${FASTER_WHISPER_DEFAULT_MODEL}`,
    whisperCppRoot,
    whisperCppModel: `${whisperCppRoot}/models/${WHISPER_CPP_MODEL_FILE}`,
  };
}

// The physical core count from Linux /proc/cpuinfo: distinct (physical id,
// core id) pairs, so SMT siblings count once. Undefined when the kernel prints
// no core ids (most ARM boards) — the caller then uses the logical count.
export function parsePhysicalCores(cpuinfo: string): number | undefined {
  const cores = new Set<string>();
  let pkg = '';
  for (const line of cpuinfo.split('\n')) {
    const [key, value = ''] = line.split(':').map((s) => s.trim());
    if (key === 'physical id') pkg = value;
    else if (key === 'core id') cores.add(`${pkg}/${value}`);
  }
  return cores.size > 0 ? cores.size : undefined;
}

// A PCI function is an NVIDIA GPU: vendor 0x10de, class 0x03xxxx (display
// controller: VGA 0x0300, 3D 0x0302). The card's HDMI audio (0x0403) is not.
export function isNvidiaGpu(vendor: string, pciClass: string): boolean {
  return vendor.trim().toLowerCase() === '0x10de' && pciClass.trim().toLowerCase().startsWith('0x03');
}

// Pick the best model from a list of ggml-*.bin paths. Prefer a real multilingual
// model (large/medium/small without `.en`) over an English-only one over the
// tiny test fixtures, so an auto/ru voice note transcribes correctly. Excludes
// the `for-tests-` fixtures whisper.cpp ships (they are not real weights).
export function pickWhisperCppModel(models: string[]): string | undefined {
  const real = models.filter((m) => !/(^|\/)for-tests-/.test(m));
  if (real.length === 0) return undefined;
  const score = (m: string): number => {
    const base = m.toLowerCase();
    // `.en` as a language segment marks an English-only model. It can be followed
    // by the extension (`ggml-base.en.bin`) OR a quantization/variant suffix
    // (`ggml-medium.en-q5_0.bin`, `ggml-small.en-tdrz.bin`) — match `.en` then a
    // `.` or `-` boundary, not only `.en.bin`.
    const multilingual = !/\.en(?=[.\-])/.test(base);
    let size = 0;
    // Turbo outranks the other large models: near-large-v3 accuracy, several times faster.
    if (base.includes('large')) size = base.includes('turbo') ? 5 : 4;
    else if (base.includes('medium')) size = 3;
    else if (base.includes('small')) size = 2;
    else if (base.includes('base')) size = 1;
    // multilingual is the dominant factor (ru+en default); size breaks ties.
    return (multilingual ? 100 : 0) + size;
  };
  return [...real].sort((a, b) => score(b) - score(a))[0];
}

// The best install the probe found. Linux prefers faster-whisper (CTranslate2
// int8/CUDA: ~6x faster than whisper.cpp on CPU); macOS prefers whisper.cpp
// (Metal — CTranslate2 has no Apple GPU backend).
function foundInstall(probe: WhisperProbe, language: string, threads?: number): VoiceConfig | undefined {
  const wcModel = probe.whisperCppBin ? pickWhisperCppModel(probe.whisperCppModels ?? []) : undefined;
  const whisperCpp: Partial<VoiceConfig> | undefined = wcModel
    ? { runner: 'whisper.cpp', binPath: probe.whisperCppBin, modelPath: wcModel }
    : undefined;
  // faster-whisper needs only the venv python — a project script is preferred
  // but optional, because the daemon writes a generated fallback transcriber
  // script (FASTER_WHISPER_FALLBACK_SCRIPT) when the project ships none. The
  // venv `tg voice setup` installs counts only with its complete model: one cut
  // off mid-download is finished by the install plan (each step resumes).
  const managedVenv = probe.host ? managedVoicePaths(probe.host.installRoot).venvPython : undefined;
  const faster: Partial<VoiceConfig> | undefined =
    probe.fasterWhisperPython && !(probe.fasterWhisperPython === managedVenv && !probe.fasterWhisperModelDir)
      ? {
          runner: 'faster-whisper',
          binPath: probe.fasterWhisperPython,
          modelPath: probe.fasterWhisperModelDir ?? FASTER_WHISPER_DEFAULT_MODEL,
        }
      : undefined;
  const pick = probe.host?.platform === 'linux' ? (faster ?? whisperCpp) : (whisperCpp ?? faster);
  return pick ? resolveVoiceConfig({ ...pick, enabled: true, language, threads }) : undefined;
}

// What `tg voice setup` installs on a host with no usable Whisper — prebuilt
// only: Homebrew bottles, PyPI wheels (--only-binary :all:), model downloads.
// macOS with Homebrew → the whisper.cpp bottle (Metal) + a ggml model; else, on
// macOS or Linux with uv (or Homebrew to install uv) → faster-whisper in a uv
// venv + the CT2 model. Undefined when the host has none of those tools.
function installPlan(probe: WhisperProbe): Extract<OnboardingVerdict, { kind: 'install' }> | undefined {
  const host = probe.host;
  if (!host || (host.platform !== 'darwin' && host.platform !== 'linux')) return undefined;
  const paths = managedVoicePaths(host.installRoot);
  const ffmpeg = probe.ffmpegFound ? [] : ['ffmpeg'];
  const steps: InstallStep[] = [];
  const brewInstall = (bottles: string[]): void => {
    if (host.brew && bottles.length > 0) {
      steps.push({ label: `Homebrew bottles: ${bottles.join(', ')}`, argv: [host.brew, 'install', ...bottles] });
    }
  };

  if (host.platform === 'darwin' && (host.brew || probe.whisperCppBin)) {
    brewInstall([...(probe.whisperCppBin ? [] : ['whisper.cpp']), ...ffmpeg]);
    const part = `${paths.whisperCppModel}.part`;
    steps.push(
      {
        label: `Model ${WHISPER_CPP_MODEL_FILE}`,
        // A stalled transfer (<1 KB/s for 60 s) aborts and is retried; -C - resumes the .part.
        argv: [
          'curl', '-fL', '--retry', '3', '--speed-limit', '1024', '--speed-time', '60', '-C', '-',
          '--create-dirs', '-o', part, WHISPER_CPP_MODEL_URL,
        ],
      },
      { label: 'Model in place', argv: ['mv', part, paths.whisperCppModel] },
    );
    return {
      kind: 'install',
      summary: `whisper.cpp (prebuilt Homebrew bottle, Metal) + ${WHISPER_CPP_MODEL_FILE} (~870 MB) into ${paths.whisperCppRoot}`,
      steps,
    };
  }

  const uv = host.uv ?? (host.brew ? `${host.brew.replace(/\/[^/]*$/, '')}/uv` : undefined);
  if (!uv) return undefined;
  brewInstall([...(host.uv ? [] : ['uv']), ...ffmpeg]);
  const cuda = host.platform === 'linux' && host.nvidiaGpu;
  steps.push(
    { label: `Python ${VENV_PYTHON} venv`, argv: [uv, 'venv', '--python', VENV_PYTHON, '--allow-existing', paths.venvDir] },
    {
      label: cuda ? 'faster-whisper + CUDA wheels' : 'faster-whisper wheels',
      argv: [
        uv, 'pip', 'install', '--python', paths.venvPython, '--only-binary', ':all:',
        ...FASTER_WHISPER_PACKAGES, ...(cuda ? CUDA_WHEELS : []),
      ],
    },
    {
      label: `Model ${FASTER_WHISPER_DEFAULT_MODEL}`,
      argv: [paths.venvPython, '-c', FASTER_WHISPER_DOWNLOAD, FASTER_WHISPER_DEFAULT_MODEL, paths.fasterWhisperModelDir],
    },
  );
  return {
    kind: 'install',
    summary:
      `faster-whisper from prebuilt wheels${cuda ? ' with the CUDA 12 cuBLAS/cuDNN 9 wheels' : ''} in a uv venv` +
      ` + the ${FASTER_WHISPER_DEFAULT_MODEL} model (~1.6 GB) into ${paths.fasterWhisperRoot}`,
    steps,
  };
}

function installHint(host: VoiceHost | undefined): string {
  const then = 'then run `tg voice setup` — it installs a prebuilt Whisper and the large-v3-turbo model (nothing is compiled).';
  if (host?.platform === 'darwin') {
    return `Install Homebrew (https://brew.sh): /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)" — ${then}`;
  }
  if (host?.platform === 'linux') return `Install uv: curl -LsSf https://astral.sh/uv/install.sh | sh — ${then}`;
  return `No local Whisper found. Install Homebrew (macOS) or uv (Linux: curl -LsSf https://astral.sh/uv/install.sh | sh), ${then}`;
}

function ffmpegHint(host: VoiceHost | undefined): string {
  if (host?.platform === 'darwin') return 'brew install ffmpeg';
  if (host?.platform === 'linux') {
    return 'sudo apt install ffmpeg (Debian/Ubuntu) or sudo dnf install ffmpeg (Fedora); with Homebrew, `tg voice setup` installs it';
  }
  return 'install ffmpeg';
}

// Decide the onboarding verdict from a probe + the requested language. Pure, so
// both the auto-prompt (daemon side) and `tg voice setup` (CLI side) share it.
// A configured runner whose files are still there is kept as-is (a re-run must
// not replace a hand-picked model); a stale one is re-detected, keeping
// voice.threads. Nothing found → the platform's install plan, which only the
// CLI runs (the daemon just tells the user to run `tg voice setup`).
export function decideOnboarding(probe: WhisperProbe, language = 'auto', current?: CurrentVoice): OnboardingVerdict {
  const host = probe.host;
  const kept =
    current?.present && current.cfg.binPath !== '' && current.cfg.modelPath !== ''
      ? { ...current.cfg, enabled: true, language }
      : undefined;
  const cfg = kept ?? foundInstall(probe, language, current?.cfg.threads);
  if (cfg) {
    if (probe.ffmpegFound) return { kind: 'ready', cfg };
    if (host?.brew) {
      return {
        kind: 'install',
        summary: 'ffmpeg (prebuilt Homebrew bottle)',
        steps: [{ label: 'Homebrew bottles: ffmpeg', argv: [host.brew, 'install', 'ffmpeg'] }],
      };
    }
    return { kind: 'need-ffmpeg', hint: ffmpegHint(host) };
  }
  const plan = installPlan(probe);
  if (!plan) return { kind: 'need-install', hint: installHint(host) };
  // ffmpeg first: without Homebrew setup cannot install it, so don't download a model yet.
  if (!probe.ffmpegFound && !host?.brew) return { kind: 'need-ffmpeg', hint: ffmpegHint(host) };
  return plan;
}

// An argv as a pasteable shell command (single-quoted where needed).
export function formatCommand(argv: string[]): string {
  return argv.map((a) => (/^[\w@%+=:,./-]+$/.test(a) ? a : `'${a.replace(/'/g, `'\\''`)}'`)).join(' ');
}

// A status glyph for the setup-state line: a green check when configured, a
// hollow circle when still pending. Plain unicode (NOT ANSI) so the SAME string
// is meaningful on both surfaces — a terminal AND the Telegram reply (which
// cannot render escape codes). The CLI TTY path may color these green/yellow
// (colorizeVoiceStatus) without changing the text itself.
export const STATUS_READY = '✓';
export const STATUS_PENDING = '○';

// The reply text the bot sends when an unconfigured voice note arrives, or when
// `tg voice setup` reports its result. Kept here so the message is tested and
// identical on both paths. The FIRST line is an explicit configured-vs-pending
// status (the install-* state principle: green ✓ when configured, ○ when not),
// so the user sees what is done vs pending without having to read the body.
export function onboardingMessage(verdict: OnboardingVerdict): string {
  switch (verdict.kind) {
    case 'ready':
      return [
        `🎙️ ${STATUS_READY} Voice transcription is now configured.`,
        `runner: ${verdict.cfg.runner}`,
        `model: ${verdict.cfg.modelPath}`,
        `language: ${verdict.cfg.language}`,
        'Send a voice note — it will be transcribed and routed to your agent.',
      ].join('\n');
    case 'install':
      return [
        `🎙️ ${STATUS_PENDING} Voice input is not set up yet.`,
        `\`tg voice setup\` installs ${verdict.summary} — prebuilt, nothing is compiled:`,
        ...verdict.steps.map((s) => `  $ ${formatCommand(s.argv)}`),
      ].join('\n');
    case 'need-ffmpeg':
      return [
        `🎙️ ${STATUS_PENDING} \`ffmpeg\` is missing — it converts the voice note for Whisper.`,
        `Install it (${verdict.hint}), then run \`tg voice setup\`.`,
      ].join('\n');
    case 'need-install':
      return [`🎙️ ${STATUS_PENDING} Voice input is not set up yet.`, verdict.hint].join('\n');
  }
}

// Colorize the leading status glyph of an onboardingMessage for terminal display
// ONLY (the `tg voice setup` CLI path). Pure: returns the input unchanged when
// `enabled` is false (a piped CLI run, and ALWAYS the Telegram-reply path, which
// must never carry ANSI). Green for the ✓ ready glyph, yellow for the ○ pending
// glyph — matching the install-* state convention (green done / yellow pending).
// Only the glyph is recolored; the rest of the message stays default.
const ANSI_GREEN = '\x1b[32m';
const ANSI_YELLOW = '\x1b[33m';
const ANSI_RESET = '\x1b[0m';
export function colorizeVoiceStatus(message: string, enabled: boolean): string {
  if (!enabled) return message;
  return message
    .replace(`🎙️ ${STATUS_READY}`, `🎙️ ${ANSI_GREEN}${STATUS_READY}${ANSI_RESET}`)
    .replace(`🎙️ ${STATUS_PENDING}`, `🎙️ ${ANSI_YELLOW}${STATUS_PENDING}${ANSI_RESET}`);
}
