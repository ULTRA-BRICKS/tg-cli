// Pure caller-facing TTS diagnostics; no credential or provider access.
import { expect, test } from 'bun:test';
import { parseUserAccountArgs } from '../features/user-account/args';
import { describeError, describeResult } from '../features/user-account/messages';

test('neural preflight names the configured model and voice without a host fallback', () => {
  const cmd = parseUserAccountArgs(['call', '@alice', '--say', 'hello']);
  if (!cmd || cmd.kind !== 'call') throw new Error('fixture is not a call');
  const result = describeResult(cmd, { dry_run: true, peer: '@alice', media: 'say', missing: [],
    tts: { provider: 'fish_audio', model: 'pinned', voice_id: 'a'.repeat(32) } });
  expect(result).toContain('fish_audio / pinned / ' + 'a'.repeat(32));
  expect(result).toContain('credentials and provider not checked');
  expect(result).not.toContain('espeak');
  const missing = describeResult(cmd, { dry_run: true, peer: '@alice', missing: ['tts'],
    missing_reasons: [{ component: 'tts', code: 'TTS_CONFIG_MISSING' }] });
  expect(missing).toContain('voice.json');
});

test('all safe TTS failures provide corrective help', () => {
  for (const code of ['TTS_CONFIG_MISSING', 'TTS_CONFIG_INVALID', 'TTS_ENDPOINT_UNTRUSTED',
    'TTS_CREDENTIAL_UNAVAILABLE', 'TTS_PROVIDER_FAILED', 'TTS_PROVIDER_TIMEOUT',
    'TTS_AUDIO_INVALID', 'TTS_OUTPUT_FAILED', 'TTS_METADATA_INVALID']) {
    expect(describeError(code, 'caller')).not.toContain('sidecar failed');
  }
  expect(describeError('TTS_CREDENTIAL_UNAVAILABLE', 'caller')).toContain('Do not copy the key');
});
