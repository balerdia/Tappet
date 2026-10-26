import type { ConnectorManifest } from "./types.js";

// The first four integrations from the PRD. Scopes are least-privilege
// starting points and will change as real flows are built.

export const gmail: ConnectorManifest = {
  id: "gmail",
  name: "Gmail",
  description: "Read and search email, and send messages you've approved.",
  auth: {
    kind: "oauth2",
    provider: "google",
    scopes: [
      "https://www.googleapis.com/auth/gmail.readonly",
      "https://www.googleapis.com/auth/gmail.send",
    ],
  },
  capabilities: ["read", "search", "write", "events"],
  events: [{ name: "messageReceived", phrase: "an email arrives" }],
  actions: [
    { name: "sendEmail", phrase: "send an email", requiredInputs: ["to", "subject", "body"] },
    { name: "createDraft", phrase: "draft an email for me to check", requiredInputs: ["to"] },
  ],
};

export const drive: ConnectorManifest = {
  id: "drive",
  name: "Google Drive",
  description: "Find and read documents.",
  auth: {
    kind: "oauth2",
    provider: "google",
    scopes: ["https://www.googleapis.com/auth/drive.readonly"],
  },
  capabilities: ["read", "search", "sync"],
  events: [{ name: "fileChanged", phrase: "a document changes" }],
  actions: [],
};

export const linear: ConnectorManifest = {
  id: "linear",
  name: "Linear",
  description: "Read, find and create tasks.",
  auth: { kind: "oauth2", provider: "linear", scopes: ["read", "write"] },
  capabilities: ["read", "search", "write", "events", "sync"],
  events: [
    { name: "issueCreated", phrase: "a task is created" },
    { name: "issueUpdated", phrase: "a task changes" },
  ],
  actions: [
    { name: "searchIssues", phrase: "find tasks in Linear", requiredInputs: ["query"] },
    {
      name: "createIssue",
      phrase: "create a task in Linear",
      requiredInputs: ["teamId", "title"],
    },
    { name: "updateIssue", phrase: "update a task in Linear", requiredInputs: ["id"] },
  ],
};

export const http: ConnectorManifest = {
  id: "http",
  name: "Web request",
  description: "Send data to any web address.",
  auth: { kind: "none" },
  capabilities: ["write"],
  events: [],
  actions: [
    {
      name: "request",
      phrase: "send a web request",
      requiredInputs: ["method", "url"],
    },
  ],
};

export const webhook: ConnectorManifest = {
  id: "webhook",
  name: "Incoming web address",
  description: "Start an automation when another app sends data to a private address.",
  auth: { kind: "none" },
  capabilities: ["events"],
  events: [
    { name: "received", phrase: "a message arrives at this automation's web address" },
    { name: "formSubmitted", phrase: "someone submits a contact form" },
    { name: "signedUp", phrase: "someone signs up" },
  ],
  actions: [],
};

export const builtInManifests: ConnectorManifest[] = [gmail, drive, linear, http, webhook];
