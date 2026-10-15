import { expect, test } from 'bun:test';
import {
  buildFasterWhisperArgv,
  buildFfmpegArgv,
  buildWhisperCppArgv,
  cleanTranscript,
  colorizeVoiceStatus,
  formatVoiceTranscript,
  DEFAULT_VOICE,
  decideOnboarding,
  isVoiceConfigured,
  onboardingMessage,
  STATUS_READY,
  STATUS_PENDING,
  parseVoiceConfig,
  pickWhisperCppModel,
  renderVoiceConfigBlock,
  resolveVoiceConfig,
  upsertVoiceBlock,
  type VoiceConfig,
  type WhisperProbe,
} from '../features/tg-ctl/voice';

// --- config parse ---

test('parseVoiceConfig reads the voice: block, ignoring other blocks', () => {
  const yaml = [
    'control:',
    '  enabled: true',
    'voice:',
    '  enabled: yes',
    '  runner: whisper.cpp',
    '  bin_path: "/x/whisper-cli"',
    '  model_path: "/x/ggml-large-v3.bin"',
    '  language: ru',
    'features:',
    '  auto-attach: false',
  ].join('\n');
  expect(parseVoiceConfig(yaml)).toEqual({
    enabled: true,
    runner: 'whisper.cpp',
    binPath: '/x/whisper-cli',
    modelPath: '/x/ggml-large-v3.bin',
    language: 'ru',
  });
});

test('parseVoiceConfig: enabled boolean token sets, comments stripped', () => {
  expect(parseVoiceConfig('voice:\n  enabled: off  # disabled')).toEqual({ enabled: false });
  expect(parseVoiceConfig('voice:\n  enabled: 1')).toEqual({ enabled: true });
});

test('parseVoiceConfig: QUOTED enabled values are honored (unquoted before token test)', () => {
  expect(parseVoiceConfig('voice:\n  enabled: "true"')).toEqual({ enabled: true });
  expect(parseVoiceConfig("voice:\n  enabled: 'false'")).toEqual({ enabled: false });
});

test('parseVoiceConfig ignores keys outside the voice block', () => {
  expect(parseVoiceConfig('control:\n  enabled: true\n  language: ru')).toEqual({});
});

// --- config resolve / heal ---

test('resolveVoiceConfig heals an unknown runner to whisper.cpp and empty language to auto', () => {
  const cfg = resolveVoiceConfig({ runner: 'bogus' as VoiceConfig['runner'], language: '' });
  expect(cfg.runner).toBe('whisper.cpp');
  expect(cfg.language).toBe('auto');
});

test('resolveVoiceConfig defaults are disabled with empty paths', () => {
  expect(resolveVoiceConfig({})).toEqual(DEFAULT_VOICE);
});

test('resolveVoiceConfig keeps a valid faster-whisper runner', () => {
  expect(resolveVoiceConfig({ runner: 'faster-whisper' }).runner).toBe('faster-whisper');
});

// --- config round-trip (render + upsert) ---

test('config round-trips through render → parse → resolve', () => {
  const cfg: VoiceConfig = {
    enabled: true,
    runner: 'whisper.cpp',
    binPath: '/Users/x/xp/whisper.cpp/build/bin/whisper-cli',
    modelPath: '/Users/x/xp/whisper.cpp/models/ggml-large-v3.bin',
    language: 'auto',
  };
  const block = renderVoiceConfigBlock(cfg);
  expect(resolveVoiceConfig(parseVoiceConfig(block))).toEqual(cfg);
});

test('upsertVoiceBlock appends a voice block when none exists, preserving other blocks', () => {
  const before = 'control:\n  enabled: true\n';
  const cfg = resolveVoiceConfig({ enabled: true, binPath: '/b', modelPath: '/m' });
  const after = upsertVoiceBlock(before, cfg);
  expect(after).toContain('control:');
  expect(after).toContain('voice:');
  // parsing the merged doc must still see the control block intact
  expect(after.indexOf('control:')).toBeLessThan(after.indexOf('voice:'));
  expect(resolveVoiceConfig(parseVoiceConfig(after))).toMatchObject({ binPath: '/b', modelPath: '/m' });
});

test('upsertVoiceBlock replaces an existing voice block, leaving sibling blocks verbatim', () => {
  const before = ['voice:', '  enabled: false', '  bin_path: "/old"', 'features:', '  auto-attach: false', ''].join(
    '\n',
  );
  const cfg = resolveVoiceConfig({
    enabled: true,
    runner: 'whisper.cpp',
    binPath: '/new',
    modelPath: '/m',
    language: 'ru',
  });
  const after = upsertVoiceBlock(before, cfg);
  // old bin path gone, new one present, features block untouched
  expect(after).not.toContain('/old');
  expect(after).toContain('/new');
  expect(after).toContain('features:');
  expect(after).toContain('auto-attach: false');
  expect(resolveVoiceConfig(parseVoiceConfig(after)).binPath).toBe('/new');
});

// --- isVoiceConfigured ---

test('isVoiceConfigured requires enabled + both paths', () => {
  expect(
    isVoiceConfigured({ enabled: true, runner: 'whisper.cpp', binPath: '/b', modelPath: '/m', language: 'auto' }),
  ).toBe(true);
  expect(
    isVoiceConfigured({ enabled: false, runner: 'whisper.cpp', binPath: '/b', modelPath: '/m', language: 'auto' }),
  ).toBe(false);
  expect(
    isVoiceConfigured({ enabled: true, runner: 'whisper.cpp', binPath: '', modelPath: '/m', language: 'auto' }),
  ).toBe(false);
  expect(
    isVoiceConfigured({ enabled: true, runner: 'whisper.cpp', binPath: '/b', modelPath: '', language: 'auto' }),
  ).toBe(false);
});

// --- ffmpeg + whisper argv ---

test('buildFfmpegArgv emits 16k mono wav with overwrite + no stdin', () => {
  const argv = buildFfmpegArgv('/in.ogg', '/out.wav');
  expect(argv[0]).toBe('ffmpeg');
  expect(argv).toContain('-nostdin');
  expect(argv).toEqual(expect.arrayContaining(['-ar', '16000', '-ac', '1', '-f', 'wav']));
  expect(argv).toContain('/in.ogg');
  expect(argv[argv.length - 1]).toBe('/out.wav');
});

test('buildWhisperCppArgv uses -nt -np and the configured model + language', () => {
  const cfg: VoiceConfig = {
    enabled: true,
    runner: 'whisper.cpp',
    binPath: '/wc',
    modelPath: '/ggml.bin',
    language: 'auto',
  };
  const argv = buildWhisperCppArgv(cfg, '/a.wav', 8);
  expect(argv[0]).toBe('/wc');
  expect(argv).toEqual(expect.arrayContaining(['-m', '/ggml.bin', '-f', '/a.wav', '-l', 'auto', '-nt', '-np']));
});

test('buildWhisperCppArgv runs on the given core count, or voice.threads when set', () => {
  const cfg: VoiceConfig = { enabled: true, runner: 'whisper.cpp', binPath: '/wc', modelPath: '/m.bin', language: 'auto' };
  const threadsOf = (argv: string[]): string | undefined => argv[argv.indexOf('-t') + 1];
  expect(threadsOf(buildWhisperCppArgv(cfg, '/a.wav', 8))).toBe('8');
  expect(threadsOf(buildWhisperCppArgv({ ...cfg, threads: 3 }, '/a.wav', 8))).toBe('3');
});

test('buildFasterWhisperArgv passes input + model; omits --language for auto', () => {
  const cfg: VoiceConfig = {
    enabled: true,
    runner: 'faster-whisper',
    binPath: '/py',
    modelPath: 'large-v3',
    language: 'auto',
  };
  const auto = buildFasterWhisperArgv('/py', '/s.py', cfg, '/a.wav');
  expect(auto).toEqual(['/py', '/s.py', '--input_audio', '/a.wav', '--model', 'large-v3']);
  const ru = buildFasterWhisperArgv('/py', '/s.py', { ...cfg, language: 'ru' }, '/a.wav');
  expect(ru).toEqual(expect.arrayContaining(['--language', 'ru']));
});

test('buildFasterWhisperArgv passes --threads only when voice.threads is set (a project script may not take it)', () => {
  const cfg: VoiceConfig = { enabled: true, runner: 'faster-whisper', binPath: '/py', modelPath: 'm', language: 'auto' };
  expect(buildFasterWhisperArgv('/py', '/s.py', cfg, '/a.wav')).not.toContain('--threads');
  const argv = buildFasterWhisperArgv('/py', '/s.py', { ...cfg, threads: 6 }, '/a.wav');
  expect(argv.slice(argv.indexOf('--threads'))).toEqual(['--threads', '6']);
});

// --- transcript cleaning ---

test('cleanTranscript trims whitespace and collapses CR/newlines', () => {
  expect(cleanTranscript('  \r\n And so my fellow Americans. \r\n')).toBe('And so my fellow Americans.');
});

test('cleanTranscript strips whisper.cpp bracket/paren noise', () => {
  expect(cleanTranscript('[BLANK_AUDIO]')).toBe('');
  expect(cleanTranscript('hello [silence] world')).toBe('hello world');
  expect(cleanTranscript('(music) привет')).toBe('привет');
});

test('formatVoiceTranscript wraps the transcript as a 🎤 quote', () => {
  expect(formatVoiceTranscript('add a retry to the loader')).toBe('🎤 «add a retry to the loader»');
  // trims surrounding whitespace before quoting
  expect(formatVoiceTranscript('  привет  ')).toBe('🎤 «привет»');
});

test('cleanTranscript strips faster-whisper banners + timestamp prefixes, joins segments', () => {
  const raw = [
    'Using CPU device',
    "Detected language 'ru' with probability 0.99",
    '[0.00s -> 1.20s] привет',
    '[1.20s -> 2.00s] мир',
  ].join('\n');
  expect(cleanTranscript(raw)).toBe('привет мир');
});

// --- model picking ---

test('pickWhisperCppModel prefers multilingual large over en over tiny, ignoring for-tests fixtures', () => {
  const models = ['/m/for-tests-ggml-tiny.bin', '/m/ggml-base.en.bin', '/m/ggml-large-v3.bin', '/m/ggml-small.bin'];
  expect(pickWhisperCppModel(models)).toBe('/m/ggml-large-v3.bin');
});

test('pickWhisperCppModel falls back to an en model when only en is real', () => {
  expect(pickWhisperCppModel(['/m/for-tests-ggml-tiny.bin', '/m/ggml-base.en.bin'])).toBe('/m/ggml-base.en.bin');
});

test('pickWhisperCppModel treats quantized/variant .en models as English-only (prefers multilingual)', () => {
  // .en followed by a quantization suffix (-q5_0) or a variant (-tdrz), not .bin.
  expect(pickWhisperCppModel(['/m/ggml-medium.en-q5_0.bin', '/m/ggml-small.bin'])).toBe('/m/ggml-small.bin');
  expect(pickWhisperCppModel(['/m/ggml-large.en-q8_0.bin', '/m/ggml-base.bin'])).toBe('/m/ggml-base.bin');
  // a multilingual quantized model must KEEP its multilingual bonus.
  expect(pickWhisperCppModel(['/m/ggml-large-v3-q5_0.bin', '/m/ggml-base.en.bin'])).toBe('/m/ggml-large-v3-q5_0.bin');
});

test('pickWhisperCppModel returns undefined when only fixtures exist', () => {
  expect(pickWhisperCppModel(['/m/for-tests-ggml-base.bin'])).toBeUndefined();
  expect(pickWhisperCppModel([])).toBeUndefined();
});

// --- onboarding decision ---

const PROBE_READY: WhisperProbe = {
  whisperCppBin: '/xp/whisper.cpp/build/bin/whisper-cli',
  whisperCppModels: ['/xp/whisper.cpp/models/ggml-large-v3.bin'],
  ffmpegFound: true,
};

test('decideOnboarding: whisper.cpp bin + real model + ffmpeg → ready with that config', () => {
  const v = decideOnboarding(PROBE_READY, 'auto');
  expect(v.kind).toBe('ready');
  if (v.kind === 'ready') {
    expect(v.cfg.runner).toBe('whisper.cpp');
    expect(v.cfg.binPath).toBe('/xp/whisper.cpp/build/bin/whisper-cli');
    expect(v.cfg.modelPath).toBe('/xp/whisper.cpp/models/ggml-large-v3.bin');
    expect(v.cfg.enabled).toBe(true);
  }
});

test('decideOnboarding: nothing found → need-install with guidance', () => {
  const v = decideOnboarding({ ffmpegFound: true });
  expect(v.kind).toBe('need-install');
});

test('decideOnboarding: whisper present but ffmpeg missing → need-ffmpeg', () => {
  const v = decideOnboarding({ ...PROBE_READY, ffmpegFound: false });
  expect(v.kind).toBe('need-ffmpeg');
});

test('decideOnboarding: whisper.cpp bin but only fixture models → need-install', () => {
  const v = decideOnboarding({
    whisperCppBin: '/xp/whisper.cpp/build/bin/whisper-cli',
    whisperCppModels: ['/m/for-tests-ggml-base.bin'],
    ffmpegFound: true,
  });
  expect(v.kind).toBe('need-install');
});

test('decideOnboarding falls back to faster-whisper when whisper.cpp absent', () => {
  const v = decideOnboarding({
    fasterWhisperPython: '/xp/faster-whisper/.venv/bin/python',
    fasterWhisperScript: '/xp/faster-whisper/my_faster_whisper.py',
    ffmpegFound: true,
  });
  expect(v.kind).toBe('ready');
  if (v.kind === 'ready') expect(v.cfg.runner).toBe('faster-whisper');
});

test('decideOnboarding accepts a venv-only faster-whisper probe (no project script → generated fallback)', () => {
  const v = decideOnboarding({
    fasterWhisperPython: '/xp/faster-whisper/.venv/bin/python',
    // no fasterWhisperScript — the daemon writes a generated fallback
    ffmpegFound: true,
  });
  expect(v.kind).toBe('ready');
  if (v.kind === 'ready') {
    expect(v.cfg.runner).toBe('faster-whisper');
    expect(v.cfg.binPath).toBe('/xp/faster-whisper/.venv/bin/python');
  }
});

// --- onboarding message ---

test('onboardingMessage covers each verdict', () => {
  expect(onboardingMessage(decideOnboarding(PROBE_READY))).toContain('configured');
  expect(onboardingMessage({ kind: 'need-ffmpeg', hint: 'brew install ffmpeg' })).toContain('ffmpeg');
  expect(onboardingMessage({ kind: 'need-install', hint: 'do X' })).toContain('do X');
});

// --- setup status glyph (install-* state: green ✓ configured / yellow ○ pending) ---

test('onboardingMessage leads with a ✓ status glyph when configured', () => {
  const msg = onboardingMessage(decideOnboarding(PROBE_READY));
  expect(msg).toContain(STATUS_READY);
  expect(msg).not.toContain(STATUS_PENDING);
  // The glyph sits on the FIRST line, right after the 🎙️ marker.
  expect(msg.split('\n')[0]).toContain(`🎙️ ${STATUS_READY}`);
});

test('onboardingMessage leads with a ○ pending glyph when not yet set up', () => {
  for (const verdict of [
    { kind: 'need-ffmpeg', hint: 'brew install ffmpeg' } as const,
    { kind: 'need-install', hint: 'do X' } as const,
  ]) {
    const msg = onboardingMessage(verdict);
    expect(msg).toContain(STATUS_PENDING);
    expect(msg).not.toContain(STATUS_READY);
    expect(msg.split('\n')[0]).toContain(`🎙️ ${STATUS_PENDING}`);
  }
});

test('onboardingMessage carries NO ANSI — it is sent verbatim to Telegram (no escape codes)', () => {
  // The shared message must be ANSI-free: the daemon path sends it straight to
  // Telegram, which cannot render escape codes. Color is added later, CLI-only.
  for (const verdict of [
    decideOnboarding(PROBE_READY),
    { kind: 'need-ffmpeg', hint: 'brew install ffmpeg' } as const,
    { kind: 'need-install', hint: 'do X' } as const,
  ]) {
    expect(onboardingMessage(verdict)).not.toContain('\x1b[');
  }
});

test('colorizeVoiceStatus is a no-op when disabled (the Telegram/piped contract)', () => {
  const ready = onboardingMessage(decideOnboarding(PROBE_READY));
  const pending = onboardingMessage({ kind: 'need-install', hint: 'do X' });
  expect(colorizeVoiceStatus(ready, false)).toBe(ready);
  expect(colorizeVoiceStatus(pending, false)).toBe(pending);
});

test('colorizeVoiceStatus colors ONLY the status glyph for a terminal (green ✓ / yellow ○)', () => {
  const ready = colorizeVoiceStatus(onboardingMessage(decideOnboarding(PROBE_READY)), true);
  // Green (32) wraps the ✓ glyph; the rest of the text survives unchanged.
  expect(ready).toContain(`\x1b[32m${STATUS_READY}\x1b[0m`);
  expect(ready).toContain('configured');

  const pending = colorizeVoiceStatus(onboardingMessage({ kind: 'need-install', hint: 'do X' }), true);
  // Yellow (33) wraps the ○ glyph.
  expect(pending).toContain(`\x1b[33m${STATUS_PENDING}\x1b[0m`);
  expect(pending).toContain('do X');

  // Stripping the ANSI yields the original (only color codes were injected).
  const stripAnsi = (s: string): string => s.replace(/\x1b\[[0-9;]*m/g, '');
  expect(stripAnsi(ready)).toBe(onboardingMessage(decideOnboarding(PROBE_READY)));
});
