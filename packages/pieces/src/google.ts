import type { SourceRecord } from "@tappet/connectors";
import { addressList, type PieceConnectorSpec } from "./adapter.js";

// Gmail and Google Drive, on the Activepieces pieces. Each action keeps the
// names Tappet workflows already use; the piece does the talking to Google.

type ParsedEmail = {
  id: string;
  subject?: string;
  from?: { text?: string };
  date?: string;
  text?: string;
};

const brief = (text = "", max = 600) => {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 3)}...` : flat;
};

/** Email, in the shape workflows reference (`email.subject`, `email.from`). */
const toEmail = (m: ParsedEmail) => ({
  id: m.id,
  subject: m.subject ?? "(no subject)",
  from: m.from?.text ?? "",
  date: m.date ? new Date(m.date).toISOString() : null,
  snippet: brief(m.text, 300),
  url: `https://mail.google.com/mail/u/0/#all/${m.id}`,
});

export const gmailSpec: PieceConnectorSpec = {
  id: "gmail",
  provider: "google",
  description: "Search your email, and send or draft messages you've approved.",
  capabilities: ["read", "search", "write"],
  actions: {
    sendEmail: {
      pieceAction: "send_email",
      phrase: "send an email",
      inputs: { to: { prop: "receiver", convert: addressList }, subject: "subject", body: "body" },
      required: ["to", "subject", "body"],
      fixed: { body_type: "plain_text", draft: false },
      output: (r) => ({ id: (r as { id?: string })?.id }),
    },
    createDraft: {
      pieceAction: "gmail_create_draft",
      phrase: "draft an email for me to check",
      inputs: { to: { prop: "receiver", convert: addressList }, subject: "subject", body: "body" },
      required: ["subject", "body"],
      fixed: { body_type: "plain_text" },
      output: (r) => ({ id: (r as { id?: string })?.id }),
    },
    searchEmail: {
      pieceAction: "gmail_search_email",
      phrase: "find emails in Gmail",
      inputs: { query: "content", from: "from", subject: "subject", maxResults: "max_results" },
      output: (r) => {
        const messages = (r as { results?: { messages?: ParsedEmail[] } })?.results?.messages ?? [];
        return { items: messages.filter((m) => !("error" in m)).map(toEmail) };
      },
    },
  },
  async search(query, run) {
    const { items } = (await run("searchEmail", { query, maxResults: 20 })) as {
      items: ReturnType<typeof toEmail>[];
    };
    return items.map((e): SourceRecord => ({
      connector: "gmail",
      id: e.id,
      kind: "email",
      title: e.subject,
      url: e.url,
      text: [e.from && `From ${e.from}.`, e.snippet].filter(Boolean).join("\n\n"),
      author: e.from,
      updatedAt: e.date ?? new Date(0).toISOString(),
    }));
  },
};

type DriveFile = { id: string; name: string; mimeType?: string; modifiedTime?: string };

const KIND: Record<string, string> = {
  "application/vnd.google-apps.document": "Google Doc",
  "application/vnd.google-apps.spreadsheet": "Google Sheet",
  "application/vnd.google-apps.presentation": "Google Slides",
  "application/pdf": "PDF",
};

/** A file, in the shape workflows reference (`file.name`, `file.url`). */
const toFile = (f: DriveFile) => ({
  id: f.id,
  name: f.name,
  kind: (f.mimeType && KIND[f.mimeType]) ?? "File",
  modifiedAt: f.modifiedTime ?? null,
  url: `https://drive.google.com/open?id=${encodeURIComponent(f.id)}`,
});

export const driveSpec: PieceConnectorSpec = {
  id: "drive",
  provider: "google",
  name: "Google Drive",
  description: "Find documents, and create files you've approved.",
  capabilities: ["read", "search", "write"],
  actions: {
    searchFiles: {
      pieceAction: "search-folder",
      phrase: "find files in Google Drive",
      // Searches the text inside files as well as their names.
      inputs: { query: "query" },
      required: ["query"],
      fixed: { queryTerm: "fullText", operator: "contains", type: "file" },
      output: (r) => ({ items: ((r as DriveFile[]) ?? []).slice(0, 50).map(toFile) }),
    },
    createTextFile: {
      pieceAction: "create_new_gdrive_file",
      phrase: "create a file in Google Drive",
      inputs: { name: "fileName", text: "text" },
      required: ["name", "text"],
      fixed: { fileType: "text/plain" },
      output: (r) => toFile(r as DriveFile),
    },
  },
  async search(query, run) {
    if (!query.trim()) return []; // Drive has no "everything open"; it needs words.
    const { items } = (await run("searchFiles", { query })) as {
      items: ReturnType<typeof toFile>[];
    };
    return items.slice(0, 20).map((f): SourceRecord => ({
      connector: "drive",
      id: f.id,
      kind: "document",
      title: f.name,
      url: f.url,
      text: `${f.kind}${f.modifiedAt ? `, changed ${f.modifiedAt.slice(0, 10)}` : ""}.`,
      updatedAt: f.modifiedAt ?? new Date(0).toISOString(),
    }));
  },
};
