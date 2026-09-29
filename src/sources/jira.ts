// Jira as a request source: the factory (not a model) fetches the ticket by its key, turns it into plain
// text, and the text is treated as untrusted input like a typed prompt (context-builder §2.2).
// Credentials only from ~/.factory/.env: JIRA_BASE_URL, JIRA_EMAIL, JIRA_API_TOKEN.
import { secret } from "../config/env.js";

export interface JiraTicket { key: string; url: string; summary: string; text: string }

export class JiraError extends Error {}

/** "ABC-123" or ".../browse/ABC-123" → "ABC-123" */
export function parseJiraKey(input: string): string {
  const m = /([A-Z][A-Z0-9_]+-\d+)(?:[/?#].*)?$/.exec(input.trim());
  if (!m) throw new JiraError(`"${input}" isn't a Jira ticket key like ABC-123 (or a link to one).`);
  return m[1]!;
}

type Adf = { type?: string; text?: string; content?: Adf[]; attrs?: Record<string, unknown> };

/** Atlassian Document Format → readable plain text (lists, headings, code, links kept simple). */
export function adfToText(node: unknown, depth = 0): string {
  if (!node) return "";
  if (typeof node === "string") return node;
  const n = node as Adf;
  const kids = (sep = "") => (n.content ?? []).map((c) => adfToText(c, depth + 1)).join(sep);
  switch (n.type) {
    case "doc": return kids("\n").replace(/\n{3,}/g, "\n\n").trim();
    case "text": return n.text ?? "";
    case "hardBreak": return "\n";
    case "paragraph": return `${kids()}\n`;
    case "heading": return `${"#".repeat(Number(n.attrs?.level ?? 2))} ${kids()}\n`;
    case "bulletList": return (n.content ?? []).map((li) => `- ${adfToText(li, depth + 1).trim()}`).join("\n") + "\n";
    case "orderedList": return (n.content ?? []).map((li, i) => `${i + 1}. ${adfToText(li, depth + 1).trim()}`).join("\n") + "\n";
    case "listItem": return kids("\n");
    case "codeBlock": return `\`\`\`\n${kids()}\n\`\`\`\n`;
    case "blockquote": return kids("\n").split("\n").map((l) => `> ${l}`).join("\n") + "\n";
    case "rule": return "---\n";
    case "mention": return String(n.attrs?.text ?? "@someone");
    case "emoji": return String(n.attrs?.text ?? "");
    case "inlineCard": case "blockCard": return String(n.attrs?.url ?? "");
    case "table": return (n.content ?? []).map((row) => (row.content ?? []).map((cell) => adfToText(cell, depth + 1).trim().replace(/\n/g, " ")).join(" | ")).join("\n") + "\n";
    default: return kids(n.type && /block|panel|expand|mediaGroup/.test(n.type) ? "\n" : "");
  }
}

export function jiraConfigured(): boolean {
  return !!(secret("JIRA_BASE_URL") && secret("JIRA_EMAIL") && secret("JIRA_API_TOKEN"));
}

/** Fetch a ticket: summary, type, priority, labels, description and the latest comments. */
export async function fetchJiraTicket(keyOrUrl: string, opts: { maxComments?: number; fetchFn?: typeof fetch } = {}): Promise<JiraTicket> {
  const key = parseJiraKey(keyOrUrl);
  const base = (secret("JIRA_BASE_URL") ?? "").replace(/\/+$/, "");
  const email = secret("JIRA_EMAIL");
  const token = secret("JIRA_API_TOKEN");
  if (!base || !email || !token) {
    throw new JiraError("To use --jira, add JIRA_BASE_URL (e.g. https://yourcompany.atlassian.net), JIRA_EMAIL and JIRA_API_TOKEN to ~/.factory/.env.");
  }
  if (!/^https:\/\//.test(base) && !/^http:\/\/127\.0\.0\.1[:/]/.test(base)) throw new JiraError("JIRA_BASE_URL must start with https://");
  const f = opts.fetchFn ?? fetch;
  const url = `${base}/rest/api/3/issue/${encodeURIComponent(key)}?fields=summary,description,issuetype,priority,labels,status,comment`;
  let res: Response;
  try {
    res = await f(url, { headers: { Authorization: `Basic ${Buffer.from(`${email}:${token}`).toString("base64")}`, Accept: "application/json" } });
  } catch (e) {
    throw new JiraError(`Couldn't reach Jira at ${base}: ${(e as Error).message}`);
  }
  if (res.status === 401 || res.status === 403) throw new JiraError(`Jira refused the login (HTTP ${res.status}). Check JIRA_EMAIL and JIRA_API_TOKEN.`);
  if (res.status === 404) throw new JiraError(`Ticket ${key} wasn't found, or this login can't see it.`);
  if (!res.ok) throw new JiraError(`Jira answered HTTP ${res.status} for ${key}.`);
  const j = (await res.json()) as { key: string; fields: Record<string, unknown> };
  const fl = j.fields;
  const name = (o: unknown) => (o && typeof o === "object" ? String((o as { name?: string }).name ?? "") : "");
  const comments = ((fl.comment as { comments?: { author?: { displayName?: string }; body?: unknown; created?: string }[] } | undefined)?.comments ?? [])
    .slice(-(opts.maxComments ?? 5));
  const summary = String(fl.summary ?? "").trim();
  const lines = [
    `Jira ${j.key}: ${summary}`,
    [name(fl.issuetype) && `Type: ${name(fl.issuetype)}`, name(fl.priority) && `Priority: ${name(fl.priority)}`, name(fl.status) && `Status: ${name(fl.status)}`,
      Array.isArray(fl.labels) && fl.labels.length ? `Labels: ${(fl.labels as string[]).join(", ")}` : ""].filter(Boolean).join(" · "),
    "",
    adfToText(fl.description) || "(no description)",
    ...(comments.length ? ["", "Latest comments:", ...comments.map((c) => `- ${c.author?.displayName ?? "someone"}: ${adfToText(c.body).replace(/\n+/g, " ").trim()}`)] : []),
  ];
  return { key: j.key, url: `${base}/browse/${j.key}`, summary, text: lines.join("\n").trim() };
}
