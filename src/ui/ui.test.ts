// factory ui: the server's safety rules, its JSON for a fixture ledger, and starting a run.
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { request as httpRequest } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { stringify } from "yaml";
import { _resetEnvCache } from "../config/env.js";
import { HUMAN_WRITER, Ledger } from "../ledger/ledger.js";
import { replay } from "../ledger/state.js";
import { outcomes, scoreRun, stageStats } from "../report.js";
import { createRun } from "../stages/executor.js";
import { cardCommands } from "./data.js";
import { createUiServer, listen, MAX_BODY_BYTES, ROUTES, staticDir, type UiServer } from "./server.js";
import { _resetStarting } from "./start.js";
// the page's Markdown renderer (plain browser JS, no DOM needed)
import { renderMarkdown } from "./static/md.js";

const TOKEN = "test-token-0123456789abcdef";
const SECRET = "sk-ant-test-not-real-000000000000";
const gitEnv = { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" };

function makeRepo(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), "factory-ui-repo-"));
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: dir, env: gitEnv });
  for (const [p, text] of Object.entries(files)) {
    mkdirSync(join(dir, p, ".."), { recursive: true });
    writeFileSync(join(dir, p), text);
  }
  execFileSync("git", ["add", "-A"], { cwd: dir, env: gitEnv });
  execFileSync("git", ["commit", "-q", "-m", "init"], { cwd: dir, env: gitEnv });
  return dir;
}

const WEB_REPO = {
  "package.json": JSON.stringify({ dependencies: { next: "15.0.0", react: "19.0.0", "@radix-ui/react-slot": "1.0.0" } }),
  "src/app/page.tsx": `import { Button } from "@/components/ui/button";\nexport default function Home() { return <main><h1>Welcome</h1><Button>Go</Button></main>; }\n`,
  "src/app/orders/page.tsx": `export default function Orders() { return <h1>Orders</h1>; }\n`,
  "src/components/ui/button.tsx": `export function Button(p: { children: unknown }) { return <button className="px-2">{p.children as string}</button>; }\n`,
  "src/Api/Api.csproj": "<Project Sdk=\"Microsoft.NET.Sdk.Web\"></Project>\n",
};

let home: string;
let ui: UiServer;
let port: number;
let started: string[];
let ids: { delivered: string; waiting: string; parked: string };

async function addEvents(runId: string, evs: Parameters<Ledger["append"]>[0][]) {
  const l = Ledger.open(runId);
  for (const e of evs) await l.append(e, HUMAN_WRITER);
  return l;
}

const step = (key: string, costUsd = 0.5, data: Record<string, unknown> = {}, outputs: string[] = []): Parameters<Ledger["append"]>[0][] => [
  { type: "step.started", key: `${key}/1`, data: { rung: 0 } },
  { type: "usage", key: `${key}/1`, data: { "gen_ai.request.model": "claude-test", "gen_ai.usage.cost_usd": costUsd, "gen_ai.usage.input_tokens": 1000, "gen_ai.usage.output_tokens": 100 } },
  { type: "step.completed", key: `${key}/1`, outputs, data },
];

async function fixture() {
  // delivered: every step, one retry in the task, a local branch and PR text
  const delivered = await createRun("Show the order count on the orders page\n\nKeep the heading.", "web", "tester", { sources: [{ kind: "prompt" }] });
  const dl = Ledger.open(delivered);
  const planSha = dl.putJson({ tasks: [{ id: "TASK-1", fileScope: ["src/app/orders/page.tsx"] }] });
  const failSha = dl.putJson([{ check: "build", message: "CS1002: ; expected in Orders.cs", frames: [] }]);
  await addEvents(delivered, [
    ...["discover", "intake", "ground", "clarify", "specify"].flatMap((k) => step(k)),
    ...step("plan", 1, { tasks: ["TASK-1"], complexity: "S" }, [planSha]),
    ...step("approve", 0),
    { type: "step.started", key: "implement/TASK-1/1", data: { rung: 0 } },
    { type: "usage", key: "implement/TASK-1/1", data: { "gen_ai.usage.cost_usd": 0.75 } },
    { type: "step.failed", key: "implement/TASK-1/1", outputs: [failSha], data: { category: "build", signature: "abc", rung: 0, action: "retry", nextRung: 1, reason: "same rung, fresh attempt" } },
    { type: "step.started", key: "implement/TASK-1/2", data: { rung: 1 } },
    { type: "step.completed", key: "implement/TASK-1/2", data: {} },
    ...["integrate", "accept", "review"].flatMap((k) => step(k, 0.25)),
    { type: "workspace.created", data: { path: "/tmp/wt", branch: `factory/${delivered}` } },
    ...step("deliver", 0, { local: true, branch: `factory/${delivered}`, head: "a".repeat(40) }),
    { type: "run.delivered", data: { local: true, branch: `factory/${delivered}` } },
  ]);
  dl.writeCard(`pr-${delivered}`, "# factory: show the order count\n\n## What changed\n- orders page");

  // waiting on the approval card, whose text tries to inject a script
  const waiting = await createRun("Rename the orders heading", "web", "tester");
  const wl = Ledger.open(waiting);
  const bundle = "b".repeat(64);
  wl.putJson({ tasks: [{ id: "TASK-1", fileScope: ["src/app/orders/page.tsx"] }] }); // same plan, same sha
  wl.writeCard(`approval-${bundle.slice(0, 8)}`, [
    "# Approve the spec and plan", "", "> Rename <script>alert(1)</script> the heading", "",
    "UI size: **screen tweak** (src/app/orders/page.tsx: edits an existing screen). Design work: none.", "",
    "## Decide", `  factory approve ${waiting} <hash> --note "your risk note"`, `  factory reject  ${waiting} <hash> --reason "why"`, "", `Card hash: ${bundle.slice(0, 8)}`,
  ].join("\n"));
  await addEvents(waiting, [
    ...["discover", "intake", "ground", "clarify", "specify"].flatMap((k) => step(k)),
    ...step("plan", 1, { tasks: ["TASK-1"], complexity: "S" }, [planSha]),
    { type: "step.started", key: "approve/1", data: { rung: 0 } },
    { type: "step.interrupted", key: "approve/1", data: { reason: "waiting" } },
    { type: "human.requested", data: { cardId: `approval-${bundle.slice(0, 8)}`, kind: "approval", artifactSha: bundle, step: "approve" } },
  ]);

  // parked in review
  const parked = await createRun("Add an export button", "web", "tester");
  await addEvents(parked, [
    ...["discover", "intake"].flatMap((k) => step(k)),
    { type: "step.started", key: "ground/1", data: { rung: 0 } },
    { type: "step.failed", key: "ground/1", data: { category: "other", signature: "park", rung: 0, parked: true } },
    { type: "run.parked", data: { reason: "The request names a page that doesn't exist", step: "ground" } },
  ]);
  return { delivered, waiting, parked };
}

interface Res { status: number; headers: Record<string, string | string[] | undefined>; body: string; json: () => any }

function call(path: string, o: { method?: string; headers?: Record<string, string>; body?: string; token?: string | null } = {}): Promise<Res> {
  return new Promise((resolve, reject) => {
    const headers: Record<string, string> = { Host: `127.0.0.1:${port}`, ...(o.token === null ? {} : { "X-Factory-Token": o.token ?? TOKEN }), ...o.headers };
    const req = httpRequest({ host: "127.0.0.1", port, path, method: o.method ?? "GET", headers }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (c: Buffer) => chunks.push(c));
      res.on("end", () => {
        const body = Buffer.concat(chunks).toString("utf8");
        resolve({ status: res.statusCode ?? 0, headers: res.headers, body, json: () => JSON.parse(body) });
      });
    });
    req.on("error", reject);
    if (o.body !== undefined) req.write(o.body);
    req.end();
  });
}

const post = (body: unknown, headers: Record<string, string> = {}) =>
  call("/api/runs", { method: "POST", headers: { "Content-Type": "application/json", Origin: `http://127.0.0.1:${port}`, ...headers }, body: typeof body === "string" ? body : JSON.stringify(body) });

beforeEach(async () => {
  home = mkdtempSync(join(tmpdir(), "factory-ui-"));
  process.env.FACTORY_HOME = home;
  writeFileSync(join(home, ".env"), `ANTHROPIC_API_KEY=${SECRET}\n`, { mode: 0o600 });
  _resetEnvCache();
  _resetStarting();
  mkdirSync(join(home, "projects"), { recursive: true });
  writeFileSync(join(home, "projects", "web.yaml"), stringify({ project: "web", repo: makeRepo(WEB_REPO), stack: "dotnet" }));
  writeFileSync(join(home, "projects", "api.yaml"), stringify({ project: "api", repo: makeRepo({ "src/Api/Greeter.cs": "namespace Api;\n" }), stack: "dotnet" }));
  ids = await fixture();
  started = [];
  ui = createUiServer({ token: TOKEN, deps: { execute: (id) => started.push(id) } });
  port = await listen(ui, 0);
});

afterEach(async () => {
  await new Promise((r) => ui.server.close(r));
});

describe("factory ui: who can talk to it", () => {
  it("every API call needs the key; the link's key becomes an HttpOnly cookie", async () => {
    expect((await call("/api/runs", { token: null })).status).toBe(401);
    expect((await call("/api/runs", { token: "wrong" })).status).toBe(401);
    expect((await call("/api/runs")).status).toBe(200);
    expect((await call("/", { token: null })).status).toBe(401);
    expect((await call("/?t=wrong", { token: null })).status).toBe(401);
    const first = await call(`/?t=${TOKEN}`, { token: null });
    expect(first.status).toBe(302);
    const cookie = String(first.headers["set-cookie"]);
    expect(cookie).toMatch(/HttpOnly/);
    expect(cookie).toMatch(/SameSite=Strict/);
    const jar = cookie.split(";")[0]!;
    expect((await call("/", { token: null, headers: { Cookie: jar } })).body).toContain("<main id=\"view\"");
    expect((await call("/api/runs", { token: null, headers: { Cookie: jar } })).status).toBe(200);
  });

  it("a wrong Host or another site's Origin is refused", async () => {
    expect((await call("/api/runs", { headers: { Host: "evil.example:80" } })).status).toBe(403);
    expect((await call("/api/runs", { headers: { Host: `attacker.test:${port}` } })).status).toBe(403);
    expect((await call("/api/runs", { headers: { Origin: "https://evil.example" } })).status).toBe(403);
    expect((await call("/api/runs", { headers: { "Sec-Fetch-Site": "cross-site" } })).status).toBe(403);
    expect((await post({ project: "web", prompt: "Rename the orders heading please" }, { Origin: "https://evil.example" })).status).toBe(403);
    expect((await call("/api/runs", { headers: { Host: `localhost:${port}` } })).status).toBe(200);
    expect(started).toEqual([]);
  });

  it("a POST needs JSON, and a cookie alone isn't enough without a same-site Origin", async () => {
    const jar = String((await call(`/?t=${TOKEN}`, { token: null })).headers["set-cookie"]).split(";")[0]!;
    const noOrigin = await call("/api/runs", { method: "POST", token: null, headers: { Cookie: jar, "Content-Type": "application/json" }, body: "{}" });
    expect(noOrigin.status).toBe(403);
    const form = await call("/api/runs", { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded", Origin: `http://127.0.0.1:${port}` }, body: "project=web" });
    expect(form.status).toBe(415);
  });

  it("security headers and no secrets in any answer", async () => {
    const page = await call("/", { headers: { Cookie: `factory_ui=${TOKEN}` } });
    expect(page.headers["content-security-policy"]).toMatch(/script-src 'self'/);
    expect(page.headers["x-frame-options"]).toBe("DENY");
    for (const p of ["/api/projects", "/api/runs", `/api/runs/${ids.delivered}`, `/api/runs/${ids.waiting}`, `/api/runs/${ids.delivered}/design`, "/api/dashboard"]) {
      const r = await call(p);
      expect(r.status, p).toBe(200);
      expect(r.body).not.toContain(SECRET);
    }
  });
});

describe("factory ui: no decisions from the web", () => {
  it("the route list has no decision routes; the only write starts a run", () => {
    const decision = /approve|reject|answer|waive|unlock|steer|pause|stop|resume|decide|decision|cap|note/i;
    for (const r of ROUTES) expect(`${r.method} ${r.path}`).not.toMatch(decision);
    expect(ROUTES.filter((r) => r.method !== "GET").map((r) => `${r.method} ${r.path}`)).toEqual(["POST /api/runs"]);
  });

  it("decision-looking URLs don't exist", async () => {
    for (const p of [`/api/runs/${ids.waiting}/approve`, `/api/runs/${ids.waiting}/answer`, `/api/runs/${ids.waiting}/stop`]) {
      expect((await call(p, { method: "POST", headers: { "Content-Type": "application/json", Origin: `http://127.0.0.1:${port}` }, body: "{}" })).status).toBe(404);
    }
    expect(replay(Ledger.open(ids.waiting).events()).openCard?.kind).toBe("approval");
  });

  it("the page says so, and has no decision buttons", () => {
    const html = readFileSync(join(staticDir(), "index.html"), "utf8");
    expect(html).toContain("Decisions are made in your terminal, so no AI or script can approve its own plan.");
    const js = readFileSync(join(staticDir(), "app.js"), "utf8");
    expect(js).not.toMatch(/method: "POST"[^\n]*\/(approve|reject|answer|waive|stop|pause)/);
    // the only raw HTML the page writes is the escaped Markdown renderer's output
    expect(js.match(/innerHTML/g)).toHaveLength(1);
    expect(js).toContain("el.innerHTML = renderMarkdown(text)");
  });
});

describe("factory ui: what the screens show", () => {
  it("runs list", async () => {
    const rows = (await call("/api/runs")).json() as any[];
    expect(rows).toHaveLength(3);
    const by = Object.fromEntries(rows.map((r) => [r.runId, r]));
    expect(by[ids.delivered]).toMatchObject({ project: "web", status: "delivered", step: "deliver", request: "Show the order count on the orders page" });
    expect(by[ids.delivered].costUsd).toBeCloseTo(0.5 * 5 + 1 + 0.75 + 0.25 * 3);
    expect(by[ids.waiting]).toMatchObject({ status: "waiting", openCard: "approval", step: "approve" });
    expect(by[ids.parked]).toMatchObject({ status: "parked", parkedReason: "The request names a page that doesn't exist" });
  });

  it("run view: timeline in order with retries, delivery, evidence", async () => {
    const r = (await call(`/api/runs/${ids.delivered}`)).json();
    const steps = r.timeline.map((t: any) => t.step);
    expect(steps.slice(0, 3)).toEqual(["discover", "intake", "ground"]);
    expect(steps.indexOf("implement/TASK-1")).toBeGreaterThan(steps.indexOf("approve"));
    expect(steps[steps.length - 1]).toBe("deliver");
    const task = r.timeline.find((t: any) => t.step === "implement/TASK-1");
    expect(task).toMatchObject({ status: "completed", attempts: 2 });
    expect(task.tries[0]).toMatchObject({ attempt: 1, outcome: "failed", why: "CS1002: ; expected in Orders.cs", next: "retry: same rung, fresh attempt" });
    expect(task.tries[1]).toMatchObject({ attempt: 2, outcome: "completed", rung: 1 });
    expect(r.cost.capUsd).toBe(3.5 + 10); // spent up to the plan + the size cap (at least $10)
    expect(r.delivered).toMatchObject({ branch: `factory/${ids.delivered}`, local: true, evidence: { ok: true, total: 0 } });
    expect(r.delivered.prText).toContain("## What changed");
    expect(r.card).toBeUndefined();
  });

  it("run view: the open card is read-only text with the commands to paste", async () => {
    const r = (await call(`/api/runs/${ids.waiting}`)).json();
    expect(r.card.kind).toBe("approval");
    expect(r.card.markdown).toContain("<script>alert(1)</script>"); // raw in JSON; the page escapes it
    expect(r.card.commands).toEqual([
      `factory show-card ${ids.waiting}`,
      `factory approve ${ids.waiting} bbbbbbbb --note "your risk note"`,
      `factory reject ${ids.waiting} bbbbbbbb --reason "why"`,
    ]);
    expect(r.timeline.find((t: any) => t.step === "approve").status).toBe("waiting");
    const p = (await call(`/api/runs/${ids.parked}`)).json();
    expect(p.timeline.find((t: any) => t.step === "ground")).toMatchObject({ status: "parked", note: "The request names a page that doesn't exist" });
  });

  it("card commands: question and limit cards too", () => {
    expect(cardCommands("Answer with letters:\n  factory answer r1 abcd1234 Q-1=A Q-2=A\n  (use quotes)", "r1", "abcd1234"))
      .toEqual(["factory show-card r1", "factory answer r1 abcd1234 Q-1=A Q-2=A"]);
    expect(cardCommands("  factory waive-cap r1 cafe0000 --cost 20\nOr stop here: factory stop r1", "r1", "cafe0000"))
      .toEqual(["factory show-card r1", "factory waive-cap r1 cafe0000 --cost 20", "factory stop r1"]);
  });

  it("dashboard: the same numbers as report --all --json", async () => {
    const d = (await call("/api/dashboard")).json();
    const runs = Ledger.listRuns().map((id) => scoreRun(Ledger.open(id)));
    expect(d).toEqual(JSON.parse(JSON.stringify({ outcomes: outcomes(runs), stages: stageStats(runs) })));
    expect(d.outcomes).toMatchObject({ runs: 3, delivered: 1, parked: 1, waiting: 1 });
  });

  it("design: UI size from the plan's files, and the app's pages and building blocks", async () => {
    const d = (await call(`/api/runs/${ids.waiting}/design`)).json();
    expect(d.uiSize.size).toMatchObject({ level: "tweak" });
    expect(d.uiSize.approvalCardLine).toBe("UI size: **screen tweak** (src/app/orders/page.tsx: edits an existing screen). Design work: none.");
    expect(d.inventory.pages.map((p: any) => p.route).sort()).toEqual(["/", "/orders"]);
    expect(d.inventory.buildingBlocks).toEqual([{ name: "Button", path: "src/components/ui/button.tsx", uses: 1, variants: [] }]);
    expect(d.styleChecks).toEqual([]);
    const parked = (await call(`/api/runs/${ids.parked}/design`)).json();
    expect(parked.uiSize.none).toMatch(/plan isn't done/);
  });

  it("design: a .NET-only repo has no web UI", async () => {
    const runId = await createRun("Greet people with Hello instead of Hi", "api", "tester");
    const d = (await call(`/api/runs/${runId}/design`)).json();
    expect(d.inventory.none).toMatch(/No web UI found/);
  });

  it("unknown run → 404", async () => {
    expect((await call("/api/runs/nope-nope")).status).toBe(404);
    expect((await call("/api/runs/..%2F..%2Fetc")).status).toBe(404);
  });
});

describe("factory ui: starting a run", () => {
  const count = () => Ledger.listRuns().length;

  it("bad input is refused before any run exists", async () => {
    const before = count();
    const cases: [unknown, number, RegExp][] = [
      [{ project: "nope", prompt: "Rename the orders heading" }, 400, /No project "nope"/],
      [{ prompt: "Rename the orders heading" }, 400, /Pick a project/],
      [{ project: "web", prompt: "   " }, 400, /Give a request/],
      [{ project: "web", prompt: "Rename it", maxCost: 25 }, 400, /can only lower the normal limit.*\$20/],
      [{ project: "web", prompt: "Rename it", maxCost: -1 }, 400, /positive number/],
      [{ project: "web", file: { name: "req.exe", text: "Rename the orders heading" } }, 400, /\.md\) or text/],
      [{ project: "web", file: { name: "big.md", text: "x".repeat(150_000) } }, 400, /split the request/],
      [{ project: "web", file: { name: "empty.md", text: " " } }, 400, /empty or too short/],
      [{ project: "web", jira: "ABC-12" }, 400, /add JIRA_BASE_URL/],
    ];
    for (const [body, status, msg] of cases) {
      const r = await post(body);
      expect(r.status, JSON.stringify(body).slice(0, 80)).toBe(status);
      expect(r.json().error).toMatch(msg);
    }
    expect((await post(JSON.stringify({ project: "web", file: { name: "a.md", text: "x".repeat(MAX_BODY_BYTES) } }))).status).toBe(413);
    expect((await post("{not json")).status).toBe(400);
    expect(count()).toBe(before);
    expect(started).toEqual([]);
  });

  it("a good request creates the run like factory start and executes it in the background", async () => {
    const r = await post({ project: "web", prompt: "Rename the orders heading to Your orders", file: { name: "notes.md", text: "# Notes\n\nKeep the count next to it." }, maxCost: "8" });
    expect(r.status).toBe(201);
    const { runId, from } = r.json();
    expect(from).toBe("typed prompt + notes.md");
    expect(started).toEqual([runId]);
    const s = replay(Ledger.open(runId).events());
    expect(s.info.request).toBe("## Typed request\n\nRename the orders heading to Your orders\n\n## From notes.md\n\n# Notes\n\nKeep the count next to it.");
    expect(s.info.sources).toEqual([{ kind: "prompt" }, { kind: "file", name: "notes.md" }]);
    expect(s.info.maxCostUsd).toBe(8);
    expect(s.info.project).toBe("web");
    expect((Ledger.open(runId).events()[0]!.data as { operator: string }).operator).toMatch(/\(via web\)$/);
    // a second run on the same project waits until this one stops
    const again = await post({ project: "web", prompt: "Another change to the orders page" });
    expect(again.status).toBe(409);
    expect(again.json().error).toContain(runId);
    // other projects are free
    expect((await post({ project: "api", prompt: "Greet people with Hello instead of Hi" })).status).toBe(201);
  });
});

describe("factory ui: the card renderer escapes everything", () => {
  it("a card with <script> renders as text", () => {
    const html = renderMarkdown("# Title <img src=x onerror=alert(1)>\n\n> Rename <script>alert(1)</script>\n\n**bold** and `code`\n  factory approve r1 <hash>\n- item <b>x</b>");
    expect(html).not.toMatch(/<script|<img|<b>/);
    expect(html).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
    expect(html).toContain("&lt;img src=x onerror=alert(1)&gt;");
    expect(html).toContain("<strong>bold</strong>");
    expect(html).toContain("<code>code</code>");
    expect(html).toContain("<pre><code>factory approve r1 &lt;hash&gt;</code></pre>");
    expect(html).toContain("<li>item &lt;b&gt;x&lt;/b&gt;</li>");
    expect(renderMarkdown('`"quoted"` and \'x\'')).toBe("<p><code>&quot;quoted&quot;</code> and &#39;x&#39;</p>");
  });
});
