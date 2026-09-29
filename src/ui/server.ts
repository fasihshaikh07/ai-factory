// `factory ui`: a small local web app to start runs and watch them. node:http only, plain files.
// It can NEVER answer, approve, reject, waive, unlock, steer, pause or stop: decisions are TTY-only
// (ledger/human.ts), so no AI or script can approve its own plan. Cards are shown read-only with the
// terminal command to paste.
// Safety: bound to 127.0.0.1; a random token per start (in the printed link, then an HttpOnly
// cookie) on every API call; Host and Origin checked so another website can't drive it; JSON-only
// POSTs; a 1 MB body limit; no secrets or .env values are ever sent.
import { randomBytes, timingSafeEqual } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import "../gates/predicates.js";
import "../design/gates.js";
import { REPO_ROOT } from "../runners/netinfra.js";
import { dashboardView, designView, findRun, projectsView, runView, runsView } from "./data.js";
import { startRun, StartError, type StartDeps } from "./start.js";

export const MAX_BODY_BYTES = 1_000_000;
const COOKIE = "factory_ui";

type Json = Record<string, unknown> | unknown[];
interface Reply { status: number; json: unknown }
interface Route {
  method: "GET" | "POST";
  /** "/api/runs/:id" */
  path: string;
  what: string;
  handle(params: Record<string, string>, body: unknown, deps: StartDeps): Promise<Reply> | Reply;
}

const ok = (json: Json): Reply => ({ status: 200, json });
const notFound = (what: string): Reply => ({ status: 404, json: { error: what } });

/** Every API route. Read-only except starting a run; there is deliberately no decision route. */
export const ROUTES: readonly Route[] = [
  { method: "GET", path: "/api/projects", what: "projects and whether Jira is set up", handle: async () => ok(await projectsView()) },
  { method: "GET", path: "/api/runs", what: "recent runs", handle: () => ok(runsView()) },
  {
    method: "GET", path: "/api/runs/:id", what: "one run: timeline, cost, trace, open card (read-only), delivery",
    handle: ({ id }) => { const l = findRun(id!); return l ? ok(runView(l)) : notFound(`No run ${id}`); },
  },
  {
    method: "GET", path: "/api/runs/:id/design", what: "the design step's data for a run",
    handle: ({ id }) => { const l = findRun(id!); return l ? ok(designView(l)) : notFound(`No run ${id}`); },
  },
  { method: "GET", path: "/api/dashboard", what: "outcomes and the per-stage table across runs", handle: () => ok(dashboardView()) },
  {
    method: "POST", path: "/api/runs", what: "start a run (same checks as factory start), executed in the background",
    handle: async (_p, body, deps) => {
      try {
        const r = await startRun((body ?? {}) as Record<string, unknown>, deps);
        return { status: 201, json: r };
      } catch (e) {
        if (e instanceof StartError) return { status: e.status, json: { error: e.message } };
        return { status: 400, json: { error: (e as Error).message } };
      }
    },
  },
];

function match(route: Route, method: string, path: string): Record<string, string> | undefined {
  if (route.method !== method) return undefined;
  const a = route.path.split("/"), b = path.split("/");
  if (a.length !== b.length) return undefined;
  const params: Record<string, string> = {};
  for (let i = 0; i < a.length; i++) {
    if (a[i]!.startsWith(":")) {
      try { params[a[i]!.slice(1)] = decodeURIComponent(b[i]!); } catch { return undefined; }
    } else if (a[i] !== b[i]) return undefined;
  }
  return params;
}

// ---------- static files ----------

const here = fileURLToPath(new URL(".", import.meta.url));
/** dist/ui/static (copied by the build), or the sources when running with tsx */
export function staticDir(): string {
  const built = join(here, "static");
  return existsSync(built) ? built : join(REPO_ROOT, "src", "ui", "static");
}

const STATIC: Record<string, { file: string; type: string }> = {
  "/app.js": { file: "app.js", type: "text/javascript; charset=utf-8" },
  "/md.js": { file: "md.js", type: "text/javascript; charset=utf-8" },
  "/theme.js": { file: "theme.js", type: "text/javascript; charset=utf-8" },
  "/app.css": { file: "app.css", type: "text/css; charset=utf-8" },
  "/favicon.svg": { file: "favicon.svg", type: "image/svg+xml" },
};

const SECURITY_HEADERS = {
  "Content-Security-Policy": "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY",
  "Referrer-Policy": "no-referrer",
  "Cross-Origin-Opener-Policy": "same-origin",
  "Cross-Origin-Resource-Policy": "same-origin",
};

// ---------- server ----------

export interface UiServerOptions {
  /** fixed token (tests); default: random per start */
  token?: string;
  deps?: StartDeps;
}

export interface UiServer { server: Server; token: string }

function sameToken(a: string | undefined, b: string): boolean {
  if (!a) return false;
  const x = Buffer.from(a), y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

function cookieToken(req: IncomingMessage): string | undefined {
  for (const part of (req.headers.cookie ?? "").split(";")) {
    const [k, ...v] = part.trim().split("=");
    if (k === COOKIE) return v.join("=");
  }
  return undefined;
}

function send(res: ServerResponse, status: number, body: string | Buffer, type: string, extra: Record<string, string> = {}): void {
  res.writeHead(status, { ...SECURITY_HEADERS, "Content-Type": type, "Cache-Control": "no-store", ...extra });
  res.end(body);
}

const sendJson = (res: ServerResponse, status: number, json: unknown) => send(res, status, JSON.stringify(json), "application/json; charset=utf-8");

async function readBody(req: IncomingMessage): Promise<string | "too-big"> {
  if (Number(req.headers["content-length"] ?? 0) > MAX_BODY_BYTES) return "too-big";
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const c of req) {
    size += (c as Buffer).length;
    if (size > MAX_BODY_BYTES) return "too-big";
    chunks.push(c as Buffer);
  }
  return Buffer.concat(chunks).toString("utf8");
}

const LOCKED_PAGE = `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>AI Factory</title>
<meta name="viewport" content="width=device-width, initial-scale=1"><link rel="stylesheet" href="/app.css"></head>
<body><main class="locked"><h1>AI Factory</h1><p>Open the link that <code>factory ui</code> printed in your terminal. It carries the key for this session.</p></main></body></html>`;

export function createUiServer(opts: UiServerOptions = {}): UiServer {
  const token = opts.token ?? randomBytes(24).toString("base64url");
  const deps = opts.deps ?? {};

  const server = createServer((req, res) => {
    handle(req, res).catch((e: Error) => {
      if (!res.headersSent) sendJson(res, 500, { error: e.message.split("\n")[0] });
      else res.end();
    });
  });

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const port = (server.address() as AddressInfo | null)?.port;
    const allowedHosts = [`127.0.0.1:${port}`, `localhost:${port}`];
    // a page on another site (or a rebound DNS name) can't talk to this server
    if (!allowedHosts.includes(String(req.headers.host ?? ""))) return send(res, 403, "Wrong host.", "text/plain; charset=utf-8");
    const origin = req.headers.origin;
    if (origin !== undefined && !allowedHosts.map((h) => `http://${h}`).includes(origin)) return sendJson(res, 403, { error: "Cross-origin requests are refused." });
    if (req.headers["sec-fetch-site"] === "cross-site") return sendJson(res, 403, { error: "Cross-site requests are refused." });

    const url = new URL(req.url ?? "/", `http://${req.headers.host}`);
    const path = url.pathname;
    const method = req.method ?? "GET";
    const headerToken = typeof req.headers["x-factory-token"] === "string" ? req.headers["x-factory-token"] : undefined;
    const authed = sameToken(headerToken, token) || sameToken(cookieToken(req), token);

    if (method === "GET" && STATIC[path]) {
      const f = STATIC[path]!;
      return send(res, 200, readFileSync(join(staticDir(), f.file)), f.type);
    }
    if (method === "GET" && (path === "/" || path === "/index.html")) {
      const t = url.searchParams.get("t");
      if (t !== null) {
        if (!sameToken(t, token)) return send(res, 401, LOCKED_PAGE, "text/html; charset=utf-8");
        // the key moves into an HttpOnly cookie and out of the address bar
        return send(res, 302, "", "text/plain", { Location: "/", "Set-Cookie": `${COOKIE}=${token}; HttpOnly; SameSite=Strict; Path=/` });
      }
      if (!authed) return send(res, 401, LOCKED_PAGE, "text/html; charset=utf-8");
      return send(res, 200, readFileSync(join(staticDir(), "index.html")), "text/html; charset=utf-8");
    }
    if (!path.startsWith("/api/")) return send(res, 404, "Not found.", "text/plain; charset=utf-8");

    if (!authed) return sendJson(res, 401, { error: "Missing or wrong key. Open the link factory ui printed." });
    let params: Record<string, string> | undefined;
    const route = ROUTES.find((r) => (params = match(r, method, path)) !== undefined);
    if (!route) {
      const exists = ROUTES.some((r) => match({ ...r, method: method as Route["method"] }, method, path));
      return sendJson(res, exists ? 405 : 404, { error: exists ? "Method not allowed." : "No such endpoint." });
    }
    let body: unknown;
    if (method === "POST") {
      // a browser only sends JSON with a preflight, which this server never allows cross-origin
      if (!String(req.headers["content-type"] ?? "").startsWith("application/json")) return sendJson(res, 415, { error: "Send JSON." });
      // a cookie alone isn't enough without a same-site Origin (curl sends the key in a header)
      if (origin === undefined && !sameToken(headerToken, token)) return sendJson(res, 403, { error: "A POST needs the page's origin or the key header." });
      const raw = await readBody(req);
      if (raw === "too-big") return sendJson(res, 413, { error: `The request is over ${MAX_BODY_BYTES / 1_000_000} MB.` });
      try { body = raw ? JSON.parse(raw) : {}; } catch { return sendJson(res, 400, { error: "Bad JSON." }); }
    }
    const r = await route.handle(params!, body, deps);
    return sendJson(res, r.status, r.json);
  }

  return { server, token };
}

/** Listen on 127.0.0.1 only. Tries the next ports when the default one is taken. */
export async function listen(ui: UiServer, port: number, tries = 1): Promise<number> {
  for (let i = 0; i < tries; i++) {
    const p = port === 0 ? 0 : port + i;
    try {
      await new Promise<void>((resolve, reject) => {
        const onErr = (e: Error) => { ui.server.off("listening", onOk); reject(e); };
        const onOk = () => { ui.server.off("error", onErr); resolve(); };
        ui.server.once("error", onErr).once("listening", onOk);
        ui.server.listen(p, "127.0.0.1");
      });
      return (ui.server.address() as AddressInfo).port;
    } catch (e) {
      if ((e as { code?: string }).code !== "EADDRINUSE" || i === tries - 1) throw e;
    }
  }
  throw new Error("no free port");
}
