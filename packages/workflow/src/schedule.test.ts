import { describe, expect, it } from "vitest";
import { describeWorkflowAsText } from "./describe.js";
import { linearScheduledExample } from "./examples.js";
import { checkSchedule, latestScheduledRun, nextScheduledRun } from "./schedule.js";
import { validateWorkflow } from "./validate.js";

const weekdays9 = { kind: "schedule" as const, cron: "0 9 * * 1-5", timezone: "Europe/London" };

describe("schedules", () => {
  it("accepts five-part cron in a real timezone", () => {
    expect(checkSchedule(weekdays9)).toBeUndefined();
  });

  it("explains bad schedules and timezones", () => {
    expect(checkSchedule({ ...weekdays9, cron: "0 0 9 * * *" })).toMatch(/five parts/);
    expect(checkSchedule({ ...weekdays9, cron: "nonsense" })).toMatch(/five parts/);
    expect(checkSchedule({ ...weekdays9, timezone: "Mars/Base" })).toMatch(/timezone/);
    expect(
      validateWorkflow({ ...linearScheduledExample, trigger: { ...weekdays9, cron: "x" } }).ok,
    ).toBe(false);
  });

  it("finds the latest and next times, including an exact match", () => {
    const at = new Date("2026-10-27T09:00:00Z"); // Tuesday 09:00 in London
    expect(latestScheduledRun(weekdays9, at)?.toISOString()).toBe("2026-10-27T09:00:00.000Z");
    expect(nextScheduledRun(weekdays9, at)?.toISOString()).toBe("2026-10-28T09:00:00.000Z");
    // Saturday: the latest is Friday's.
    expect(latestScheduledRun(weekdays9, new Date("2026-10-31T12:00:00Z"))?.toISOString()).toBe(
      "2026-10-30T09:00:00.000Z",
    );
  });

  it("never returns a time that hasn't come yet", () => {
    const justBefore = new Date("2026-10-27T08:59:59.500Z");
    expect(latestScheduledRun(weekdays9, justBefore)?.toISOString()).toBe(
      "2026-10-26T09:00:00.000Z",
    );
  });

  it("follows daylight saving", () => {
    // Before the clocks went back on 25 Oct, 09:00 London was 08:00 UTC.
    expect(latestScheduledRun(weekdays9, new Date("2026-10-23T12:00:00Z"))?.toISOString()).toBe(
      "2026-10-23T08:00:00.000Z",
    );
  });

  it("names the timezone when describing it", () => {
    expect(describeWorkflowAsText(linearScheduledExample)).toContain(
      "every weekday at 09:00 (Europe/London time)",
    );
  });
});
