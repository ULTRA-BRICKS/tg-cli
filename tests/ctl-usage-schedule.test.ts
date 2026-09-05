// Tests for the pure usage-schedule policy (features/tg-ctl/usage-schedule.ts) — the
// end-of-week/end-of-month calendar logic and the launchd plist/plan builders for the
// scheduled `/usage` push. Pure — no real launchd, no I/O, no clock dependency (dates are
// passed in explicitly).
import { expect, test } from 'bun:test';
import {
  EMPTY_USAGE_SCHEDULE_WATERMARK,
  USAGE_SCHEDULE_LAUNCHD_LABEL,
  buildUsageScheduleDisablePlan,
  buildUsageScheduleEnablePlan,
  completedMonthId,
  completedWeekId,
  isEndOfMonth,
  isEndOfWeek,
  usageScheduleLaunchdPlist,
  usageScheduleLaunchdPlistPath,
  usageSchedulePeriodsDue,
  type UsageScheduleEnv,
} from '../features/tg-ctl/usage-schedule';

const DEFAULT_CONFIG_DIR = '/home/u/.config/tg-cli';

function env(overrides: Partial<UsageScheduleEnv> = {}): UsageScheduleEnv {
  return {
    home: '/home/u',
    binPath: '/home/u/.files/bin/tg-ctl',
    bunPath: '/home/u/.bun/bin/bun',
    logPath: '/home/u/.config/tg-cli/tg-ctl.123456.log',
    configDir: DEFAULT_CONFIG_DIR,
    ...overrides,
  };
}

test('isEndOfWeek: true only on Sunday', () => {
  // 2026-08-30 is a real Sunday (Alex's own machine date at the time this was written).
  expect(isEndOfWeek(new Date(2026, 7, 30))).toBe(true); // Sun
  expect(isEndOfWeek(new Date(2026, 7, 29))).toBe(false); // Sat
  expect(isEndOfWeek(new Date(2026, 7, 24))).toBe(false); // Mon
});

test('isEndOfMonth: true on the last calendar day, including short/leap Februaries', () => {
  expect(isEndOfMonth(new Date(2026, 7, 31))).toBe(true); // Aug 31
  expect(isEndOfMonth(new Date(2026, 7, 30))).toBe(false); // Aug 30
  expect(isEndOfMonth(new Date(2026, 3, 30))).toBe(true); // Apr 30 (30-day month)
  expect(isEndOfMonth(new Date(2026, 3, 29))).toBe(false);
  expect(isEndOfMonth(new Date(2026, 1, 28))).toBe(true); // 2026 is not a leap year: Feb 28
  expect(isEndOfMonth(new Date(2024, 1, 29))).toBe(true); // 2024 IS a leap year: Feb 29
  expect(isEndOfMonth(new Date(2024, 1, 28))).toBe(false);
});

test('a day can be both end-of-week and end-of-month at once', () => {
  // 2026-05-31 is a real Sunday that also happens to be May's last day — confirmed both
  // conditions can be simultaneously true (the scheduled job sends BOTH reports that day).
  const bothTrue = new Date(2026, 4, 31);
  expect(bothTrue.getDay()).toBe(0); // sanity: really is a Sunday
  expect(isEndOfWeek(bothTrue)).toBe(true);
  expect(isEndOfMonth(bothTrue)).toBe(true);
});

test('usageScheduleLaunchdPlistPath: ~/Library/LaunchAgents/<label>.plist', () => {
  expect(usageScheduleLaunchdPlistPath('/home/u')).toBe(`/home/u/Library/LaunchAgents/${USAGE_SCHEDULE_LAUNCHD_LABEL}.plist`);
});

test('usageScheduleLaunchdPlist: fires daily at 23:50, no RunAtLoad, runs usage-schedule-check', () => {
  const xml = usageScheduleLaunchdPlist(env());
  expect(xml).toContain(`<string>${USAGE_SCHEDULE_LAUNCHD_LABEL}</string>`);
  expect(xml).toContain('<string>/home/u/.bun/bin/bun</string>');
  expect(xml).toContain('<string>/home/u/.files/bin/tg-ctl</string>');
  expect(xml).toContain('<string>usage-schedule-check</string>');
  expect(xml).toContain('<key>StartCalendarInterval</key>');
  expect(xml).toContain('<key>Hour</key>\n\t\t<integer>23</integer>');
  expect(xml).toContain('<key>Minute</key>\n\t\t<integer>50</integer>');
  // Deliberately NOT RunAtLoad — this job should only fire on its calendar schedule, not at
  // every install/login (unlike the daemon's own autostart plist).
  expect(xml).not.toContain('RunAtLoad');
  expect(xml).toContain('/home/u/.config/tg-cli/tg-ctl.123456.log');
});

test('usageScheduleLaunchdPlist XML-escapes an unusual path', () => {
  const xml = usageScheduleLaunchdPlist(env({ binPath: '/home/u & co/tg-ctl' }));
  expect(xml).toContain('/home/u &amp; co/tg-ctl');
  expect(xml).not.toContain('/home/u & co/tg-ctl');
});

test('buildUsageScheduleEnablePlan: unload-then-load, file mode 0o644', () => {
  const plan = buildUsageScheduleEnablePlan(env());
  expect(plan.file.path).toBe(usageScheduleLaunchdPlistPath('/home/u'));
  expect(plan.file.mode).toBe(0o644);
  expect(plan.commands.map((c) => c.argv)).toEqual([
    ['launchctl', 'unload', plan.file.path],
    ['launchctl', 'load', plan.file.path],
  ]);
  expect(plan.commands[0].optional).toBe(true);
  expect(plan.commands[1].optional).toBeUndefined();
});

test('buildUsageScheduleDisablePlan: single unload command gates file removal', () => {
  const plan = buildUsageScheduleDisablePlan('/home/u');
  expect(plan.filePath).toBe(usageScheduleLaunchdPlistPath('/home/u'));
  expect(plan.commands).toEqual([{ argv: ['launchctl', 'unload', plan.filePath], describe: 'unload the usage-schedule LaunchAgent (stops it)' }]);
});

test('usageScheduleLaunchdPlist: default config dir omits EnvironmentVariables', () => {
  const xml = usageScheduleLaunchdPlist(env());
  expect(xml).not.toContain('EnvironmentVariables');
  expect(xml).not.toContain('TG_CTL_CONFIG_DIR');
});

test('usageScheduleLaunchdPlist: non-default config dir pins TG_CTL_CONFIG_DIR', () => {
  const xml = usageScheduleLaunchdPlist(env({ configDir: '/home/u/.config/tg-cli-work' }));
  expect(xml).toContain('<key>EnvironmentVariables</key>');
  expect(xml).toContain('<key>TG_CTL_CONFIG_DIR</key>');
  expect(xml).toContain('<string>/home/u/.config/tg-cli-work</string>');
});

test('completedWeekId: mid-week resolves to the PRIOR Sunday (this week has not completed yet)', () => {
  // Mon 2026-08-24 through Sat 2026-08-29 are still an in-progress week — the most recently
  // COMPLETED week ended on the Sunday before, 2026-08-23.
  expect(completedWeekId(new Date(2026, 7, 24))).toBe('2026-08-23'); // Mon
  expect(completedWeekId(new Date(2026, 7, 26))).toBe('2026-08-23'); // Wed
  // On Sunday itself, that week is currently completing — it resolves to itself.
  expect(completedWeekId(new Date(2026, 7, 30))).toBe('2026-08-30');
  // The Monday right after still resolves to the Sunday that JUST completed, not itself.
  expect(completedWeekId(new Date(2026, 7, 31))).toBe('2026-08-30');
});

test('completedMonthId: before month-end resolves to the PRIOR month (this month has not completed yet)', () => {
  expect(completedMonthId(new Date(2026, 7, 1))).toBe('2026-07'); // Aug 1: August isn't done — July is the last completed month
  expect(completedMonthId(new Date(2026, 7, 15))).toBe('2026-07');
  expect(completedMonthId(new Date(2026, 7, 31))).toBe('2026-08'); // last day: August is currently completing
  expect(completedMonthId(new Date(2026, 8, 1))).toBe('2026-08'); // Sep 1: August just completed
});

test('usageSchedulePeriodsDue: both due on a fresh (null watermark) run', () => {
  const due = usageSchedulePeriodsDue(new Date(2026, 7, 30), EMPTY_USAGE_SCHEDULE_WATERMARK);
  expect(due.map((d) => d.period).sort()).toEqual(['month', 'week']);
});

test('usageSchedulePeriodsDue: neither due once both watermarks match the current period', () => {
  const now = new Date(2026, 7, 24); // mid-August, mid-week
  const watermark = { lastWeekReported: completedWeekId(now), lastMonthReported: completedMonthId(now) };
  expect(usageSchedulePeriodsDue(now, watermark)).toEqual([]);
});

test('usageSchedulePeriodsDue: catches up a week report missed while the machine was asleep', () => {
  // Watermark still points at the PRIOR week (e.g. the machine slept through last Sunday's
  // 23:50 firing). The next real run, even mid-week, must still catch it — this is the whole
  // point of watermark-based scheduling over a naive same-day isEndOfWeek() check.
  const now = new Date(2026, 7, 24); // Monday, not itself end-of-week
  const watermark = { lastWeekReported: '2026-08-16', lastMonthReported: completedMonthId(now) };
  const due = usageSchedulePeriodsDue(now, watermark);
  expect(due).toEqual([{ period: 'week', id: '2026-08-23', title: 'Weekly usage report' }]);
});

test('usageSchedulePeriodsDue: both due the same day when a week ends on the last day of its month', () => {
  const bothTrue = new Date(2026, 4, 31); // confirmed Sunday + May's last day (see above)
  const due = usageSchedulePeriodsDue(bothTrue, EMPTY_USAGE_SCHEDULE_WATERMARK);
  expect(due.map((d) => d.period).sort()).toEqual(['month', 'week']);
});
