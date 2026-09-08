import { expect, test } from 'bun:test';
import {
  formatScreenshotAttachError,
  mentionsScreenshot,
} from '../features/cli/screenshot-guard';

test('mentionsScreenshot detects screenshot any case', () => {
  expect(mentionsScreenshot('see screenshot foo.png')).toBe(true);
  expect(mentionsScreenshot('See SCREENSHOT of the dialog')).toBe(true);
  expect(mentionsScreenshot('screenshots attached below')).toBe(true);
});

test('mentionsScreenshot detects Cyrillic скриншот any case', () => {
  expect(mentionsScreenshot('см. скриншот foo.png')).toBe(true);
  expect(mentionsScreenshot('СКРИНШОТ')).toBe(true);
  expect(mentionsScreenshot('Скриншот диалога')).toBe(true);
});

test('mentionsScreenshot ignores unrelated text', () => {
  expect(mentionsScreenshot('deploy finished, all green')).toBe(false);
  expect(mentionsScreenshot('')).toBe(false);
  expect(mentionsScreenshot('screen shot with a space')).toBe(false);
});

test('formatScreenshotAttachError tells to attach, not omit the word', () => {
  const msg = formatScreenshotAttachError();
  expect(msg).toContain('tg --photo');
  expect(msg.toLowerCase()).toContain('attach the screenshot');
  expect(msg.toLowerCase()).toContain('do not dodge');
  expect(msg.toLowerCase()).toContain('deleting the word');
  expect(msg.toLowerCase()).not.toContain('remove the word');
  expect(msg.toLowerCase()).not.toContain('omit the word');
});
