// Where a request comes from: a typed prompt, a Markdown/text file, or a Jira ticket (any one, or several).
import { fetchJiraTicket } from "./jira.js";
import { MAX_REQUEST_FILE_BYTES, readRequestFile } from "../stages/executor.js";

export interface RequestSource { kind: "prompt" | "file" | "jira"; name?: string; key?: string; url?: string; summary?: string }

export interface GatheredRequest { text: string; sources: RequestSource[] }

export async function gatherRequest(
  o: { prompt?: string; file?: string; jira?: string },
  deps: { fetchJira?: typeof fetchJiraTicket } = {},
): Promise<GatheredRequest> {
  const parts: { heading: string; text: string; source: RequestSource }[] = [];
  if (o.prompt?.trim()) parts.push({ heading: "Typed request", text: o.prompt.trim(), source: { kind: "prompt" } });
  if (o.file) {
    const f = readRequestFile(o.file);
    parts.push({ heading: `From ${f.name}`, text: f.text, source: { kind: "file", name: f.name } });
  }
  if (o.jira) {
    const t = await (deps.fetchJira ?? fetchJiraTicket)(o.jira);
    parts.push({ heading: `Jira ${t.key}`, text: t.text, source: { kind: "jira", key: t.key, url: t.url, summary: t.summary } });
  }
  if (!parts.length) throw new Error('Give a request: a prompt, --file request.md, or --jira ABC-123 (or several).');
  // one source: its text as is; several: labelled sections
  const text = parts.length === 1 ? parts[0]!.text : parts.map((p) => `## ${p.heading}\n\n${p.text}`).join("\n\n");
  if (Buffer.byteLength(text) > MAX_REQUEST_FILE_BYTES) {
    throw new Error(`The request is ${Math.round(Buffer.byteLength(text) / 1000)} KB. The intake step reads about 25 KB; shorten or split it.`);
  }
  return { text, sources: parts.map((p) => p.source) };
}

/** "request.md + Jira ABC-12" for cards and the PR. */
export function describeSources(sources: RequestSource[] | undefined): string {
  if (!sources?.length) return "";
  return sources.map((s) => (s.kind === "prompt" ? "typed prompt" : s.kind === "file" ? s.name! : `Jira ${s.key}`)).join(" + ");
}
