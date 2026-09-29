import http from "node:http";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { _resetEnvCache } from "../config/env.js";
import { adfToText, fetchJiraTicket, JiraError, parseJiraKey } from "./jira.js";
import { describeSources, gatherRequest } from "./request.js";

let server: http.Server | undefined;
beforeEach(() => {
  process.env.FACTORY_HOME = mkdtempSync(join(tmpdir(), "factory-src-"));
  _resetEnvCache();
});
afterEach(() => server?.close());

const ADF = {
  type: "doc", content: [
    { type: "paragraph", content: [{ type: "text", text: "Course titles show " }, { type: "text", text: "' - (P)'" }, { type: "text", text: " when there is no period." }] },
    { type: "heading", attrs: { level: 3 }, content: [{ type: "text", text: "Acceptance criteria" }] },
    { type: "bulletList", content: [
      { type: "listItem", content: [{ type: "paragraph", content: [{ type: "text", text: "period 0 → no marker" }] }] },
      { type: "listItem", content: [{ type: "paragraph", content: [{ type: "text", text: "period empty → no marker" }] }] },
    ] },
  ],
};

function fakeJira(status: number, body: unknown) {
  const seen: { url: string; auth?: string }[] = [];
  server = http.createServer((req, res) => {
    seen.push({ url: req.url ?? "", auth: req.headers.authorization });
    res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(body));
  });
  return new Promise<{ base: string; seen: typeof seen }>((resolve) =>
    server!.listen(0, "127.0.0.1", () => resolve({ base: `http://127.0.0.1:${(server!.address() as { port: number }).port}`, seen })));
}
function jiraEnv(base: string) {
  writeFileSync(join(process.env.FACTORY_HOME!, ".env"), `JIRA_BASE_URL=${base}\nJIRA_EMAIL=me@example.com\nJIRA_API_TOKEN=tok-123456789\n`, { mode: 0o600 });
  _resetEnvCache();
}

describe("Jira as a request source", () => {
  it("reads keys and links", () => {
    expect(parseJiraKey("SHOP-412")).toBe("SHOP-412");
    expect(parseJiraKey("https://acme.atlassian.net/browse/SHOP-412")).toBe("SHOP-412");
    expect(parseJiraKey("https://acme.atlassian.net/browse/SHOP-412?focusedCommentId=1")).toBe("SHOP-412");
    expect(() => parseJiraKey("fix the bug")).toThrow(JiraError);
  });

  it("turns Jira rich text into readable text", () => {
    const t = adfToText(ADF);
    expect(t).toContain("Course titles show ' - (P)' when there is no period.");
    expect(t).toContain("### Acceptance criteria");
    expect(t).toContain("- period 0 → no marker\n- period empty → no marker");
  });

  it("fetches a ticket with the saved login and builds the request text", async () => {
    const { base, seen } = await fakeJira(200, {
      key: "SHOP-412",
      fields: {
        summary: "Hide empty period marker", description: ADF, issuetype: { name: "Bug" }, priority: { name: "High" }, status: { name: "To Do" }, labels: ["titles"],
        comment: { comments: [{ author: { displayName: "Sara" }, body: { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "Also for null." }] }] } }] },
      },
    });
    jiraEnv(base);
    const t = await fetchJiraTicket("SHOP-412");
    expect(seen[0]!.url).toBe("/rest/api/3/issue/SHOP-412?fields=summary,description,issuetype,priority,labels,status,comment");
    expect(seen[0]!.auth).toBe(`Basic ${Buffer.from("me@example.com:tok-123456789").toString("base64")}`);
    expect(t).toMatchObject({ key: "SHOP-412", summary: "Hide empty period marker", url: `${base}/browse/SHOP-412` });
    expect(t.text).toMatch(/^Jira SHOP-412: Hide empty period marker\nType: Bug · Priority: High · Status: To Do · Labels: titles/);
    expect(t.text).toContain("- Sara: Also for null.");
  });

  it("explains login, missing-ticket and not-set-up problems in plain words", async () => {
    await expect(fetchJiraTicket("SHOP-1")).rejects.toThrow(/add JIRA_BASE_URL/);
    const a = await fakeJira(401, {});
    jiraEnv(a.base);
    await expect(fetchJiraTicket("SHOP-1")).rejects.toThrow(/refused the login/);
    server!.close();
    const b = await fakeJira(404, {});
    jiraEnv(b.base);
    await expect(fetchJiraTicket("SHOP-1")).rejects.toThrow(/wasn't found/);
  });
});

describe("gathering a request", () => {
  const fakeTicket = async () => ({ key: "SHOP-9", url: "https://x/browse/SHOP-9", summary: "Fix", text: "Jira SHOP-9: Fix\n\nDo the thing." });

  it("one source: its text as is", async () => {
    expect((await gatherRequest({ prompt: "  Return 404 for missing orders  " })).text).toBe("Return 404 for missing orders");
    const r = await gatherRequest({ jira: "SHOP-9" }, { fetchJira: fakeTicket });
    expect(r.text).toBe("Jira SHOP-9: Fix\n\nDo the thing.");
    expect(r.sources).toEqual([{ kind: "jira", key: "SHOP-9", url: "https://x/browse/SHOP-9", summary: "Fix" }]);
  });

  it("several sources: labelled sections, all recorded", async () => {
    const dir = mkdtempSync(join(tmpdir(), "req-"));
    writeFileSync(join(dir, "notes.md"), "Keep the old title for archived courses.");
    const r = await gatherRequest({ prompt: "Only the course list page.", file: join(dir, "notes.md"), jira: "SHOP-9" }, { fetchJira: fakeTicket });
    expect(r.text).toBe("## Typed request\n\nOnly the course list page.\n\n## From notes.md\n\nKeep the old title for archived courses.\n\n## Jira SHOP-9\n\nJira SHOP-9: Fix\n\nDo the thing.");
    expect(describeSources(r.sources)).toBe("typed prompt + notes.md + Jira SHOP-9");
  });

  it("nothing given, or too big: refused before a run exists", async () => {
    await expect(gatherRequest({})).rejects.toThrow(/Give a request/);
    await expect(gatherRequest({ jira: "SHOP-9" }, { fetchJira: async () => ({ ...(await fakeTicket()), text: "x".repeat(120_000) }) })).rejects.toThrow(/shorten or split/);
  });
});
