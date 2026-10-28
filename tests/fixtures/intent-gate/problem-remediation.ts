// Fixed examples exercise the actual intent/send gates; no model or Telegram needed.
export const BARE_PROBLEM = 'Guardian home:\n• нет открытой вкладки чата 6ae07d22 (под наблюдением).';
export const PAST_ACTION = 'Уже сделал: Проверил список вкладок через browser.tabs; результат: чат 6ae07d22 отсутствует.';
export const CURRENT_ACTION = 'Сейчас делаю: Открываю сохранённый адрес чата 6ae07d22 и проверяю его идентификатор.';
export const COMPLETE_PROBLEM = `${BARE_PROBLEM}\n${PAST_ACTION}\n${CURRENT_ACTION}`;
export const HARD_BLOCKER = [
  'Блокер: восстановление чата 6ae07d22 остановлено из-за отсутствия доступа к браузеру.',
  'Уже сделал: Запросил список вкладок; получил permission denied. Проверил резервный браузер; результат: он недоступен.',
  'Сейчас делаю: Продолжить не могу: доступ к browser.tabs запрещён политикой устройства. Жду разрешения владельца устройства на browser.tabs; после выдачи доступа повторю список вкладок и проверю идентификатор чата 6ae07d22.',
].join('\n');
export const RICH_PROBLEM = [
  '<h3>Контекст</h3><p>Восстанавливаю наблюдение за чатом 6ae07d22: вкладка отсутствует в браузере Guardian home.</p><hr>',
  '<h3>Уже сделал</h3><p>Проверил список вкладок через <code>browser.tabs</code>; результат: чат 6ae07d22 отсутствует.</p><hr>',
  '<h3>Сейчас делаю</h3><p>Открываю сохранённый адрес чата 6ae07d22 и проверяю его идентификатор.</p><hr>',
  '<h3>Где смотреть</h3><p><code>browser.tabs: chat 6ae07d22 missing</code></p>',
].join('\n');
