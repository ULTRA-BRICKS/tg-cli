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
// command decide whether TODAY is actually an end-of-period boundary, no-op otherwise. This
// keeps the calendar logic in testable TypeScript instead of unverifiable plist XML.
//
// SCOPE: launchd (macOS) only, matching the platform this was built and verified against.
// A systemd --user `.timer` equivalent is NOT implemented — tracked as a follow-up, not
// silently gapped (see the PR this ships in).

import { xmlEscape } from './autostart';

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

export interface UsageScheduleEnv {
  home: string;
  binPath: string;
  bunPath: string;
  logPath: string;
}

// The launchd LaunchAgent plist: fires once daily at 23:50 local time, running
// `usage-schedule-check` (a no-op on every day that is neither end-of-week nor
// end-of-month). RunAtLoad is deliberately OMITTED — unlike the daemon's own autostart
// plist, this job should not fire immediately when installed/at every login, only on its
// StartCalendarInterval schedule.
export function usageScheduleLaunchdPlist(env: UsageScheduleEnv): string {
  const argv = [env.bunPath, env.binPath, 'usage-schedule-check'];
  const args = argv.map((a) => `\t\t<string>${xmlEscape(a)}</string>\n`).join('');
  const log = xmlEscape(env.logPath);
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
