// Factory egress proxy. No dependencies; runs in a small container on an internal network.
//   MODE=api   → reverse proxy: /anthropic/* → https://api.anthropic.com/*, adds the API key.
//                The agent container never holds the key and can reach nothing else.
//   MODE=feeds → forward proxy: HTTPS CONNECT only to allowlisted hosts (package feeds).
// POC limit: feeds are allowlisted by host, not URL prefix (verify-runner §2.3 wants TLS
// termination with a factory CA; not built yet).
import http from "node:http";
import https from "node:https";
import net from "node:net";

const MODE = process.env.MODE ?? "api";
const PORT = Number(process.env.PORT ?? (MODE === "api" ? 8080 : 3128));
const ALLOW = (process.env.ALLOW_HOSTS ?? "api.nuget.org,globalcdn.nuget.org,registry.npmjs.org").split(",").map((s) => s.trim()).filter(Boolean);
const UPSTREAMS = {
  anthropic: { host: "api.anthropic.com", keyHeader: "x-api-key", key: process.env.ANTHROPIC_API_KEY },
  openai: { host: "api.openai.com", keyHeader: "authorization", key: process.env.OPENAI_API_KEY ? `Bearer ${process.env.OPENAI_API_KEY}` : undefined },
};
const STRIP = new Set(["host", "x-api-key", "authorization", "connection", "proxy-authorization", "proxy-connection"]);

export function hostAllowed(host, allow = ALLOW) {
  const h = String(host).toLowerCase().replace(/:\d+$/, "");
  return allow.some((a) => h === a.toLowerCase());
}

export function route(url) {
  const m = /^\/(anthropic|openai)(\/.*)$/.exec(url ?? "");
  if (!m) return undefined;
  return { name: m[1], path: m[2] };
}

function log(msg) {
  process.stdout.write(`${new Date().toISOString()} ${MODE} ${msg}\n`);
}

function apiServer() {
  return http.createServer((req, res) => {
    const r = route(req.url);
    const up = r && UPSTREAMS[r.name];
    if (!up || !up.key) {
      res.writeHead(403).end("blocked by factory proxy");
      log(`deny ${req.method} ${req.url}`);
      return;
    }
    const headers = {};
    for (const [k, v] of Object.entries(req.headers)) if (!STRIP.has(k.toLowerCase())) headers[k] = v;
    headers[up.keyHeader] = up.key;
    headers.host = up.host;
    const out = https.request({ host: up.host, port: 443, method: req.method, path: r.path, headers }, (upRes) => {
      res.writeHead(upRes.statusCode ?? 502, upRes.headers);
      upRes.pipe(res);
    });
    out.on("error", (e) => { log(`upstream error ${e.message}`); if (!res.headersSent) res.writeHead(502); res.end(); });
    req.pipe(out);
    log(`${req.method} ${r.name}${r.path.split("?")[0]}`);
  });
}

function feedServer() {
  const server = http.createServer((req, res) => {
    res.writeHead(403).end("only HTTPS CONNECT to package feeds is allowed");
    log(`deny plain ${req.method} ${req.url}`);
  });
  server.on("connect", (req, clientSocket, head) => {
    const [host, portStr] = String(req.url).split(":");
    const port = Number(portStr || 443);
    if (port !== 443 || !hostAllowed(host)) {
      clientSocket.end("HTTP/1.1 403 Forbidden\r\n\r\n");
      log(`deny CONNECT ${req.url}`);
      return;
    }
    const up = net.connect(port, host, () => {
      clientSocket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      if (head?.length) up.write(head);
      up.pipe(clientSocket);
      clientSocket.pipe(up);
    });
    up.on("error", () => clientSocket.destroy());
    clientSocket.on("error", () => up.destroy());
    log(`CONNECT ${host}`);
  });
  return server;
}

if (process.argv[1] && import.meta.url.endsWith(process.argv[1].split("/").pop())) {
  const server = MODE === "api" ? apiServer() : feedServer();
  server.listen(PORT, "0.0.0.0", () => log(`listening on ${PORT}`));
}

export { apiServer, feedServer };
