// AI Factory screens: one page, hash routes. Everything the server sends is data; text is put in
// the page with textContent, and card/PR Markdown goes through md.js (escaped first).
// There is no button that decides anything: cards show the terminal command to paste.
import { renderMarkdown } from "./md.js";

const view = document.getElementById("view");
let timer = 0;
let generation = 0;

// ---------- small helpers ----------

/** h("div", { class: "x", onclick }, "text", child) — text children become text nodes. */
function h(tag, attrs, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs ?? {})) {
    if (v === undefined || v === null || v === false) continue;
    if (k.startsWith("on")) el.addEventListener(k.slice(2), v);
    else if (k === "class") el.className = v;
    else el.setAttribute(k, v === true ? "" : String(v));
  }
  for (const kid of kids.flat(Infinity)) {
    if (kid === undefined || kid === null || kid === false) continue;
    el.append(kid instanceof Node ? kid : document.createTextNode(String(kid)));
  }
  return el;
}

function md(text, cls = "md") {
  const el = h("div", { class: cls });
  el.innerHTML = renderMarkdown(text); // escaped by renderMarkdown; no raw HTML survives
  return el;
}

const money = (n) => (n === undefined || n === null ? "-" : `$${Number(n).toFixed(2)}`);
const pct = (n) => (n === undefined || n === null ? "-" : `${Math.round(n * 100)}%`);
const mins = (n) => (n === undefined || n === null ? "-" : `${n.toFixed(n < 10 ? 1 : 0)} min`);

function ago(iso) {
  if (!iso) return "";
  const s = Math.max(0, (Date.now() - Date.parse(iso)) / 1000);
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86400) return `${Math.round(s / 3600)} h ago`;
  return `${Math.round(s / 86400)} d ago`;
}

function statusClass(status) {
  const s = String(status);
  if (s.startsWith("closed")) return "s-interrupted";
  return `s-${s}`;
}

const STATUS_WORDS = { created: "created", running: "running", waiting: "waiting for you", paused: "paused", parked: "parked", delivered: "delivered", completed: "done", failed: "failed", interrupted: "interrupted", pending: "not started", decided: "decided, continues next", queued: "queued" };
const badge = (status, text) => h("span", { class: `badge ${statusClass(status)}` }, text ?? STATUS_WORDS[status] ?? status);

class HttpError extends Error { constructor(status, msg) { super(msg); this.status = status; } }

async function api(path, init) {
  const res = await fetch(path, { credentials: "same-origin", ...init, headers: { Accept: "application/json", ...(init?.headers ?? {}) } });
  let body;
  try { body = await res.json(); } catch { body = {}; }
  if (!res.ok) throw new HttpError(res.status, body.error ?? `HTTP ${res.status}`);
  return body;
}

function copyButton(text) {
  const b = h("button", { class: "btn small", type: "button", title: "Copy to clipboard" }, "Copy");
  b.addEventListener("click", async () => {
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      const t = h("textarea", {}, text);
      document.body.append(t); t.select(); document.execCommand("copy"); t.remove();
    }
    b.textContent = "Copied"; b.classList.add("copied");
    setTimeout(() => { b.textContent = "Copy"; b.classList.remove("copied"); }, 1500);
  });
  return b;
}

function mount(...nodes) {
  view.replaceChildren(...nodes);
}

function showError(e) {
  if (e instanceof HttpError && e.status === 401) {
    mount(h("div", { class: "locked" }, h("h1", {}, "Session key needed"), h("p", {}, "Open the link that factory ui printed in your terminal.")));
    return;
  }
  mount(h("div", { class: "error" }, String(e.message ?? e)));
}

/** Re-render every `ms` while this route is showing. */
function poll(ms, fn) {
  const gen = generation;
  const tick = async () => {
    if (gen !== generation) return;
    try { await fn(); } catch (e) { if (gen === generation) showError(e); return; }
    if (gen === generation) timer = setTimeout(tick, ms);
  };
  tick();
}

// ---------- screens ----------

function modeScreen() {
  const mode = (title, text, live) => live
    ? h("a", { class: "panel mode", href: "#/new/brownfield" }, badge("delivered", "live"), h("h2", {}, title), h("p", {}, text))
    : h("div", { class: "panel mode off", "aria-disabled": "true" }, badge("pending", "not built yet"), h("h2", {}, title), h("p", {}, text));
  mount(
    h("div", { class: "page-head" }, h("div", {}, h("h1", {}, "New run"), h("p", { class: "sub" }, "What kind of work is it?"))),
    h("div", { class: "grid-3" },
      mode("Brownfield", "Change an existing .NET repo: from a request to a tested branch, with your approval of the plan.", true),
      mode("Greenfield", "Start a new app from a request.", false),
      mode("Estimate", "Size and price a request before any code is written.", false),
    ),
  );
}

async function requestScreen() {
  const meta = await api("/api/projects");
  const err = h("div", { class: "error", hidden: true });
  const project = h("select", { id: "project", required: true },
    h("option", { value: "" }, meta.projects.length ? "Choose a project…" : "No projects yet"),
    meta.projects.map((p) => h("option", { value: p.name, disabled: !!p.busy }, p.busy ? `${p.name} (run ${p.busy.runId} is running)` : p.name)));
  if (meta.projects.length === 1 && !meta.projects[0].busy) project.value = meta.projects[0].name;
  const prompt = h("textarea", { id: "prompt", placeholder: "e.g. Greet people with Hello instead of Hi, and keep their name after it." });
  const fileInput = h("input", { type: "file", accept: ".md,.markdown,.txt,text/markdown,text/plain" });
  const fileName = h("span", {}, "Choose a .md or .txt file");
  let file;
  fileInput.addEventListener("change", async () => {
    const f = fileInput.files?.[0];
    file = undefined;
    if (!f) { fileName.textContent = "Choose a .md or .txt file"; return; }
    if (f.size > 1_000_000) { fileName.textContent = `${f.name} is over 1 MB`; return; }
    file = { name: f.name, text: await f.text() };
    fileName.textContent = `${f.name} (${Math.max(1, Math.round(f.size / 1000))} KB)`;
  });
  const clearFile = h("button", { class: "btn small", type: "button", onclick: () => { fileInput.value = ""; file = undefined; fileName.textContent = "Choose a .md or .txt file"; } }, "Clear");
  const jira = h("input", { type: "text", id: "jira", placeholder: "ABC-123 or its link", disabled: !meta.jira.configured });
  const maxCost = h("input", { type: "number", id: "maxcost", min: "0.5", step: "0.5", placeholder: "the normal limit" });
  const start = h("button", { class: "btn primary", type: "submit" }, "Start run");

  const form = h("form", { class: "form", novalidate: true },
    err,
    h("div", { class: "field" }, h("label", { for: "project" }, "Project"), project,
      h("div", { class: "hint" }, "From ~/.factory/projects. Add one with factory init <repo>.")),
    h("div", { class: "field" },
      h("span", { class: "label" }, "Request"),
      h("div", { class: "hint" }, "Use any of these, or several: they are combined like factory start does."),
    ),
    h("div", { class: "sources field" },
      h("div", { class: "source" }, h("label", { class: "label", for: "prompt" }, "Type it"), prompt),
      h("div", { class: "source" }, h("span", { class: "label" }, "Upload a file"),
        h("label", { class: "drop" }, fileInput, fileName), h("div", { class: "hint" }, clearFile, " Markdown or text, read like --file.")),
      h("div", { class: `source${meta.jira.configured ? "" : " off"}` }, h("label", { class: "label", for: "jira" }, "Jira ticket"), jira,
        h("div", { class: "hint" }, meta.jira.configured ? "Fetched by the factory, like --jira. Its text is treated as untrusted input." : meta.jira.why)),
    ),
    h("div", { class: "row" },
      h("div", { class: "field" }, h("label", { for: "maxcost" }, "Max cost (optional, USD)"), maxCost,
        h("div", { class: "hint" }, "Can only lower the normal limit, like --max-cost."))),
    h("div", { class: "row" }, start, h("span", { class: "hint" }, "Runs in the background. Questions and the plan approval are answered in your terminal.")),
  );
  form.addEventListener("submit", async (ev) => {
    ev.preventDefault();
    err.hidden = true;
    start.disabled = true; start.textContent = "Reading the request…";
    try {
      const body = { project: project.value, prompt: prompt.value, jira: jira.disabled ? "" : jira.value, maxCost: maxCost.value, ...(file ? { file } : {}) };
      const r = await api("/api/runs", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
      location.hash = `#/runs/${encodeURIComponent(r.runId)}`;
    } catch (e) {
      err.textContent = e.message; err.hidden = false;
      start.disabled = false; start.textContent = "Start run";
      err.scrollIntoView({ block: "nearest" });
    }
  });
  mount(
    h("div", { class: "page-head" }, h("div", {}, h("div", { class: "crumbs" }, h("a", { href: "#/new" }, "New run"), " / Brownfield"), h("h1", {}, "What should change?"),
      h("p", { class: "sub" }, "The request is checked before a run exists: a bad file or ticket costs nothing."))),
    h("div", { class: "panel" }, form),
  );
}

function runsScreen() {
  poll(3000, async () => {
    const runs = await api("/api/runs");
    const table = runs.length ? h("div", { class: "table-wrap" }, h("table", { class: "runs" },
      h("thead", {}, h("tr", {}, ["Request", "Project", "Status", "Step", "Cost", "Started", "Card"].map((t, i) => h("th", { class: i === 4 ? "num" : undefined }, t)))),
      h("tbody", {}, runs.map((r) => h("tr", { onclick: () => { location.hash = `#/runs/${encodeURIComponent(r.runId)}`; } },
        h("td", {}, h("a", { href: `#/runs/${encodeURIComponent(r.runId)}` }, r.request || r.runId), h("div", { class: "faint small mono" }, r.runId)),
        h("td", {}, r.project),
        h("td", {}, badge(r.status), r.parkedReason ? h("div", { class: "small muted", title: r.parkedReason }, r.parkedReason.length > 90 ? `${r.parkedReason.slice(0, 89)}…` : r.parkedReason) : null),
        h("td", { class: "mono nowrap" }, r.step),
        h("td", { class: "num" }, money(r.costUsd)),
        h("td", { class: "nowrap muted" }, ago(r.createdAt)),
        h("td", {}, r.openCard ? badge("waiting", `${r.openCard} card`) : null),
      ))),
    )) : h("div", { class: "empty" }, "No runs yet. ", h("a", { href: "#/new" }, "Start one"), ".");
    mount(
      h("div", { class: "page-head" }, h("div", {}, h("h1", {}, "Runs"), h("p", { class: "sub" }, "Newest first. Updates every few seconds.")),
        h("a", { class: "btn primary", href: "#/new" }, "New run")),
      h("div", { class: "panel" }, table),
    );
  });
}

function runHead(r, tab) {
  const id = encodeURIComponent(r.runId);
  const from = (r.sources ?? []).map((s) => (s.kind === "prompt" ? "typed prompt" : s.kind === "file" ? s.name : `Jira ${s.key}`)).join(" + ");
  return [
    h("div", { class: "page-head" }, h("div", {},
      h("div", { class: "crumbs" }, h("a", { href: "#/runs" }, "Runs"), " / ", h("span", { class: "mono" }, r.runId)),
      h("h1", {}, (r.request ?? "").split("\n").map((l) => l.replace(/^#+\s*/, "").trim()).find(Boolean) ?? r.runId),
      h("div", { class: "meta" }, badge(r.status), h("span", {}, `project ${r.project}`), from ? h("span", {}, `from ${from}`) : null, h("span", {}, `started ${ago(r.createdAt)}`)))),
    h("div", { class: "tabs" }, h("a", { href: `#/runs/${id}`, class: tab === "run" ? "on" : undefined }, "Progress"), h("a", { href: `#/runs/${id}/design`, class: tab === "design" ? "on" : undefined }, "Design")),
  ];
}

function timelineList(rows) {
  return h("ol", { class: "steps" }, rows.map((row) => {
    const task = row.step.includes("/");
    const failed = row.tries.filter((t) => t.outcome === "failed");
    // a failed attempt that was followed by another one
    const retries = failed.filter((t) => row.tries.some((u) => u.attempt > t.attempt)).length;
    return h("li", { class: `${row.status}${task ? " task" : ""}` },
      h("span", { class: `dot ${row.status}` }),
      h("div", {},
        h("div", { class: "name" }, task ? row.step.split("/")[1] : row.step, task ? h("span", { class: "faint small" }, "  implement") : null),
        row.status !== "pending" ? h("div", { class: "small muted" }, STATUS_WORDS[row.status] ?? row.status,
          row.attempts ? ` · ${row.attempts} attempt${row.attempts === 1 ? "" : "s"}` : "", retries ? ` · ${retries} retr${retries === 1 ? "y" : "ies"}` : "") : null,
        failed.length ? h("ul", { class: "tries" }, failed.map((t) => h("li", { class: "failed" },
          h("span", {}, `attempt ${t.attempt}${t.rung ? ` (rung ${t.rung})` : ""}: `), h("span", { class: "why" }, t.why ?? "failed"),
          t.next ? h("div", { class: "faint" }, `→ ${t.next}`) : null))) : null,
        row.note ? h("div", { class: "parked-note" }, `Parked: ${row.note}`) : null,
      ),
      h("div", { class: "right" }, row.costUsd ? money(row.costUsd) : ""),
    );
  }));
}

function costPanel(r) {
  const share = r.cost.capUsd ? Math.min(1, r.cost.usd / r.cost.capUsd) : 0;
  return h("div", { class: "panel" },
    h("div", { class: "kv" }, h("strong", {}, "Cost so far"), h("span", {}, `${money(r.cost.usd)} of ${money(r.cost.capUsd)} limit`)),
    h("div", { class: `bar costbar ${share >= 0.9 ? "bad" : share >= 0.7 ? "warn" : ""}` }, h("span", {})),
    h("div", { class: "small muted" }, `${r.activeMin.toFixed(1)} min of machine time`, r.cost.maxCostUsd !== undefined ? ` · max cost set to ${money(r.cost.maxCostUsd)}` : ""),
  );
}

function cardPanel(r) {
  const c = r.card;
  return h("section", { class: "card-box" },
    h("header", {}, h("span", {}, `Waiting for you: ${c.kind} card`), h("span", { class: "mono small" }, `hash ${c.hash}`)),
    h("div", { class: "body" },
      h("p", { class: "small" }, "Decisions are made in your terminal, so no AI or script can approve its own plan. Read the card, then paste one of these:"),
      h("div", { class: "cmds" }, c.commands.map((cmd) => h("div", { class: "cmd" }, h("code", {}, cmd), copyButton(cmd)))),
      md(c.markdown),
    ),
  );
}

function deliveredPanel(r) {
  const d = r.delivered;
  const ev = d.evidence;
  return h("section", { class: "panel" },
    h("h2", {}, "Delivered"),
    h("dl", { class: "facts" },
      h("dt", {}, "Branch"), h("dd", { class: "mono" }, d.branch ?? "-", d.branch ? copyButton(d.branch) : null),
      d.head ? [h("dt", {}, "Head"), h("dd", { class: "mono" }, d.head.slice(0, 12))] : null,
      h("dt", {}, "Pull request"), h("dd", {}, d.prUrl && /^https:\/\/github\.com\//.test(d.prUrl) ? h("a", { href: d.prUrl, target: "_blank", rel: "noopener noreferrer" }, d.prUrl) : d.local ? "Ready locally (no forge set up); the PR text is below." : "-"),
      h("dt", {}, "Evidence"), h("dd", {}, ev.total === 0 ? h("span", { class: "muted" }, "no gate decisions recorded") : ev.ok ? badge("delivered", `all ${ev.total} gate decisions re-check`) : badge("failed", `${ev.failed.length} of ${ev.total} don't re-check`),
        ev.failed.length ? h("ul", { class: "small" }, ev.failed.map((f) => h("li", {}, `#${f.seq} ${f.gateId}: ${f.reason ?? ""}`))) : null),
    ),
    d.prText ? h("details", {}, h("summary", {}, "PR text (factory show-card ", r.runId, " --pr)"), copyButton(d.prText), md(d.prText, "md tall")) : null,
  );
}

function tracePanel(r) {
  const box = h("div", { class: "trace" }, r.trace.length ? r.trace.map((e) => h("div", { class: `k-${e.kind}` },
    h("span", { class: "t" }, new Date(e.ts).toTimeString().slice(0, 8)), h("span", { class: "w", title: e.where }, e.where), h("span", {}, e.msg))) : h("span", { class: "muted" }, "No trace lines yet."));
  return h("section", { class: "panel" }, h("div", { class: "kv" }, h("h2", {}, "Latest activity"), h("span", { class: "small muted mono" }, `factory logs ${r.runId} --follow`)), box);
}

function runScreen(id) {
  let lastJson = "";
  poll(2000, async () => {
    const r = await api(`/api/runs/${encodeURIComponent(id)}`);
    const json = JSON.stringify(r);
    if (json === lastJson) return; // nothing new: keep scroll positions and open details
    lastJson = json;
    const open = [...view.querySelectorAll("details")].map((d) => d.open);
    const traceScroll = view.querySelector(".trace");
    const atBottom = !traceScroll || traceScroll.scrollTop + traceScroll.clientHeight >= traceScroll.scrollHeight - 8;
    const cost = costPanel(r);
    const share = r.cost.capUsd ? Math.min(1, r.cost.usd / r.cost.capUsd) : 0;
    cost.querySelector(".bar > span").style.width = `${(share * 100).toFixed(1)}%`;
    const right = [];
    if (r.status === "parked") right.push(h("div", { class: "callout bad" }, h("strong", {}, "Parked"), h("p", {}, r.parkedReason ?? ""), h("p", { class: "small" }, "Look at it in your terminal: factory report ", r.runId, " · factory resume ", r.runId)));
    if (r.card) right.push(cardPanel(r));
    if (r.delivered) right.push(deliveredPanel(r));
    if (r.status === "running" && r.lastActivity) right.push(h("div", { class: "callout info" }, h("strong", {}, `Working: ${r.lastActivity.where}`), h("p", {}, r.lastActivity.msg, h("span", { class: "muted" }, ` · ${ago(r.lastActivity.ts)}`))));
    right.push(tracePanel(r));
    mount(...runHead(r, "run"), h("div", { class: "grid-2" },
      h("div", { class: "stack" }, cost, h("section", { class: "panel" }, h("h2", {}, "Steps"), timelineList(r.timeline))),
      h("div", { class: "stack" }, right)));
    view.querySelectorAll("details").forEach((d, i) => { if (open[i]) d.open = true; });
    const t = view.querySelector(".trace");
    if (t && atBottom) t.scrollTop = t.scrollHeight;
  });
}

async function designScreen(id) {
  const [r, d] = await Promise.all([api(`/api/runs/${encodeURIComponent(id)}`), api(`/api/runs/${encodeURIComponent(id)}/design`)]);
  const size = "none" in d.uiSize
    ? h("p", { class: "muted" }, d.uiSize.none)
    : [
      h("div", { class: "level" }, d.uiSize.size.name),
      h("p", { class: "muted" }, `Design work: ${d.uiSize.size.work} · ${d.uiSize.size.uiFiles} UI file(s) in the plan`),
      d.uiSize.size.reasons.length ? h("ul", {}, d.uiSize.size.reasons.map((x) => h("li", {}, x))) : null,
      d.uiSize.approvalCardLine ? h("div", { class: "note small" }, "On the approval card: ", md(d.uiSize.approvalCardLine, "md")) : d.uiSize.cardLine ? null : h("div", { class: "note small" }, "The plan touches no UI, so the approval card has no UI size line."),
    ];
  let inv;
  if ("none" in d.inventory) inv = h("p", { class: "muted" }, d.inventory.none);
  else {
    const i = d.inventory;
    inv = [
      h("p", { class: "muted small" }, `${i.stack.framework} · ${i.stack.styling} · ${i.stack.componentSystem} · at ${i.commit.slice(0, 8)} · verdict: ${i.verdict}`),
      h("h3", {}, `Pages (${i.pages.length})`),
      i.pages.length ? h("div", { class: "table-wrap" }, h("table", {}, h("thead", {}, h("tr", {}, h("th", {}, "Route"), h("th", {}, "Heading"), h("th", {}, "File"))),
        h("tbody", {}, i.pages.map((p) => h("tr", {}, h("td", { class: "mono" }, p.route), h("td", {}, p.heading ?? ""), h("td", { class: "mono small muted" }, p.path)))))) : h("p", { class: "muted" }, "No pages found."),
      h("h3", {}, `Building blocks (${i.buildingBlocks.length})`),
      h("div", { class: "pill-list" }, i.buildingBlocks.map((c) => h("span", { class: "pill", title: c.path }, c.name, h("span", { class: "n" }, `${c.uses}×`)))),
      h("h3", {}, `Shared components (${i.sharedComponents.length})`),
      h("div", { class: "pill-list" }, i.sharedComponents.map((c) => h("span", { class: "pill", title: c.path }, c.name, h("span", { class: "n" }, `${c.uses}×`)))),
      h("p", { class: "small muted" }, `Theme tokens: ${i.tokens.light} light, ${i.tokens.dark} dark, ${i.tokens.theme} in @theme · off-system styling: ${i.offSystem.hexColors} hex colours, ${i.offSystem.arbitraryValues} arbitrary values, ${i.offSystem.inlineStyle} inline styles`),
    ];
  }
  const style = d.styleChecks.length
    ? h("ul", {}, d.styleChecks.map((g) => h("li", {}, badge(g.passed ? "completed" : "failed", g.passed ? "passed" : "failed"), ` ${g.gateId}${g.step ? ` (${g.step})` : ""}`)))
    : h("p", { class: "muted" }, "No style check results for this run. The pipeline doesn't run the style check yet; by hand: factory design lint --git <base> <head> --repo <repo>.");
  mount(...runHead(r, "design"),
    h("div", { class: "grid-2" },
      h("div", { class: "stack" },
        h("section", { class: "panel" }, h("h2", {}, "UI change size"), size),
        h("section", { class: "panel" }, h("h2", {}, "Style check"), style),
        h("div", { class: "slot" }, h("strong", {}, "Before/after screenshots"), h("span", {}, "not built yet")),
        h("div", { class: "slot" }, h("strong", {}, "Clickable prototype (estimate mode)"), h("span", {}, "not built yet")),
      ),
      h("section", { class: "panel" }, h("h2", {}, "The app's pages and building blocks"), inv),
    ));
}

async function dashboardScreen() {
  const { outcomes: o, stages } = await api("/api/dashboard");
  const tile = (label, big, small) => h("div", { class: "panel tile" }, h("p", { class: "label" }, label), h("div", { class: "big" }, big), h("div", { class: "small" }, small));
  const maxCost = Math.max(0.01, ...stages.map((s) => s.avgCostUsd));
  const hbar = (value, share, cls) => { const b = h("div", { class: `bar ${cls}` }, h("span")); b.firstChild.style.width = `${(Math.max(0, Math.min(1, share)) * 100).toFixed(1)}%`; return h("div", { class: "hbar" }, b, h("span", { class: "v" }, value)); };
  mount(
    h("div", { class: "page-head" }, h("div", {}, h("h1", {}, "Dashboard"), h("p", { class: "sub" }, `Across all ${o.runs} runs on this computer. The same numbers as factory report --all.`))),
    o.runs ? h("div", { class: "tiles" },
      tile("Delivered", `${o.delivered} of ${o.runs}`, `${o.parked} parked, ${o.waiting} waiting, ${o.running} running`),
      tile("Cost per delivered change", money(o.costPerDeliveredUsd), `all spend ${money(o.totalCostUsd)}, parked runs included · a delivered run alone ${money(o.avgDeliveredRunCostUsd)}`),
      tile("Request → branch", mins(o.wallMin.median), `wall-clock median, includes waiting for people · worst ${mins(o.wallMin.worst)} · machine time median ${mins(o.activeMinMedian)}`),
      tile("Human stops", o.humanStopsPerDelivered === undefined ? "-" : o.humanStopsPerDelivered.toFixed(1), `cards per delivered run · only the plan approval: ${pct(o.approvalOnlyShare)}`),
      tile("First-time pass", pct(o.firstTimePass.rate), `of ${o.firstTimePass.finished} finished steps`),
    ) : h("div", { class: "panel empty" }, "No runs yet."),
    stages.length ? h("section", { class: "panel" }, h("h2", {}, "Per stage"), h("div", { class: "table-wrap" }, h("table", {},
      h("thead", {}, h("tr", {}, h("th", {}, "Stage"), h("th", { class: "num" }, "Runs"), h("th", {}, "First-time pass"), h("th", {}, "Avg cost"), h("th", { class: "num" }, "Avg time"), h("th", {}, "Most common problem"))),
      h("tbody", {}, stages.map((s) => h("tr", {},
        h("td", { class: "mono" }, s.stage), h("td", { class: "num" }, s.count),
        h("td", {}, hbar(pct(s.firstTimePassRate), s.firstTimePassRate, "ok")),
        h("td", {}, hbar(money(s.avgCostUsd), s.avgCostUsd / maxCost, "")),
        h("td", { class: "num" }, `${Math.round(s.avgActiveSec)}s`),
        h("td", { class: "small" }, s.topProblem ? `${s.topProblem.reason} (${s.topProblem.count}×)` : "-"),
      )))))) : null,
  );
}

// ---------- router ----------

async function route() {
  generation++;
  clearTimeout(timer);
  const hash = location.hash.replace(/^#/, "") || "/new";
  const parts = hash.split("/").filter(Boolean).map(decodeURIComponent);
  const top = parts[0] ?? "new";
  document.querySelectorAll("[data-nav]").forEach((a) => a.classList.toggle("on", a.dataset.nav === top));
  try {
    if (top === "new" && parts[1] === "brownfield") await requestScreen();
    else if (top === "new") modeScreen();
    else if (top === "runs" && parts[1] && parts[2] === "design") await designScreen(parts[1]);
    else if (top === "runs" && parts[1]) runScreen(parts[1]);
    else if (top === "runs") runsScreen();
    else if (top === "dashboard") await dashboardScreen();
    else modeScreen();
  } catch (e) {
    showError(e);
  }
  document.title = `AI Factory · ${{ new: "New run", runs: parts[1] ? parts[1] : "Runs", dashboard: "Dashboard" }[top] ?? ""}`;
}

window.addEventListener("hashchange", route);
route();
