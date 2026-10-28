import { describe, expect, it } from "vitest";
import {
  buildWorkflow,
  builderProblems,
  createCatalog,
  describeWorkflowAsText,
  validateWorkflow,
} from "./index.js";

const catalog = createCatalog([
  {
    connector: "linear",
    name: "createIssue",
    kind: "action",
    phrase: "create a task in Linear",
    requiredInputs: ["title"],
  },
  {
    connector: "gmail",
    name: "sendEmail",
    kind: "action",
    phrase: "send an email",
    requiredInputs: ["to", "subject", "body"],
  },
  {
    connector: "gmail",
    name: "createDraft",
    kind: "action",
    phrase: "draft an email for me to check",
  },
  {
    connector: "drive",
    name: "createTextFile",
    kind: "action",
    phrase: "create a file in Google Drive",
  },
  {
    connector: "http",
    name: "request",
    kind: "action",
    phrase: "send a web request",
    requiredInputs: ["method", "url"],
  },
]);

describe("sentence builder", () => {
  it("builds a valid weekly automation that reads back as sentences", () => {
    const def = buildWorkflow({
      name: " Weekly check-in ",
      when: { kind: "weekly", day: 1, time: "08:30", timezone: "Europe/London" },
      steps: [
        { kind: "approval", message: "Create this week's check-in task?" },
        { kind: "linearTask", title: "Check in for {{trigger.scheduledFor}}" },
        { kind: "wait", amount: 2, unit: "hours" },
        {
          kind: "webRequest",
          method: "POST",
          url: "https://hooks.example.com/x",
          message: "Done",
        },
      ],
    });
    expect(def.name).toBe("Weekly check-in");
    expect(def.trigger).toEqual({
      kind: "schedule",
      cron: "30 8 * * 1",
      timezone: "Europe/London",
    });
    const result = validateWorkflow(def, catalog);
    expect(result.issues).toEqual([]);
    expect(describeWorkflowAsText(def, catalog)).toBe(
      [
        "When every Monday at 08:30",
        "Ask for approval Create this week's check-in task?",
        "Then create a task in Linear",
        "Wait for 2 hours",
        "Then send a web request",
      ].join("\n"),
    );
  });

  it("starts by hand, every day or on weekdays", () => {
    const when = (w: Parameters<typeof buildWorkflow>[0]["when"]) =>
      buildWorkflow({ name: "", when: w, steps: [] }).trigger;
    expect(when({ kind: "manual" })).toEqual({ kind: "manual" });
    expect(when({ kind: "daily", time: "09:05", timezone: "UTC" })).toMatchObject({
      cron: "5 9 * * *",
    });
    expect(when({ kind: "weekdays", time: "17:00", timezone: "UTC" })).toMatchObject({
      cron: "0 17 * * 1-5",
    });
  });

  it("sends or drafts email, and creates Drive files", () => {
    const def = buildWorkflow({
      name: "Friday notes",
      when: { kind: "weekly", day: 5, time: "16:00", timezone: "UTC" },
      steps: [
        { kind: "driveFile", name: "Notes {{trigger.scheduledFor}}", text: "Weekly notes" },
        { kind: "email", to: " team@acme.example ", subject: "Notes", body: "In Drive." },
        { kind: "email", to: "me@acme.example", subject: "Check", body: "x", draftOnly: true },
      ],
    });
    expect(validateWorkflow(def, catalog).issues).toEqual([]);
    expect(def.steps[1]).toMatchObject({
      connector: "gmail",
      action: "sendEmail",
      input: { to: { literal: "team@acme.example" } },
    });
    expect(def.steps[2]).toMatchObject({ action: "createDraft" });
    expect(describeWorkflowAsText(def, catalog).split("\n").slice(1)).toEqual([
      "Then create a file in Google Drive",
      "Then send an email",
      "Then draft an email for me to check",
    ]);
    expect(
      builderProblems({
        name: "x",
        when: { kind: "manual" },
        steps: [
          { kind: "email", to: "not-an-address", subject: "", body: "" },
          { kind: "driveFile", name: "", text: "" },
        ],
      }),
    ).toEqual([
      "Step 1: check the email address.",
      "Step 1: give the email a subject.",
      "Step 1: write the message.",
      "Step 2: name the file.",
      "Step 2: write what goes in the file.",
    ]);
  });

  it("says which blanks still need filling in", () => {
    expect(
      builderProblems({
        name: "",
        when: { kind: "daily", time: "", timezone: "UTC" },
        steps: [
          { kind: "linearTask", title: " " },
          { kind: "webRequest", method: "GET", url: "http://insecure.example.com" },
          { kind: "approval", message: "" },
          { kind: "wait", amount: 0, unit: "hours" },
        ],
      }),
    ).toEqual([
      "Give it a name.",
      "Pick a time.",
      "Step 1: give the task a title.",
      "Step 2: the address must start with https://.",
      "Step 3: write the question to ask.",
      "Step 4: wait at least 1 hour.",
    ]);
    expect(builderProblems({ name: "x", when: { kind: "manual" }, steps: [] })).toEqual([
      "Add at least one step.",
    ]);
  });
});
