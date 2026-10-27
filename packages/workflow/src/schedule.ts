import { Cron } from "croner";

/**
 * Schedule maths for `schedule` triggers: standard five-field cron, read in
 * the trigger's IANA timezone. Uses croner, which has no dependencies and runs
 * the same in Node, Workers and the browser.
 */

export type ScheduleTrigger = { kind: "schedule"; cron: string; timezone: string };

function cronFor(trigger: ScheduleTrigger) {
  return new Cron(trigger.cron, { timezone: trigger.timezone, mode: "5-part", paused: true });
}

/** A plain-language problem with the schedule, or undefined when it's fine. */
export function checkSchedule(trigger: ScheduleTrigger): string | undefined {
  try {
    new Intl.DateTimeFormat("en", { timeZone: trigger.timezone });
  } catch {
    return `"${trigger.timezone}" isn't a timezone we recognise.`;
  }
  try {
    if (!cronFor(trigger).nextRun()) return "This schedule never runs.";
  } catch {
    return `"${trigger.cron}" isn't a schedule we understand. Use five parts: minute hour day month weekday.`;
  }
  return undefined;
}

/** The next time the schedule fires after `after`. */
export function nextScheduledRun(trigger: ScheduleTrigger, after: Date): Date | undefined {
  return cronFor(trigger).nextRun(after) ?? undefined;
}

/** The most recent time the schedule fired at or before `at`. */
export function latestScheduledRun(trigger: ScheduleTrigger, at: Date): Date | undefined {
  // previousRuns looks strictly before the reference, to the second. Rounding
  // down to the second and adding one includes `at` itself, and never reaches
  // a time that hasn't come yet.
  const ref = Math.floor(at.getTime() / 1000) * 1000 + 1000;
  return cronFor(trigger).previousRuns(1, new Date(ref))[0];
}
