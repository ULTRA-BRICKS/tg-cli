// `tg voice setup` per platform (tg-cli#711): which runner a host gets, the prebuilt-only install
// plan it runs, a re-run keeping the user's working config, the thread count, and the behaviour of
// the built-in faster-whisper script (run against stub faster_whisper/ctranslate2 modules).
import { expect, test } from 'bun:test';
import { mkdirSync, readFileSync, writeFileSync } from 'fs';
import { cpus } from 'os';
import { join } from 'path';
import {
  decideOnboarding,
  FASTER_WHISPER_FALLBACK_SCRIPT,
  isNvidiaGpu,
  managedVoicePaths,
  onboardingMessage,
  parsePhysicalCores,
  parseVoiceConfig,
  renderVoiceConfigBlock,
  pickWhisperCppModel,
  resolveVoiceConfig,
  voiceArtifactsPresent,
  type OnboardingVerdict,
  type VoiceConfig,
  type VoiceHost,
  type WhisperProbe,
} from '../features/tg-ctl/voice';
import { tempDir } from './helpers/test-temp';

const ROOT = '/home/u/.local/share/tg-cli-voice';
const paths = managedVoicePaths(ROOT);

const MAC: VoiceHost = { platform: 'darwin', nvidiaGpu: false, brew: '/opt/homebrew/bin/brew', installRoot: ROOT };
const LINUX: VoiceHost = { platform: 'linux', nvidiaGpu: false, uv: '/usr/bin/uv', installRoot: ROOT };
const LINUX_GPU: VoiceHost = { ...LINUX, nvidiaGpu: true };

const install = (v: OnboardingVerdict): Extract<OnboardingVerdict, { kind: 'install' }> => {
  if (v.kind !== 'install') throw new Error(`expected an install plan, got ${JSON.stringify(v)}`);
  return v;
};
const ready = (v: OnboardingVerdict): VoiceConfig => {
  if (v.kind !== 'ready') throw new Error(`expected ready, got ${JSON.stringify(v)}`);
  return v.cfg;
};
const argvs = (v: OnboardingVerdict): string[][] => install(v).steps.map((s) => s.argv);

// --- config: voice.threads ---

test('voice.threads round-trips; a non-positive or non-numeric value is dropped', () => {
  const cfg = resolveVoiceConfig({ enabled: true, runner: 'whisper.cpp', binPath: '/b', modelPath: '/m', threads: 6 });
  expect(resolveVoiceConfig(parseVoiceConfig(renderVoiceConfigBlock(cfg)))).toEqual(cfg);
  for (const bad of ['0', '-2', 'many', '2.5']) {
    expect(resolveVoiceConfig(parseVoiceConfig(`voice:\n  threads: ${bad}\n`)).threads).toBeUndefined();
  }
  expect(renderVoiceConfigBlock(resolveVoiceConfig({}))).not.toContain('threads');
});

// --- host facts ---

test('parsePhysicalCores counts distinct cores, not hyperthreads', () => {
  const block = (cpu: number, pkg: number, core: number): string =>
    `processor\t: ${cpu}\nphysical id\t: ${pkg}\ncore id\t\t: ${core}\n`;
  // 2 packages × 2 cores × 2 threads = 8 logical CPUs, 4 physical cores.
  const cpuinfo = [
    block(0, 0, 0), block(1, 0, 1), block(2, 1, 0), block(3, 1, 1),
    block(4, 0, 0), block(5, 0, 1), block(6, 1, 0), block(7, 1, 1),
  ].join('\n');
  expect(parsePhysicalCores(cpuinfo)).toBe(4);
  // ARM kernels print no core ids — the caller falls back to the logical count.
  expect(parsePhysicalCores('processor\t: 0\nBogoMIPS\t: 48.00\n')).toBeUndefined();
});

test('isNvidiaGpu: an NVIDIA display controller counts, its HDMI audio function does not', () => {
  expect(isNvidiaGpu('0x10de', '0x030000')).toBe(true); // VGA
  expect(isNvidiaGpu('0x10de', '0x030200')).toBe(true); // 3D controller (headless datacenter cards)
  expect(isNvidiaGpu('0x10de', '0x040300')).toBe(false); // the card's audio function
  expect(isNvidiaGpu('0x8086', '0x030000')).toBe(false); // Intel iGPU
});

test('voiceArtifactsPresent: binary must exist; a CT2 dir must be loadable, a faster-whisper size token need not exist', () => {
  const on = new Set([
    '/py', '/m.bin',
    '/ct2/model.bin', '/ct2/config.json', '/ct2/vocabulary.json', // a user's conversion: no tokenizer.json
    '/old/model.bin', '/old/config.json', '/old/vocabulary.txt',
    '/cut/model.bin', // config.json never arrived
    '/novocab/model.bin', '/novocab/config.json', '/novocab/tokenizer.json', // vocabulary never arrived
    '/m/model.bin', '/m/config.json', '/m/vocabulary.json', // setup's own dir: tokenizer never arrived
  ]);
  const exists = (p: string): boolean => on.has(p);
  const present = (cfg: VoiceConfig): boolean => voiceArtifactsPresent(cfg, exists, '/m');
  const fw: VoiceConfig = { enabled: true, runner: 'faster-whisper', binPath: '/py', modelPath: 'large-v3-turbo', language: 'auto' };
  expect(present(fw)).toBe(true);
  expect(present({ ...fw, modelPath: '/ct2' })).toBe(true);
  expect(present({ ...fw, modelPath: '/ct2/' })).toBe(true);
  expect(present({ ...fw, modelPath: '/old' })).toBe(true); // older conversion: vocabulary.txt
  expect(present({ ...fw, modelPath: '/cut' })).toBe(false);
  expect(present({ ...fw, modelPath: '/novocab' })).toBe(false);
  expect(present({ ...fw, modelPath: '/m' })).toBe(false); // setup downloads a tokenizer; missing = cut off
  expect(present({ ...fw, modelPath: '/gone' })).toBe(false);
  expect(present({ ...fw, binPath: '/nope' })).toBe(false);
  const wc: VoiceConfig = { ...fw, runner: 'whisper.cpp', binPath: '/m.bin', modelPath: 'ggml.bin' };
  expect(present(wc)).toBe(false); // whisper.cpp model is always a file
});

// --- re-run keeps the user's working config ---

const USER_CFG: VoiceConfig = {
  enabled: true,
  runner: 'faster-whisper',
  binPath: '/home/u/xp/faster-whisper/.venv/bin/python',
  modelPath: '/home/u/xp/faster-whisper/models/large-v3-turbo',
  language: 'auto',
  threads: 6,
};

test('a re-run keeps a configured runner/bin_path/model_path whose files exist, whatever the probe finds', () => {
  const probe: WhisperProbe = {
    whisperCppBin: '/opt/homebrew/bin/whisper-cli',
    whisperCppModels: ['/x/ggml-large-v3.bin'],
    ffmpegFound: true,
    host: MAC,
  };
  const cfg = ready(decideOnboarding(probe, 'auto', { cfg: { ...USER_CFG, enabled: false }, present: true }));
  expect(cfg).toEqual(USER_CFG); // re-enabled, nothing else touched
});

test('a configured install whose files are gone is re-detected; voice.threads survives', () => {
  const probe: WhisperProbe = {
    fasterWhisperPython: paths.venvPython,
    fasterWhisperModelDir: paths.fasterWhisperModelDir,
    ffmpegFound: true,
    host: LINUX,
  };
  const cfg = ready(decideOnboarding(probe, 'ru', { cfg: USER_CFG, present: false }));
  expect(cfg.binPath).toBe(paths.venvPython);
  expect(cfg.language).toBe('ru');
  expect(cfg.threads).toBe(6);
});

test('a setup-installed venv without its complete model is finished, not configured with a size token', () => {
  const steps = argvs(decideOnboarding({ fasterWhisperPython: paths.venvPython, ffmpegFound: true, host: LINUX }));
  expect(steps.at(-1)?.slice(-2)).toEqual(['large-v3-turbo', paths.fasterWhisperModelDir]);
});

// --- found installs ---

test('a found faster-whisper defaults to large-v3-turbo, or the turbo CT2 dir it ships', () => {
  const probe: WhisperProbe = { fasterWhisperPython: '/xp/fw/.venv/bin/python', ffmpegFound: true, host: LINUX };
  expect(ready(decideOnboarding(probe)).modelPath).toBe('large-v3-turbo');
  const withDir = { ...probe, fasterWhisperModelDir: '/xp/fw/models/large-v3-turbo' };
  expect(ready(decideOnboarding(withDir)).modelPath).toBe('/xp/fw/models/large-v3-turbo');
});

test('Linux prefers a found faster-whisper over a found whisper.cpp; macOS the reverse (Metal)', () => {
  const both: WhisperProbe = {
    whisperCppBin: '/wc/whisper-cli',
    whisperCppModels: ['/wc/models/ggml-large-v3-turbo-q8_0.bin'],
    fasterWhisperPython: '/fw/.venv/bin/python',
    ffmpegFound: true,
  };
  expect(ready(decideOnboarding({ ...both, host: LINUX })).runner).toBe('faster-whisper');
  expect(ready(decideOnboarding({ ...both, host: MAC })).runner).toBe('whisper.cpp');
});

test('a found Whisper without ffmpeg: brew installs the ffmpeg bottle, else the exact command is shown', () => {
  const probe: WhisperProbe = { fasterWhisperPython: '/fw/.venv/bin/python', ffmpegFound: false };
  expect(argvs(decideOnboarding({ ...probe, host: { ...LINUX, brew: '/hb/bin/brew' } }))).toEqual([
    ['/hb/bin/brew', 'install', 'ffmpeg'],
  ]);
  const linux = decideOnboarding({ ...probe, host: LINUX });
  expect(linux.kind).toBe('need-ffmpeg');
  if (linux.kind === 'need-ffmpeg') expect(linux.hint).toContain('apt install ffmpeg');
});

// --- nothing installed: macOS ---

test('macOS + Homebrew installs the whisper.cpp bottle and downloads ggml large-v3-turbo', () => {
  const steps = argvs(decideOnboarding({ ffmpegFound: true, host: MAC }));
  expect(steps[0]).toEqual(['/opt/homebrew/bin/brew', 'install', 'whisper.cpp']);
  const curl = steps.find((a) => a[0] === 'curl')!;
  expect(curl).toContain('https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-large-v3-turbo-q8_0.bin');
  // downloaded to a .part file and moved into place only when complete
  expect(steps.at(-1)).toEqual(['mv', `${paths.whisperCppModel}.part`, paths.whisperCppModel]);
});

test('macOS + Homebrew without ffmpeg installs both bottles in one brew call', () => {
  expect(argvs(decideOnboarding({ ffmpegFound: false, host: MAC }))[0]).toEqual([
    '/opt/homebrew/bin/brew', 'install', 'whisper.cpp', 'ffmpeg',
  ]);
});

test('macOS with whisper-cli already installed only downloads the model', () => {
  const steps = argvs(decideOnboarding({ whisperCppBin: '/opt/homebrew/bin/whisper-cli', ffmpegFound: true, host: MAC }));
  expect(steps.some((a) => a.includes('install'))).toBe(false);
  expect(steps.some((a) => a[0] === 'curl')).toBe(true);
});

test('macOS without Homebrew but with uv gets CPU faster-whisper (no CUDA wheels)', () => {
  const steps = argvs(decideOnboarding({ ffmpegFound: true, host: { ...MAC, brew: undefined, uv: '/u/uv' } }));
  expect(steps[0][0]).toBe('/u/uv');
  expect(steps.flat().some((a) => a.startsWith('nvidia-'))).toBe(false);
});

test('macOS with neither Homebrew nor uv prints the Homebrew install command, never a source build', () => {
  const v = decideOnboarding({ ffmpegFound: true, host: { ...MAC, brew: undefined } });
  expect(v.kind).toBe('need-install');
  if (v.kind === 'need-install') {
    expect(v.hint).toContain('https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh');
    expect(v.hint).not.toMatch(/\bbuild\b|cmake|make /i);
  }
});

// --- nothing installed: Linux ---

test('Linux + uv installs faster-whisper from wheels only, then downloads the turbo CT2 model', () => {
  const steps = argvs(decideOnboarding({ ffmpegFound: true, host: LINUX }));
  expect(steps[0]).toEqual(['/usr/bin/uv', 'venv', '--python', '3.12', '--allow-existing', paths.venvDir]);
  const pip = steps[1];
  expect(pip.slice(0, 4)).toEqual(['/usr/bin/uv', 'pip', 'install', '--python']);
  expect(pip).toContain(paths.venvPython);
  expect(pip.slice(pip.indexOf('--only-binary'), pip.indexOf('--only-binary') + 2)).toEqual(['--only-binary', ':all:']);
  expect(pip).toEqual(expect.arrayContaining(['faster-whisper==1.2.1', 'av<16']));
  expect(pip.some((a) => a.startsWith('nvidia-'))).toBe(false);
  const download = steps[2];
  expect(download[0]).toBe(paths.venvPython);
  expect(download.slice(-2)).toEqual(['large-v3-turbo', paths.fasterWhisperModelDir]);
});

test('Linux with an NVIDIA GPU adds the CUDA 12 cuBLAS + cuDNN 9 wheels', () => {
  const pip = argvs(decideOnboarding({ ffmpegFound: true, host: LINUX_GPU }))[1];
  expect(pip).toEqual(expect.arrayContaining(['nvidia-cublas-cu12', 'nvidia-cudnn-cu12==9.*']));
});

test('Linux without uv but with Homebrew installs the uv bottle first', () => {
  const steps = argvs(decideOnboarding({ ffmpegFound: true, host: { ...LINUX, uv: undefined, brew: '/hb/bin/brew' } }));
  expect(steps[0]).toEqual(['/hb/bin/brew', 'install', 'uv']);
  expect(steps[1][0]).toBe('/hb/bin/uv');
});

test('Linux with neither uv nor Homebrew prints the uv installer command', () => {
  const v = decideOnboarding({ ffmpegFound: true, host: { ...LINUX, uv: undefined } });
  expect(v.kind).toBe('need-install');
  if (v.kind === 'need-install') expect(v.hint).toContain('curl -LsSf https://astral.sh/uv/install.sh | sh');
});

test('Linux without ffmpeg or Homebrew asks for ffmpeg before downloading anything', () => {
  const v = decideOnboarding({ ffmpegFound: false, host: LINUX });
  expect(v.kind).toBe('need-ffmpeg');
});

test('no install plan step ever compiles', () => {
  const hosts: VoiceHost[] = [MAC, LINUX, LINUX_GPU, { ...LINUX, uv: undefined, brew: '/hb/bin/brew' }];
  for (const host of hosts) {
    for (const ffmpegFound of [true, false]) {
      const v = decideOnboarding({ ffmpegFound, host });
      if (v.kind !== 'install') continue;
      for (const { argv } of v.steps) expect(argv.join(' ')).not.toMatch(/cmake|\bmake\b|--build|no-binary/);
    }
  }
});

test('the install verdict tells the user what `tg voice setup` will run', () => {
  const v = decideOnboarding({ ffmpegFound: true, host: LINUX });
  const msg = onboardingMessage(v);
  expect(msg).toContain('tg voice setup');
  expect(msg).toContain('faster-whisper==1.2.1');
  expect(msg).toContain("'av<16'"); // shell-quoted, so it can be pasted
});

// --- the built-in faster-whisper script (stub modules record what it asks for) ---

const STUB_CTRANSLATE2 = `import os
def get_cuda_device_count():
    return int(os.environ.get("FAKE_CUDA_DEVICES", "0"))
`;

const STUB_FASTER_WHISPER = `import json, os

def _record(event):
    with open(os.environ["FAKE_RECORD"], "a") as f:
        f.write(json.dumps(event) + "\\n")

class _Segment:
    def __init__(self, text):
        self.text = text

class _Model:
    def __init__(self, model, **kwargs):
        _record({"event": "load", "model": model, "ld_library_path": os.environ.get("LD_LIBRARY_PATH", ""), **kwargs})
        if kwargs.get("device") == "cuda" and os.environ.get("FAKE_CUDA_FAIL") == "load":
            raise RuntimeError("CUDA driver version is insufficient")
        self.device = kwargs.get("device")

    def _decode(self, audio, options):
        _record({"event": "transcribe", "device": self.device, "audio": audio, **options})
        device = self.device

        def segments():
            if device == "cuda" and os.environ.get("FAKE_CUDA_FAIL") == "decode":
                raise RuntimeError("Unable to load libcudnn_ops.so.9")
            yield _Segment(" привет ")
            yield _Segment("world")

        return segments(), None

class _Current(_Model):  # faster-whisper >= 1.1
    def transcribe(self, audio, language=None, multilingual=False, beam_size=5, vad_filter=False,
                   condition_on_previous_text=True, without_timestamps=False):
        return self._decode(audio, dict(language=language, multilingual=multilingual, beam_size=beam_size,
                                        vad_filter=vad_filter, condition_on_previous_text=condition_on_previous_text,
                                        without_timestamps=without_timestamps))

class _Legacy(_Model):  # faster-whisper < 1.1: no multilingual parameter
    def transcribe(self, audio, language=None, beam_size=5, vad_filter=False,
                   condition_on_previous_text=True, without_timestamps=False):
        return self._decode(audio, dict(language=language, beam_size=beam_size, vad_filter=vad_filter,
                                        condition_on_previous_text=condition_on_previous_text,
                                        without_timestamps=without_timestamps))

WhisperModel = _Legacy if os.environ.get("FAKE_LEGACY_API") else _Current
`;

type ScriptRun = { exitCode: number; stdout: string; stderr: string; events: Array<Record<string, unknown>> };

function runScript(args: string[], env: Record<string, string> = {}, withCudaWheels = false): ScriptRun {
  const dir = tempDir('tg-voice-script-');
  const site = join(dir, 'site');
  mkdirSync(join(site, 'faster_whisper'), { recursive: true });
  mkdirSync(join(site, 'ctranslate2'), { recursive: true });
  writeFileSync(join(site, 'faster_whisper', '__init__.py'), STUB_FASTER_WHISPER);
  writeFileSync(join(site, 'ctranslate2', '__init__.py'), STUB_CTRANSLATE2);
  if (withCudaWheels) {
    mkdirSync(join(site, 'nvidia', 'cudnn', 'lib'), { recursive: true });
    mkdirSync(join(site, 'nvidia', 'cublas', 'lib'), { recursive: true });
  }
  const script = join(dir, 'tg-faster-whisper.py');
  writeFileSync(script, FASTER_WHISPER_FALLBACK_SCRIPT);
  const record = join(dir, 'record.jsonl');
  writeFileSync(record, '');
  const proc = Bun.spawnSync(['python3', script, '--input_audio', '/a.wav', '--model', 'large-v3-turbo', ...args], {
    env: { PATH: process.env.PATH ?? '', PYTHONPATH: site, FAKE_RECORD: record, ...env },
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const events = readFileSync(record, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l) as Record<string, unknown>);
  return { exitCode: proc.exitCode ?? 1, stdout: proc.stdout.toString(), stderr: proc.stderr.toString(), events };
}

const loads = (r: ScriptRun) => r.events.filter((e) => e.event === 'load');
const decodes = (r: ScriptRun) => r.events.filter((e) => e.event === 'transcribe');

test('script, auto language: ONE pass with per-window detection, VAD, beam 5, int8 on the physical cores', () => {
  const r = runScript([]);
  expect(r.exitCode).toBe(0);
  expect(r.stdout).toBe('привет\nworld\n');
  const [load] = loads(r);
  expect(load).toMatchObject({ device: 'cpu', compute_type: 'int8' });
  expect(Number.isInteger(load.cpu_threads)).toBe(true);
  expect(load.cpu_threads as number).toBeGreaterThan(0);
  expect(load.cpu_threads as number).toBeLessThanOrEqual(cpus().length);
  const [decode] = decodes(r);
  expect(decode).toMatchObject({
    multilingual: true,
    beam_size: 5,
    vad_filter: true,
    condition_on_previous_text: false,
    without_timestamps: true,
  });
  // A seed language (not None): None would run a second, separate detection encoder pass.
  expect(typeof decode.language).toBe('string');
});

test('script, explicit language: that language, no per-window detection', () => {
  const [decode] = decodes(runScript(['--language', 'ru']));
  expect(decode).toMatchObject({ language: 'ru', multilingual: false });
});

test('script, --threads overrides the core count', () => {
  expect(loads(runScript(['--threads', '3']))[0]).toMatchObject({ device: 'cpu', cpu_threads: 3 });
});

test('script on a CUDA host: float16 on the GPU, CPU never loaded', () => {
  const r = runScript([], { FAKE_CUDA_DEVICES: '1' });
  expect(r.exitCode).toBe(0);
  expect(loads(r).map((e) => [e.device, e.compute_type])).toEqual([['cuda', 'float16']]);
  expect(r.stdout).toBe('привет\nworld\n');
});

test('script on a CUDA host: the pip cuDNN/cuBLAS wheel dirs reach LD_LIBRARY_PATH before the model loads', () => {
  const r = runScript([], { FAKE_CUDA_DEVICES: '1' }, true);
  expect(r.exitCode).toBe(0);
  const ld = String(loads(r)[0].ld_library_path);
  expect(ld).toContain(join('nvidia', 'cudnn', 'lib'));
  expect(ld).toContain(join('nvidia', 'cublas', 'lib'));
});

test('script: a CUDA model load that throws falls back to CPU int8 and still transcribes', () => {
  const r = runScript([], { FAKE_CUDA_DEVICES: '1', FAKE_CUDA_FAIL: 'load' });
  expect(r.exitCode).toBe(0);
  expect(loads(r).map((e) => e.device)).toEqual(['cuda', 'cpu']);
  expect(loads(r)[1]).toMatchObject({ compute_type: 'int8' });
  expect(r.stdout).toBe('привет\nworld\n');
  expect(r.stderr).toContain('CPU');
});

test('script: a CUDA failure during decoding (missing cuDNN) falls back to CPU, no partial output', () => {
  const r = runScript([], { FAKE_CUDA_DEVICES: '1', FAKE_CUDA_FAIL: 'decode' });
  expect(r.exitCode).toBe(0);
  expect(decodes(r).map((e) => e.device)).toEqual(['cuda', 'cpu']);
  expect(r.stdout).toBe('привет\nworld\n');
});

test('pickWhisperCppModel prefers large-v3-turbo over large-v3 (same accuracy class, several times faster)', () => {
  expect(pickWhisperCppModel(['/m/ggml-large-v3.bin', '/m/ggml-large-v3-turbo-q8_0.bin'])).toBe(
    '/m/ggml-large-v3-turbo-q8_0.bin',
  );
});

test('script on a faster-whisper without `multilingual` (< 1.1): auto language the old way, the note still transcribes', () => {
  const r = runScript([], { FAKE_LEGACY_API: '1' });
  expect(r.exitCode).toBe(0);
  expect(r.stdout).toBe('привет\nworld\n');
  const [decode] = decodes(r);
  expect(decode.language).toBeNull();
  expect('multilingual' in decode).toBe(false);
});
