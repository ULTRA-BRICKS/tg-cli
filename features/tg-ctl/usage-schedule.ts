// features/tg-ctl/usage-schedule.ts — periodic end-of-week / end-of-month usage report,
// pushed to Telegram automatically via `rig usage` + `tg`.
//
// Mirrors autostart.ts's plan/apply split: this module computes what to write and run
// (pure, unit-testable); the entrypoint (`tg-ctl usage-schedule enable|disable`, and the
// `usage-schedule-check` verb the installed job actually invokes) performs the real I/O.
//
// WHY a daily-firing job instead of encoding "end of week/month" directly in launchd's
// StartCalendarInterval: launchd calendar intervals have no "last day of month" concept
// (months have 28-31 days) and no simpler way to express "the Nth-to-last day" either — the
// standard workaround (used here) is to fire once a day at a fixed time and let the invoked
// command decide whether a report is due, no-op otherwise. This keeps the calendar logic
// in testable TypeScript instead of unverifiable plist XML.
//
// WHY the invoked command checks a WATERMARK (last-reported period id) rather than "is
// TODAY the boundary": launchd's documented behavior for a missed StartCalendarInterval
// firing (machine asleep at 23:50) is to run at WAKE, not at the original time — a naive
// same-day check would then silently never send that period's report at all. Comparing
// the current completed period's id against what was last reported catches up on the
// next real run regardless of which day it actually runs on.
//
// SCOPE: launchd (macOS) only, matching the platform this was built and verified against.
// A systemd --user `.timer` equivalent is NOT implemented — tracked as a follow-up, not
// silently gapped (see the PR this ships in).

import { defaultConfigDir, xmlEscape } from './autostart';

export const USAGE_SCHEDULE_LAUNCHD_LABEL = 'com.agenttools.tg-ctl.usage-schedule';

export function usageScheduleLaunchdPlistPath(home: string): string {
  return `${home}/Library/LaunchAgents/${USAGE_SCHEDULE_LAUNCHD_LABEL}.plist`;
}

// The days in `date`'s month (28-31), used by isEndOfMonth. `new Date(year, month+1, 0)` is
// the standard JS idiom for "day 0 of next month" == "last day of this month".
function daysInMonth(date: Date): number {
  return new Date(date.getFullYear(), date.getMonth() + 1, 0).getDate();
}

// Sunday (getDay() === 0), local time — matches this codebase's ISO-week convention
// elsewhere (`rig usage`'s own week label is ISO 8601, Mon-Sun; Sunday is the last day).
export function isEndOfWeek(date: Date): boolean {
  return date.getDay() === 0;
}

export function isEndOfMonth(date: Date): boolean {
  return date.getDate() === daysInMonth(date);
}

// --- watermark-based period identification ---
//
// WHY: launchd's documented behavior for `StartCalendarInterval` is that a firing missed
// while the machine is asleep runs at WAKE, not at the original time — so a naive
// `isEndOfWeek(now)`/`isEndOfMonth(now)` check silently drops the report whenever the
// machine happens to be asleep at 23:50 on the actual boundary day (a laptop closed
// Sunday night, opened Monday, would never see isEndOfWeek() true again until next
// Sunday). Instead of trusting "is TODAY the boundary", identify the most recently
// COMPLETED week/month AS OF `now` (regardless of what day `now` actually is) and diff
// that identifier against a persisted "last reported" watermark — catches up on the
// exact next run after any gap, asleep or not.

const twoDigits = (n: number): string => String(n).padStart(2, '0');

// The identifier for the most recently completed (or, if `date` IS a Sunday, currently
// completing) week: the ISO date (YYYY-MM-DD) of that week's Sunday. Using the literal
// Sunday date rather than an ISO week NUMBER sidesteps ISO week-numbering edge cases
// (week 1 of a year can start in the prior December, etc.) — this only needs to be a
// stable, monotonically-changing string, not a standards-compliant week label.
export function completedWeekId(date: Date): string {
  const sunday = new Date(date);
  sunday.setDate(sunday.getDate() - sunday.getDay());
  return `${sunday.getFullYear()}-${twoDigits(sunday.getMonth() + 1)}-${twoDigits(sunday.getDate())}`;
}

// The identifier (YYYY-MM) of the most recently completed (or, if `date` IS the last day
// of its month, currently completing) month.
export function completedMonthId(date: Date): string {
  if (isEndOfMonth(date)) {
    return `${date.getFullYear()}-${twoDigits(date.getMonth() + 1)}`;
  }
  const lastOfPrevMonth = new Date(date.getFullYear(), date.getMonth(), 0);
  return `${lastOfPrevMonth.getFullYear()}-${twoDigits(lastOfPrevMonth.getMonth() + 1)}`;
}

export interface UsageScheduleWatermark {
  lastWeekReported: string | null;
  lastMonthReported: string | null;
}

export const EMPTY_USAGE_SCHEDULE_WATERMARK: UsageScheduleWatermark = {
  lastWeekReported: null,
  lastMonthReported: null,
};

// Which periods (if any) are due for a report right now, given the persisted watermark —
// pure decision function, no I/O. A period is due whenever its current completed-period
// id differs from what's recorded (covers both "never reported" — null — and "the
// recorded period has rolled over", which is what makes this resilient to a missed
// exact-day firing).
export function usageSchedulePeriodsDue(
  now: Date,
  watermark: UsageScheduleWatermark,
): Array<{ period: 'week' | 'month'; id: string; title: string }> {
  const due: Array<{ period: 'week' | 'month'; id: string; title: string }> = [];
  const weekId = completedWeekId(now);
  if (weekId !== watermark.lastWeekReported) {
    due.push({ period: 'week', id: weekId, title: 'Weekly usage report' });
  }
  const monthId = completedMonthId(now);
  if (monthId !== watermark.lastMonthReported) {
    due.push({ period: 'month', id: monthId, title: 'Monthly usage report' });
  }
  return due;
}

export interface UsageScheduleEnv {
  home: string;
  binPath: string;
  bunPath: string;
  logPath: string;
  // The config dir this job was enabled with. launchd starts an agent with a minimal
  // environment — it does NOT inherit the shell's $TG_CTL_CONFIG_DIR — so for a
  // non-default dir the plist must pin it via EnvironmentVariables, or the scheduled
  // check runs against the WRONG bot/credentials than the one it was enabled for
  // (mirrors autostart.ts's own AutostartEnv.configDir handling exactly).
  configDir: string;
}

// The launchd LaunchAgent plist: fires once daily at 23:50 local time, running
// `usage-schedule-check` (a no-op on every day that isn't due a week/month report per
// the watermark). RunAtLoad is deliberately OMITTED — unlike the daemon's own autostart
// plist, this job should not fire immediately when installed/at every login, only on its
// StartCalendarInterval schedule.
export function usageScheduleLaunchdPlist(env: UsageScheduleEnv): string {
  const argv = [env.bunPath, env.binPath, 'usage-schedule-check'];
  const args = argv.map((a) => `\t\t<string>${xmlEscape(a)}</string>\n`).join('');
  const log = xmlEscape(env.logPath);
  // EnvironmentVariables pins TG_CTL_CONFIG_DIR for a non-default config dir — same
  // condition and shape as autostart.ts's launchdPlist, so the scheduled job resolves
  // the exact same config dir the daemon it reports on actually uses.
  const envBlock =
    env.configDir && env.configDir !== defaultConfigDir(env.home)
      ? '\t<key>EnvironmentVariables</key>\n' +
        '\t<dict>\n' +
        `\t\t<key>TG_CTL_CONFIG_DIR</key>\n\t\t<string>${xmlEscape(env.configDir)}</string>\n` +
        '\t</dict>\n'
      : '';
  return (
    '<?xml version="1.0" encoding="UTF-8"?>\n' +
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" ' +
    '"http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n' +
    '<plist version="1.0">\n' +
    '<dict>\n' +
    '\t<key>Label</key>\n' +
    `\t<string>${xmlEscape(USAGE_SCHEDULE_LAUNCHD_LABEL)}</string>\n` +
    '\t<key>ProgramArguments</key>\n' +
    `\t<array>\n${args}\t</array>\n` +
    envBlock +
    '\t<key>StartCalendarInterval</key>\n' +
    '\t<dict>\n' +
    '\t\t<key>Hour</key>\n' +
    '\t\t<integer>23</integer>\n' +
    '\t\t<key>Minute</key>\n' +
    '\t\t<integer>50</integer>\n' +
    '\t</dict>\n' +
    '\t<key>StandardOutPath</key>\n' +
    `\t<string>${log}</string>\n` +
    '\t<key>StandardErrorPath</key>\n' +
    `\t<string>${log}</string>\n` +
    '</dict>\n' +
    '</plist>\n'
  );
}

export interface UsageScheduleCommand {
  argv: string[];
  describe: string;
  optional?: boolean;
}

export interface UsageScheduleEnablePlan {
  file: { path: string; content: string; mode: number };
  commands: UsageScheduleCommand[];
}

export function buildUsageScheduleEnablePlan(env: UsageScheduleEnv): UsageScheduleEnablePlan {
  const path = usageScheduleLaunchdPlistPath(env.home);
  return {
    file: { path, content: usageScheduleLaunchdPlist(env), mode: 0o644 },
    commands: [
      { argv: ['launchctl', 'unload', path], describe: 'unload any existing usage-schedule job', optional: true },
      { argv: ['launchctl', 'load', path], describe: 'load the usage-schedule LaunchAgent' },
    ],
  };
}

export interface UsageScheduleDisablePlan {
  filePath: string;
  commands: UsageScheduleCommand[];
}

export function buildUsageScheduleDisablePlan(home: string): UsageScheduleDisablePlan {
  const path = usageScheduleLaunchdPlistPath(home);
  return {
    filePath: path,
    commands: [{ argv: ['launchctl', 'unload', path], describe: 'unload the usage-schedule LaunchAgent (stops it)' }],
  };
}
