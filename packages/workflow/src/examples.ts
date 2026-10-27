import type { WorkflowDefinition } from "./schema.js";

/** The three PRD examples, one per complexity level. Used by tests and starters. */

export const simpleExample: WorkflowDefinition = {
  schemaVersion: 1,
  id: "wf_contact_notify",
  version: 1,
  name: "Tell me about new enquiries",
  trigger: { kind: "event", connector: "webhook", event: "formSubmitted" },
  steps: [
    {
      kind: "action",
      id: "notify",
      connector: "gmail",
      action: "sendEmail",
      input: {
        to: { literal: "me" },
        subject: { template: "New enquiry from {{trigger.name}}" },
        body: { ref: "trigger.message" },
      },
    },
  ],
};

export const conditionalExample: WorkflowDefinition = {
  schemaVersion: 1,
  id: "wf_signup_welcome",
  version: 1,
  name: "Welcome new customers",
  trigger: { kind: "event", connector: "webhook", event: "signedUp" },
  steps: [
    {
      kind: "if",
      id: "isNew",
      condition: { op: "eq", left: { ref: "trigger.isNewCustomer" }, right: { literal: true } },
      then: [
        {
          kind: "action",
          id: "welcome",
          connector: "gmail",
          action: "sendEmail",
          input: {
            to: { ref: "trigger.email" },
            subject: { literal: "Welcome aboard" },
            body: { template: "Hi {{trigger.name}}, thanks for signing up." },
          },
        },
      ],
      otherwise: [
        {
          kind: "action",
          id: "updateRecord",
          connector: "http",
          action: "request",
          input: {
            method: { literal: "POST" },
            url: { literal: "https://example.com/customers/update" },
            body: { ref: "trigger" },
          },
        },
      ],
    },
  ],
};

export const advancedExample: WorkflowDefinition = {
  schemaVersion: 1,
  id: "wf_overdue_reminders",
  version: 1,
  name: "Remind people about overdue tasks",
  trigger: { kind: "schedule", cron: "0 9 * * *", timezone: "Europe/London" },
  steps: [
    {
      kind: "action",
      id: "findOverdue",
      connector: "linear",
      action: "searchIssues",
      input: { filter: { literal: "overdue" } },
    },
    {
      kind: "forEach",
      id: "eachTask",
      collection: { ref: "steps.findOverdue.items" },
      as: "task",
      maxItems: 100,
      steps: [
        {
          kind: "if",
          id: "notDone",
          condition: { op: "neq", left: { ref: "task.state" }, right: { literal: "completed" } },
          then: [
            {
              kind: "action",
              id: "remind",
              connector: "gmail",
              action: "sendEmail",
              input: {
                to: { ref: "task.assigneeEmail" },
                subject: { template: "Reminder: {{task.title}} is overdue" },
                body: { template: "{{task.title}} was due on {{task.dueDate}}." },
              },
            },
          ],
        },
      ],
      ifEmpty: [{ kind: "stop", id: "nothingOverdue", reason: "Nothing is overdue today." }],
    },
  ],
};

/** The smallest useful Linear automation. Started by hand with "Run now". */
export const linearTaskExample: WorkflowDefinition = {
  schemaVersion: 1,
  id: "wf_linear_task",
  version: 1,
  name: "Add a task to Linear",
  trigger: { kind: "manual" },
  steps: [
    {
      kind: "action",
      id: "createTask",
      connector: "linear",
      action: "createIssue",
      input: {
        title: { literal: "Follow up with new customers" },
        description: { literal: "Created by Tappet." },
      },
    },
  ],
};
