import { expect, test } from 'bun:test';
import { isEditNotModified } from '../features/transport/telegram';

// tg-cli#728: Telegram refuses an edit that changes nothing with HTTP 400 "message is not
// modified". The message already shows what the edit asked for, so the daemon treats it as
// success; every other refusal stays a failure.
const NOT_MODIFIED =
  'Bad Request: message is not modified: specified new message content and reply markup are exactly the same as a current content and reply markup of the message';

test("'message is not modified' on editMessageText / editMessageReplyMarkup is success", () => {
  expect(isEditNotModified('editMessageText', NOT_MODIFIED)).toBe(true);
  expect(isEditNotModified('editMessageReplyMarkup', NOT_MODIFIED)).toBe(true);
  expect(isEditNotModified('editMessageText', 'Bad Request: MESSAGE IS NOT MODIFIED')).toBe(true);
});

test('any other 400 on an edit is still a failure', () => {
  expect(isEditNotModified('editMessageText', 'Bad Request: message to edit not found')).toBe(false);
  expect(isEditNotModified('editMessageReplyMarkup', "Bad Request: message can't be edited")).toBe(false);
  expect(isEditNotModified('editMessageText', 'Bad Request: message text is empty')).toBe(false);
  expect(isEditNotModified('editMessageText', '')).toBe(false);
});

test('the same description on a non-edit method is not success', () => {
  expect(isEditNotModified('sendMessage', NOT_MODIFIED)).toBe(false);
  expect(isEditNotModified('deleteMessage', NOT_MODIFIED)).toBe(false);
});
