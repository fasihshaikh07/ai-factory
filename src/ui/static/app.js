// AI Factory screens: one page, hash routes. Everything the server sends is data; text goes into
// the page with textContent, and card/PR Markdown goes through md.js (escaped first).
// There is no button that decides anything: cards show the terminal command to paste.
import { renderMarkdown } from "./md.js";

const view = document.getElementById("view");
const reduced = matchMedia("(prefers-reduced-motion: reduce)").matches;
let timer = 0;
let generation = 0;

// ---------- DOM helpers ----------

/** h("div", { class: "x", onclick }, "text", child): strings become text nodes, never HTML. */
function h(tag, attrs, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs ?? {})) {
    if (v === undefined || v === null || v === false) continue;
    if (k.startsWith("on")) el.addEventListener(k.slice(2), v);
    else if (k === "class") el.className = v;
    else if (k === "vars") for (const [n, x] of Object.entries(v)) el.style.setProperty(n, String(x));
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

// a small icon set, drawn for this page (24×24, stroked)
const ICONS = {
  check: [["path", { d: "M5 12.5l4.5 4.5L19 7.5" }]],
  x: [["path", { d: "M6 6l12 12M18 6L6 18" }]],
  loop: [["path", { d: "M4 12a8 8 0 0 1 13.7-5.6L20 8.5M20 4v4.5h-4.5M20 12a8 8 0 0 1-13.7 5.6L4 15.5M4 20v-4.5h4.5" }]],
  alert: [["path", { d: "M12 3.5l9.5 16.5h-19z" }], ["path", { d: "M12 10v4M12 17.3v.2" }]],
  pause: [["path", { d: "M9 6v12M15 6v12" }]],
  terminal: [["rect", { x: 3, y: 4, width: 18, height: 16, rx: 2.5 }], ["path", { d: "M7 9.5l3 2.5-3 2.5M12.5 15H17" }]],
  clock: [["circle", { cx: 12, cy: 12, r: 9 }], ["path", { d: "M12 7.5V12l3 2" }]],
  dollar: [["path", { d: "M12 3v18M16.5 7.5c0-1.9-2-3-4.5-3s-4.5 1.2-4.5 3.2c0 4.3 9 2.3 9 6.8 0 2-2 3.5-4.5 3.5S7.5 18 7.5 16" }]],
  file: [["path", { d: "M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z" }], ["path", { d: "M14 3v5h5M9 13h6M9 17h4" }]],
  upload: [["path", { d: "M12 15.5V4M7 8.5L12 4l5 4.5M4 15.5V18a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-2.5" }]],
  ticket: [["path", { d: "M3 8a2 2 0 0 0 2-2h14a2 2 0 0 0 2 2v2a2 2 0 0 0 0 4v2a2 2 0 0 0-2 2H5a2 2 0 0 0-2-2v-2a2 2 0 0 0 0-4z" }], ["path", { d: "M14 6.5v2M14 11v2M14 15.5v2" }]],
  pen: [["path", { d: "M4 20h4L19 9l-4-4L4 16z" }], ["path", { d: "M13.5 6.5l4 4" }]],
  layers: [["path", { d: "M12 3l9 5-9 5-9-5z" }], ["path", { d: "M3 12.5l9 5 9-5M3 17l9 5 9-5" }]],
  sprout: [["path", { d: "M12 21v-8M12 13C12 8 8.5 5.5 4 5.5c0 4.5 3.5 7.5 8 7.5zM12 15c0-4 3-6.5 7.5-6.5 0 4-3 6.5-7.5 6.5z" }]],
  ruler: [["path", { d: "M4 17L17 4l3 3L7 20z" }], ["path", { d: "M8 13l2 2M11 10l2 2M14 7l2 2" }]],
  arrow: [["path", { d: "M5 12h14M13 6l6 6-6 6" }]],
  copy: [["rect", { x: 9, y: 9, width: 11, height: 11, rx: 2 }], ["path", { d: "M15 5.5V5a1 1 0 0 0-1-1H6a2 2 0 0 0-2 2v8a1 1 0 0 0 1 1h.5" }]],
  sun: [["circle", { cx: 12, cy: 12, r: 4 }], ["path", { d: "M12 2.5v2M12 19.5v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2.5 12h2M19.5 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" }]],
  moon: [["path", { d: "M20 14.5A8.5 8.5 0 1 1 9.5 4a7 7 0 0 0 10.5 10.5z" }]],
  shield: [["path", { d: "M12 3l8 3v6c0 5-3.5 8-8 9-4.5-1-8-4-8-9V6z" }], ["path", { d: "M8.5 12l2.5 2.5 4.5-4.5" }]],
  activity: [["path", { d: "M3 12h4l3-7.5 4 15 3-7.5h4" }]],
  image: [["rect", { x: 3, y: 4, width: 18, height: 16, rx: 2 }], ["circle", { cx: 9, cy: 9.5, r: 1.8 }], ["path", { d: "M21 16l-5-5-9 9" }]],
  cursor: [["path", { d: "M5 3.5l6 16.5 2.5-7 7-2.5z" }]],
  grid: [["rect", { x: 4, y: 4, width: 7, height: 7, rx: 1.5 }], ["rect", { x: 13, y: 4, width: 7, height: 7, rx: 1.5 }], ["rect", { x: 4, y: 13, width: 7, height: 7, rx: 1.5 }], ["rect", { x: 13, y: 13, width: 7, height: 7, rx: 1.5 }]],
  browser: [["rect", { x: 3, y: 4, width: 18, height: 16, rx: 2 }], ["path", { d: "M3 9h18M6.5 6.5h.01M9 6.5h.01" }]],
  bars: [["path", { d: "M5 20v-8M12 20V5M19 20v-5M3 20h18" }]],
  plus: [["path", { d: "M12 5v14M5 12h14" }]],
  user: [["circle", { cx: 12, cy: 8, r: 4 }], ["path", { d: "M4 21a8 8 0 0 1 16 0" }]],
  gauge: [["path", { d: "M3.5 16a8.5 8.5 0 1 1 17 0" }], ["path", { d: "M12 16l4-5" }]],
};

function icon(name, cls = "i") {
  const ns = "http://www.w3.org/2000/svg";
  const svg = document.createElementNS(ns, "svg");
  svg.setAttribute("class", cls);
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("aria-hidden", "true");
  for (const [tag, attrs] of ICONS[name] ?? []) {
    const el = document.createElementNS(ns, tag);
    for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, String(v));
    svg.append(el);
  }
  return svg;
}

const money = (n) => (n === undefined || n === null ? "-" : `$${Number(n).toFixed(2)}`);
const pct = (n) => (n === undefined || n === null ? "-" : `${Math.round(n * 100)}%`);
const mins = (n) => (n === undefined || n === null ? "-" : `${n.toFixed(n < 10 ? 1 : 0)} min`);
const secs = (n) => (n >= 90 ? `${Math.round(n / 60)} min` : `${Math.round(n)}s`);

function ago(iso) {
  if (!iso) return "";
  const s = Math.max(0, (Date.now() - Date.parse(iso)) / 1000);
  if (s < 45) return "just now";
  if (s < 3600) return `${Math.max(1, Math.round(s / 60))} min ago`;
  if (s < 86400) return `${Math.round(s / 3600)} h ago`;
  return `${Math.round(s / 86400)} d ago`;
}

/** Colour family for a run or step status. */
function tone(status) {
  const s = String(status);
  if (s === "delivered" || s === "completed" || s.startsWith("closed: merged")) return "ok";
  if (s === "running" || s === "created") return "live";
  if (s === "waiting" || s === "decided" || s === "paused" || s === "interrupted") return "wait";
  if (s === "parked" || s === "failed" || s.startsWith("closed")) return "bad";
  return "idle";
}
const WORDS = { created: "created", running: "running", waiting: "waiting for you", paused: "paused", parked: "parked", delivered: "delivered", completed: "done", failed: "failed", interrupted: "interrupted", pending: "not started", decided: "decided · continues next" };
const pill = (status, text) => h("span", { class: `pill t-${tone(status)}` }, h("span", { class: "d" }), text ?? WORDS[status] ?? status);

class HttpError extends Error { constructor(status, msg) { super(msg); this.status = status; } }

async function api(path, init) {
  const res = await fetch(path, { credentials: "same-origin", ...init, headers: { Accept: "application/json", ...(init?.headers ?? {}) } });
  let body;
  try { body = await res.json(); } catch { body = {}; }
  if (!res.ok) throw new HttpError(res.status, body.error ?? `HTTP ${res.status}`);
  return body;
}

function copyButton(text, label = "Copy") {
  const b = h("button", { class: "btn sm copy", type: "button", title: "Copy to the clipboard" }, icon("copy"), label, h("span", { class: "ok" }, icon("check"), "Copied"));
  b.addEventListener("click", async () => {
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      const t = h("textarea", {}, text);
      document.body.append(t); t.select(); document.execCommand("copy"); t.remove();
    }
    b.classList.add("done");
    setTimeout(() => b.classList.remove("done"), 1400);
  });
  return b;
}

/** Numbers that count up (skipped when motion is reduced). */
function countUp(el, to, fmt, from = 0) {
  if (reduced || from === to || !Number.isFinite(to)) { el.textContent = fmt(to); return; }
  const t0 = performance.now(), dur = 700;
  const step = (t) => {
    const k = Math.min(1, (t - t0) / dur), e = 1 - (1 - k) ** 3;
    el.textContent = fmt(from + (to - from) * e);
    if (k < 1) requestAnimationFrame(step);
  };
  el.textContent = fmt(from);
  requestAnimationFrame(step);
}

/** After the next frame: lets CSS transitions start from the first state. */
const nextFrame = (fn) => requestAnimationFrame(() => requestAnimationFrame(fn));

function mount(nodes, enter) {
  view.replaceChildren(...nodes.filter(Boolean));
  if (enter) { view.classList.remove("enter"); void view.offsetWidth; view.classList.add("enter"); }
}

function skeleton(kind) {
  const rows = (n) => Array.from({ length: n }, () => h("div", { class: "skel row" }));
  const blocks = kind === "grid" ? h("div", { class: "grid-2" }, h("div", { class: "skel block" }), h("div", { class: "skel block" })) : h("div", { class: "panel" }, rows(6));
  mount([h("div", { class: "skel h1" }), blocks], true);
}

function showError(e) {
  if (e instanceof HttpError && e.status === 401) {
    mount([h("div", { class: "locked panel" }, h("h1", {}, "Session key needed"), h("p", { class: "sub" }, "Open the link that factory ui printed in your terminal."))], true);
    return;
  }
  mount([h("div", { class: "error" }, icon("alert"), h("span", {}, String(e.message ?? e)))], true);
}

/** Re-render every `ms` while this route is showing. */
function poll(ms, fn) {
  const gen = generation;
  let first = true;
  const tick = async () => {
    if (gen !== generation) return;
    try { await fn(first); } catch (e) { if (gen === generation) showError(e); return; }
    first = false;
    if (gen === generation) timer = setTimeout(tick, ms);
  };
  tick();
}

// ---------- theme ----------

const themeBtn = document.getElementById("theme");
function currentTheme() {
  return document.documentElement.dataset.theme ?? (matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark");
}
function paintThemeButton() {
  themeBtn.replaceChildren(icon(currentTheme() === "dark" ? "sun" : "moon"));
  themeBtn.title = currentTheme() === "dark" ? "Light theme" : "Dark theme";
}
themeBtn.addEventListener("click", () => {
  const next = currentTheme() === "dark" ? "light" : "dark";
  document.documentElement.dataset.theme = next;
  try { localStorage.setItem("factory-theme", next); } catch { /* storage blocked: this visit only */ }
  paintThemeButton();
});
paintThemeButton();

// ---------- new run: mode ----------

function modeScreen() {
  const card = (i, ico, title, text, live) => live
    ? h("a", { class: "panel mode rise", href: "#/new/brownfield", vars: { "--i": i } }, h("div", { class: "ico" }, icon(ico)), h("h2", {}, title), h("p", {}, text),
      h("div", { class: "go" }, "Start", icon("arrow")))
    : h("div", { class: "panel mode off rise", "aria-disabled": "true", vars: { "--i": i } }, h("div", { class: "ribbon" }, "not built yet"), h("div", { class: "ico" }, icon(ico)), h("h2", {}, title), h("p", {}, text),
      h("div", { class: "go faint" }, "Not built yet"));
  mount([
    h("div", { class: "page-head" }, h("div", {}, h("div", { class: "eyebrow" }, "New run"), h("h1", {}, "What kind of work is it?"),
      h("p", { class: "sub" }, "The factory turns a request into a tested branch. You approve the plan in your terminal."))),
    h("div", { class: "grid-3" },
      card(0, "layers", "Brownfield", "Change an existing .NET repo: request → spec → plan you approve → tests first → code → reviewed branch.", true),
      card(1, "sprout", "Greenfield", "Start a new app from a request.", false),
      card(2, "ruler", "Estimate", "Size and price a request before any code is written.", false),
    ),
  ], true);
}

// ---------- new run: request ----------

async function requestScreen() {
  skeleton();
  const meta = await api("/api/projects");
  const err = h("div", { class: "error", hidden: true });
  const project = h("select", { id: "project" },
    h("option", { value: "" }, meta.projects.length ? "Choose a project…" : "No projects yet"),
    meta.projects.map((p) => h("option", { value: p.name, disabled: !!p.busy }, p.busy ? `${p.name}  (run ${p.busy.runId} is running)` : p.name)));
  if (meta.projects.length === 1 && !meta.projects[0].busy) project.value = meta.projects[0].name;

  // the three inputs, which can be combined like factory start
  const prompt = h("textarea", { id: "prompt", placeholder: "e.g. Show the number of orders next to the Your orders heading, and keep the heading text." });
  const fileInput = h("input", { type: "file", accept: ".md,.markdown,.txt,text/markdown,text/plain" });
  const jira = h("input", { type: "text", id: "jira", placeholder: "ABC-123 or its link", disabled: !meta.jira.configured });
  let file;
  const fileBox = h("div");
  const dots = { prompt: h("span", { class: "has" }), file: h("span", { class: "has" }), jira: h("span", { class: "has" }) };
  const refreshDots = () => {
    dots.prompt.classList.toggle("on", !!prompt.value.trim());
    dots.file.classList.toggle("on", !!file);
    dots.jira.classList.toggle("on", !jira.disabled && !!jira.value.trim());
  };
  const showFile = () => {
    fileBox.replaceChildren(file ? h("div", { class: "file-chip" }, icon("file"), h("span", { class: "mono" }, file.name), h("span", { class: "faint small" }, `${Math.max(1, Math.round(file.size / 1000))} KB`),
      h("button", { class: "btn sm", type: "button", onclick: () => { file = undefined; fileInput.value = ""; showFile(); } }, icon("x"), "Remove")) : "");
    refreshDots();
  };
  const fail = (msg) => { err.replaceChildren(icon("alert"), h("span", {}, msg)); err.hidden = false; };
  const takeFile = async (f) => {
    err.hidden = true;
    if (!f) return;
    if (!/\.(md|markdown|txt)$/i.test(f.name)) return fail("Upload a Markdown (.md) or text (.txt) file.");
    if (f.size > 1_000_000) return fail(`${f.name} is over 1 MB.`);
    file = { name: f.name, text: await f.text(), size: f.size };
    showFile();
  };
  fileInput.addEventListener("change", () => takeFile(fileInput.files?.[0]));
  const drop = h("label", { class: "drop" }, fileInput, icon("upload"), h("strong", {}, "Drop a .md or .txt file here"), h("span", { class: "small" }, "or click to choose one · read like --file"));
  drop.addEventListener("dragover", (e) => { e.preventDefault(); drop.classList.add("over"); });
  drop.addEventListener("dragleave", () => drop.classList.remove("over"));
  drop.addEventListener("drop", (e) => { e.preventDefault(); drop.classList.remove("over"); takeFile(e.dataTransfer?.files?.[0]); });
  prompt.addEventListener("input", refreshDots);
  jira.addEventListener("input", refreshDots);

  const panels = {
    prompt: h("div", { class: "tab-panel" }, prompt),
    file: h("div", { class: "tab-panel" }, drop, fileBox),
    jira: h("div", { class: "tab-panel" }, jira, meta.jira.configured
      ? h("div", { class: "hint" }, "The factory fetches the ticket itself, like --jira. Its text is treated as untrusted input.")
      : h("div", { class: "jira-off" }, icon("alert"), h("span", {}, meta.jira.why))),
  };
  const tabs = {};
  const select = (k) => {
    for (const [name, p] of Object.entries(panels)) p.hidden = name !== k;
    for (const [name, t] of Object.entries(tabs)) { t.classList.toggle("on", name === k); t.setAttribute("aria-selected", String(name === k)); }
    panels[k].classList.remove("tab-panel"); void panels[k].offsetWidth; panels[k].classList.add("tab-panel");
  };
  tabs.prompt = h("button", { class: "tab", type: "button", role: "tab", onclick: () => select("prompt") }, icon("pen"), "Prompt", dots.prompt);
  tabs.file = h("button", { class: "tab", type: "button", role: "tab", onclick: () => select("file") }, icon("upload"), "Upload .md", dots.file);
  tabs.jira = h("button", { class: "tab", type: "button", role: "tab", onclick: () => select("jira") }, icon("ticket"), "Jira key", dots.jira);
  select("prompt");

  const maxCost = h("input", { type: "number", id: "maxcost", min: "0.5", step: "0.5", placeholder: "normal limit" });
  const start = h("button", { class: "btn primary", type: "submit" }, "Start run", icon("arrow"));
  const form = h("form", { class: "form", novalidate: true },
    err,
    h("div", { class: "field" }, h("label", { for: "project" }, "Project"), project,
      h("div", { class: "hint" }, "From ~/.factory/projects. Add one with factory init <repo>.")),
    h("div", { class: "field" }, h("span", { class: "label" }, "Request"),
      h("div", { class: "tabs-in", role: "tablist" }, tabs.prompt, tabs.file, tabs.jira),
      panels.prompt, panels.file, panels.jira,
      h("div", { class: "hint" }, "Use one input or several: they are combined into one request, like factory start does.")),
    h("div", { class: "field" }, h("label", { for: "maxcost" }, "Max cost (optional)"), h("div", { class: "money-in" }, h("span", {}, "$"), maxCost),
      h("div", { class: "hint" }, "It can only lower the normal limit, like --max-cost.")),
    h("div", { class: "row" }, start, h("span", { class: "hint" }, "Runs in the background. Questions and the plan approval are answered in your terminal.")),
  );
  form.addEventListener("submit", async (ev) => {
    ev.preventDefault();
    err.hidden = true;
    start.disabled = true;
    start.replaceChildren(h("span", { class: "spin" }), "Reading the request…");
    try {
      const body = { project: project.value, prompt: prompt.value, jira: jira.disabled ? "" : jira.value, maxCost: maxCost.value, ...(file ? { file: { name: file.name, text: file.text } } : {}) };
      const r = await api("/api/runs", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
      location.hash = `#/runs/${encodeURIComponent(r.runId)}`;
    } catch (e) {
      fail(e.message);
      start.disabled = false;
      start.replaceChildren("Start run", icon("arrow"));
      err.scrollIntoView({ block: "nearest", behavior: reduced ? "auto" : "smooth" });
    }
  });
  mount([
    h("div", { class: "page-head" }, h("div", {},
      h("div", { class: "crumbs" }, h("a", { href: "#/new" }, "New run"), "/", "Brownfield"),
      h("h1", {}, "What should change?"),
      h("p", { class: "sub" }, "The request is read and checked before a run exists: a bad file or ticket costs nothing."))),
    h("div", { class: "panel" }, form),
  ], true);
}

// ---------- runs ----------

function runsScreen() {
  skeleton();
  poll(3000, async (first) => {
    const runs = await api("/api/runs");
    const body = runs.length ? h("div", { class: "table-wrap" }, h("table", { class: "runs" },
      h("thead", {}, h("tr", {}, ["Request", "Project", "Status", "Step", "Cost", "Started", "Card"].map((t, i) => h("th", { class: i === 4 ? "num" : undefined }, t)))),
      h("tbody", {}, runs.map((r) => h("tr", { class: `k-${tone(r.status)}`, onclick: () => { location.hash = `#/runs/${encodeURIComponent(r.runId)}`; } },
        h("td", {}, h("div", { class: "req" }, r.request || r.runId), h("div", { class: "id" }, r.runId),
          r.parkedReason ? h("div", { class: "why-line", title: r.parkedReason }, r.parkedReason.length > 110 ? `${r.parkedReason.slice(0, 109)}…` : r.parkedReason) : null),
        h("td", {}, r.project),
        h("td", {}, pill(r.status)),
        h("td", { class: "mono small nowrap" }, r.step),
        h("td", { class: "num" }, money(r.costUsd)),
        h("td", { class: "nowrap muted small" }, ago(r.createdAt)),
        h("td", {}, r.openCard ? pill("waiting", `${r.openCard} card · terminal`) : null),
      ))),
    )) : h("div", { class: "empty" }, "No runs yet. ", h("a", { href: "#/new" }, "Start one"), ".");
    mount([
      h("div", { class: "page-head" }, h("div", {}, h("div", { class: "eyebrow" }, "Runs"), h("h1", {}, "Recent runs"), h("p", { class: "sub" }, "Newest first. Updates every few seconds.")),
        h("a", { class: "btn primary", href: "#/new" }, icon("plus"), "New run")),
      h("div", { class: "panel" }, body),
    ], first);
  });
}

// ---------- one run ----------

const SPEC = new Set(["discover", "intake", "ground", "clarify", "clarify-2", "drafts", "merge", "specify", "plan", "approve"]);
const BUILD = new Set(["stub-commit", "author-tests", "integrate"]);
const phaseOf = (step) => (SPEC.has(step) ? 0 : BUILD.has(step) || step.startsWith("implement/") ? 1 : 2);
const PHASES = ["Spec", "Build", "Ship"];
const NODE_ICON = { completed: "check", waiting: "terminal", decided: "clock", parked: "alert", failed: "x", interrupted: "pause" };
const retriesOf = (row) => row.tries.filter((t) => t.outcome === "failed" && row.tries.some((u) => u.attempt > t.attempt)).length;

const runState = { id: "", seenGates: new Set(), cost: 0, share: 0, drawer: "", last: undefined };

/** The four live views of one run: [route, icon, label]. */
const RUN_TABS = [["run", "activity", "Interactive"], ["charts", "bars", "Graphical"], ["stats", "grid", "Statistical"], ["log", "terminal", "Text"]];

function runHeader(r, tab) {
  const id = encodeURIComponent(r.runId);
  const from = (r.sources ?? []).map((s) => (s.kind === "prompt" ? "typed prompt" : s.kind === "file" ? s.name : `Jira ${s.key}`)).join(" + ");
  const kind = r.sources?.[0]?.kind;
  return [
    h("div", { class: "page-head" }, h("div", {},
      h("div", { class: "crumbs" }, h("a", { href: "#/runs" }, "Runs"), "/", h("span", { class: "mono" }, r.runId)),
      h("h1", {}, (r.request ?? "").split("\n").map((l) => l.replace(/^#+\s*/, "").trim()).find(Boolean) ?? r.runId),
      h("div", { class: "meta" }, pill(r.status), h("span", {}, icon("layers"), r.project),
        from ? h("span", {}, icon(kind === "jira" ? "ticket" : kind === "file" ? "file" : "pen"), from) : null,
        h("span", {}, icon("clock"), `started ${ago(r.createdAt)}`)))),
    h("nav", { class: "subnav", "aria-label": "Run views" },
      h("div", { class: "seg", role: "tablist" }, RUN_TABS.map(([key, ico, label]) => h("a", { href: `#/runs/${id}${key === "run" ? "" : `/${key}`}`, role: "tab", "aria-selected": String(tab === key), class: tab === key ? "on" : undefined }, icon(ico), label))),
      h("span", { class: "sep" }),
      h("a", { href: `#/runs/${id}/design`, class: tab === "design" ? "on" : undefined }, icon("browser"), "Design"),
      h("a", { href: `#/runs/${id}/preview`, class: tab === "preview" ? "on" : undefined }, icon("image"), "Preview")),
  ];
}

/** "stub-commit" → "stub-" <wbr> "commit": labels wrap at hyphens, never mid-word. */
const breakable = (text) => text.split(/(?<=-)/).flatMap((part, i) => (i ? [h("wbr"), part] : [part]));

function pipeline(r) {
  const groups = [[], [], []];
  for (const row of r.timeline) groups[phaseOf(row.step)].push(row);
  const node = (row) => {
    const task = row.step.startsWith("implement/");
    const retries = retriesOf(row);
    const ic = NODE_ICON[row.status];
    return h("button", { class: `node s-${row.status}${runState.drawer === row.step ? " sel" : ""}`, type: "button", "data-step": row.step, title: `${row.step}: ${WORDS[row.status] ?? row.status}`, onclick: () => openDrawer(row.step) },
      row.status === "running" ? h("span", { class: "flow" }) : null,
      h("span", { class: "dot" }, ic ? icon(ic) : null),
      retries ? h("span", { class: "loop", title: `${retries} retr${retries === 1 ? "y" : "ies"}` }, icon("loop"), String(retries)) : null,
      h("span", { class: "lbl" }, breakable(task ? row.step.slice("implement/".length) : row.step), task ? h("small", {}, "implement") : null));
  };
  const note = (() => {
    const parked = r.timeline.find((t) => t.status === "parked");
    if (r.status === "parked") return h("div", { class: "pipe-note bad" }, icon("alert"), h("div", {}, h("strong", {}, parked ? `Parked at ${parked.step}` : "Parked"), h("p", {}, r.parkedReason ?? "")));
    if (r.card) return h("div", { class: "pipe-note wait" }, icon("terminal"), h("div", {}, h("strong", {}, `Waiting for you in the terminal: ${r.card.kind} card`), h("p", {}, "The run continues after you decide there. The card and the command to paste are below.")));
    if (r.delivered) return h("div", { class: "pipe-note ok" }, icon("check"), h("div", {}, h("strong", {}, "Delivered"), h("p", {}, r.delivered.branch ? `Branch ${r.delivered.branch}` : "")));
    if (r.status === "running" && r.lastActivity) return h("div", { class: "pipe-note live" }, icon("activity"), h("div", {}, h("strong", {}, `Working on ${r.step}`), h("p", {}, r.lastActivity.msg, h("span", { class: "muted" }, ` · ${ago(r.lastActivity.ts)}`))));
    return null;
  })();
  return h("section", { class: "panel" },
    h("div", { class: "panel-head" }, h("h2", {}, icon("activity"), "Pipeline"), h("span", { class: "pipe-hint" }, "Click a step for its attempts, gates, cost and time")),
    h("div", { class: "pipe-wrap" }, h("div", { class: "phases" }, groups.map((g, i) => g.length ? h("div", { class: "phase", vars: { "flex-grow": g.length } }, h("div", { class: "phase-name" }, PHASES[i]), h("div", { class: "chain" }, g.map(node))) : null))),
    note);
}

function costPanel(r) {
  const share = r.cost.capUsd ? Math.min(1, r.cost.usd / r.cost.capUsd) : 0;
  const num = h("span", { class: "big" });
  const fill = h("div", { class: "fill" });
  fill.style.transform = `scaleX(${runState.share})`;
  nextFrame(() => { fill.style.transform = `scaleX(${share})`; });
  countUp(num, r.cost.usd, money, runState.cost);
  runState.cost = r.cost.usd; runState.share = share;
  return h("section", { class: "panel" },
    h("div", { class: "panel-head" }, h("h2", {}, icon("gauge"), "Cost so far"), h("span", { class: "small muted" }, `${Math.round(share * 100)}% of the limit`)),
    h("div", { class: "meter-num" }, num, h("span", { class: "of" }, `of ${money(r.cost.capUsd)}`)),
    h("div", { class: `gauge ${share >= 0.9 ? "bad" : share >= 0.7 ? "warn" : ""}` }, fill, h("div", { class: "ticks" })),
    h("div", { class: "meter-foot" }, h("span", {}, `${r.activeMin.toFixed(1)} min of machine time`), h("span", {}, r.cost.maxCostUsd !== undefined ? `max cost set to ${money(r.cost.maxCostUsd)}` : "the limit grows with the plan's size")));
}

function gatesPanel(r) {
  let i = 0;
  const chips = r.gates.map((g) => {
    const fresh = !runState.seenGates.has(g.seq);
    return h("span", { class: `chip ${g.passed ? "pass" : "fail"}${fresh ? " new" : ""}`, title: `${g.gateId}${g.step ? ` (${g.step})` : ""}: ${g.passed ? "passed" : "failed"}`, vars: fresh ? { "--i": i++ } : undefined },
      icon(g.passed ? "check" : "x"), g.gateId);
  });
  for (const g of r.gates) runState.seenGates.add(g.seq);
  const passed = r.gates.filter((g) => g.passed).length;
  return h("section", { class: "panel" },
    h("div", { class: "panel-head" }, h("h2", {}, icon("shield"), "Gates"), h("span", { class: "small muted" }, r.gates.length ? `${passed} passed · ${r.gates.length - passed} failed` : "")),
    r.gates.length ? h("div", { class: "chips" }, chips) : h("p", { class: "muted small" }, "No gate results yet. Gates check each step's output (scope, locked tests, secrets, review) as the run goes."));
}

function cardPanel(r) {
  const c = r.card;
  return h("section", { class: "card-box" },
    h("header", {}, h("strong", {}, h("span", { class: "pulse" }), "Waiting for you in the terminal"), h("span", { class: "mono small" }, `${c.kind} card · ${c.hash}`)),
    h("div", { class: "body" },
      h("p", { class: "small muted" }, "Decisions are made in your terminal, so no AI or script can approve its own plan. Read the card, then paste one of these:"),
      h("div", { class: "cmds" }, c.commands.map((cmd) => h("div", { class: "cmd" }, h("span", { class: "prompt" }, "$"), h("code", {}, cmd), copyButton(cmd)))),
      md(c.markdown)));
}

function deliveredPanel(r) {
  const d = r.delivered;
  const ev = d.evidence;
  return h("section", { class: "panel" },
    h("div", { class: "big-ok" }, h("span", { class: "ring" }, icon("check")), h("div", {}, h("h2", {}, "Delivered"), h("div", { class: "small muted" }, d.local ? "Ready locally: no forge is set up for this project" : "Pushed and opened as a pull request"))),
    h("dl", { class: "facts" },
      h("dt", {}, "Branch"), h("dd", {}, h("code", {}, d.branch ?? "-"), d.branch ? copyButton(d.branch) : null),
      d.head ? [h("dt", {}, "Head"), h("dd", {}, h("code", {}, d.head.slice(0, 12)))] : null,
      h("dt", {}, "Pull request"), h("dd", {}, d.prUrl && /^https:\/\/github\.com\//.test(d.prUrl) ? h("a", { href: d.prUrl, target: "_blank", rel: "noopener noreferrer" }, d.prUrl) : d.local ? "PR text below (factory show-card --pr)" : "-"),
      h("dt", {}, "Evidence"), h("dd", {}, ev.total === 0 ? h("span", { class: "muted" }, "no gate decisions recorded")
        : ev.ok ? pill("delivered", `all ${ev.total} gate decisions re-check`) : pill("failed", `${ev.failed.length} of ${ev.total} don't re-check`)),
    ),
    ev.failed.length ? h("ul", { class: "small" }, ev.failed.map((f) => h("li", {}, `#${f.seq} ${f.gateId}: ${f.reason ?? ""}`))) : null,
    d.prText ? h("details", {}, h("summary", {}, "PR text"), h("div", { class: "row" }, copyButton(d.prText, "Copy PR text")), md(d.prText, "md tall")) : null);
}

function parkedPanel(r) {
  return h("section", { class: "callout bad" }, icon("alert"), h("div", {},
    h("strong", {}, "Parked: a person needs to look"),
    h("p", {}, "The reason is shown on the pipeline above. Nothing runs until someone resumes it."),
    h("p", { class: "small" }, "In your terminal: ", h("code", {}, `factory report ${r.runId}`), " · ", h("code", {}, `factory logs ${r.runId}`))));
}

function tracePanel(r) {
  const box = h("div", { class: "trace" }, r.trace.length ? r.trace.map((e) => h("div", { class: `k-${e.kind}` },
    h("span", { class: "t" }, new Date(e.ts).toTimeString().slice(0, 8)), h("span", { class: "w", title: e.where }, e.where), h("span", {}, e.msg))) : h("span", { class: "muted" }, "No trace lines yet."));
  return h("section", { class: "panel" }, h("div", { class: "panel-head" }, h("h2", {}, icon("terminal"), "Latest activity"), h("code", { class: "small muted" }, `factory logs ${r.runId} --follow`)), box);
}

// the side drawer for one step
const scrim = h("div", { class: "scrim", onclick: () => closeDrawer() });
const drawer = h("aside", { class: "drawer", "aria-hidden": "true" });
document.body.append(scrim, drawer);
document.addEventListener("keydown", (e) => { if (e.key === "Escape") closeDrawer(); });

function markSelected() {
  view.querySelectorAll(".node").forEach((n) => n.classList.toggle("sel", n.dataset.step === runState.drawer));
}
function openDrawer(step) {
  runState.drawer = step;
  paintDrawer();
  scrim.classList.add("open"); drawer.classList.add("open"); drawer.setAttribute("aria-hidden", "false");
  markSelected();
}
function closeDrawer() {
  runState.drawer = "";
  scrim.classList.remove("open"); drawer.classList.remove("open"); drawer.setAttribute("aria-hidden", "true");
  markSelected();
}
function paintDrawer() {
  const row = runState.last?.timeline.find((t) => t.step === runState.drawer);
  if (!row) return;
  const retries = retriesOf(row);
  drawer.replaceChildren(...[
    h("button", { class: "icon-btn x", type: "button", "aria-label": "Close", onclick: closeDrawer }, icon("x")),
    h("div", { class: "eyebrow" }, `${PHASES[phaseOf(row.step)]} · ${row.stage}`),
    h("h2", {}, row.step),
    pill(row.status),
    h("div", { class: "stats" },
      h("div", { class: "stat" }, h("div", { class: "k" }, "Attempts"), h("div", { class: "v" }, String(row.attempts))),
      h("div", { class: "stat" }, h("div", { class: "k" }, "Retries"), h("div", { class: "v" }, String(retries))),
      h("div", { class: "stat" }, h("div", { class: "k" }, "Cost"), h("div", { class: "v" }, money(row.costUsd))),
      h("div", { class: "stat" }, h("div", { class: "k" }, "Machine time"), h("div", { class: "v" }, secs(row.activeSec)))),
    row.models.length ? h("p", { class: "small muted" }, "Models: ", h("code", {}, row.models.join(", "))) : null,
    row.note ? h("div", { class: "pipe-note bad" }, icon("alert"), h("div", {}, h("strong", {}, "Parked here"), h("p", {}, row.note))) : null,
    h("h3", {}, "Gates"),
    row.gates.length ? h("div", { class: "chips" }, row.gates.map((g) => h("span", { class: `chip ${g.passed ? "pass" : "fail"}` }, icon(g.passed ? "check" : "x"), g.gateId))) : h("p", { class: "small muted" }, "No gates for this step."),
    h("h3", {}, "Attempts"),
    row.tries.length ? h("ul", { class: "attempts" }, row.tries.map((t) => h("li", { class: t.outcome },
      h("div", { class: "hd" }, h("span", {}, `Attempt ${t.attempt}`, t.rung ? h("span", { class: "faint" }, ` · rung ${t.rung}`) : null), pill(t.outcome, t.outcome === "decided" ? "card decided" : undefined)),
      t.why ? h("div", { class: "why" }, t.why) : null,
      t.next ? h("div", { class: "next" }, icon(t.next.startsWith("retry") ? "loop" : "arrow"), t.next) : null))) : h("p", { class: "small muted" }, "Not started yet."),
  ].filter(Boolean));
}

function runScreen(id) {
  if (runState.id !== id) Object.assign(runState, { id, seenGates: new Set(), cost: 0, share: 0, drawer: "", last: undefined });
  skeleton("grid");
  let lastJson = "";
  poll(2000, async (first) => {
    const r = await api(`/api/runs/${encodeURIComponent(id)}`);
    const json = JSON.stringify(r);
    if (json === lastJson) return; // nothing new: keep scroll positions and open sections
    lastJson = json;
    runState.last = r;
    const open = [...view.querySelectorAll("details")].map((d) => d.open);
    const oldTrace = view.querySelector(".trace");
    const atBottom = !oldTrace || oldTrace.scrollTop + oldTrace.clientHeight >= oldTrace.scrollHeight - 8;
    const right = [];
    if (r.card) right.push(cardPanel(r));
    if (r.status === "parked") right.push(parkedPanel(r));
    if (r.delivered) right.push(deliveredPanel(r));
    right.push(tracePanel(r));
    mount([...runHeader(r, "run"), h("div", { class: "stack" }, pipeline(r), h("div", { class: "grid-2" },
      h("div", { class: "stack" }, costPanel(r), gatesPanel(r)),
      h("div", { class: "stack" }, right)))], first);
    view.querySelectorAll("details").forEach((d, i) => { if (open[i]) d.open = true; });
    const t = view.querySelector(".trace");
    if (t && atBottom) t.scrollTop = t.scrollHeight;
    if (runState.drawer) paintDrawer();
  });
}


// ---------- one run: graphical ----------

const SVGNS = "http://www.w3.org/2000/svg";
/** Like h(), for SVG. Text goes in as text nodes. */
function sv(tag, attrs, ...kids) {
  const el = document.createElementNS(SVGNS, tag);
  for (const [k, v] of Object.entries(attrs ?? {})) {
    if (v === undefined || v === null) continue;
    // CSS variables through the CSSOM: the page's policy blocks style="" attributes
    if (k === "vars") for (const [n, x] of Object.entries(v)) el.style.setProperty(n, String(x));
    else el.setAttribute(k, String(v));
  }
  for (const kid of kids.flat(Infinity)) if (kid !== undefined && kid !== null && kid !== false) el.append(kid instanceof Node ? kid : document.createTextNode(String(kid)));
  return el;
}

const shortStep = (step) => (step.startsWith("implement/") ? step.slice("implement/".length) : step);

/** Horizontal bars, one per row; the widest value fills the chart. */
function barChart(rows, fmt, cls = "") {
  const W = 560, rowH = 24, left = 118, right = 64;
  const max = Math.max(1e-9, ...rows.map((r) => r.value));
  const H = Math.max(rowH, rows.length * rowH) + 6;
  return sv("svg", { class: `chart bars ${cls}`, viewBox: `0 0 ${W} ${H}`, role: "img", "aria-label": rows.map((r) => `${r.label} ${fmt(r.value)}`).join(", ") },
    rows.map((r, i) => {
      const y = i * rowH + 4;
      const w = Math.max(r.value > 0 ? 2 : 0, ((W - left - right) * r.value) / max);
      return sv("g", { class: `row s-${r.tone ?? "ok"}`, vars: { "--i": i } },
        sv("title", {}, `${r.label}: ${fmt(r.value)}`),
        sv("text", { x: left - 8, y: y + 13, class: "lab", "text-anchor": "end" }, r.label.length > 17 ? `${r.label.slice(0, 16)}…` : r.label),
        sv("rect", { x: left, y, width: W - left - right, height: rowH - 8, rx: 4, class: "trk" }),
        sv("rect", { x: left, y, width: w, height: rowH - 8, rx: 4, class: "bar" }),
        sv("text", { x: left + w + 6, y: y + 13, class: "val" }, fmt(r.value)));
    }));
}

/** Cumulative cost over time, with the cost limit as a dashed line. */
function costLine(points, cap) {
  const W = 560, H = 220, L = 46, R = 12, T = 12, B = 26;
  if (!points.length) return h("p", { class: "muted small" }, "No model calls yet.");
  const t0 = Date.parse(points[0].ts), t1 = Math.max(t0 + 1000, Date.parse(points[points.length - 1].ts));
  const top = Math.max(cap || 0, points[points.length - 1].usd) * 1.08 || 1;
  const x = (ts) => L + ((Date.parse(ts) - t0) / (t1 - t0)) * (W - L - R);
  const y = (usd) => T + (1 - usd / top) * (H - T - B);
  const d = points.map((p, i) => `${i ? "L" : "M"}${x(p.ts).toFixed(1)},${y(p.usd).toFixed(1)}`).join(" ");
  const area = `${d} L${x(points[points.length - 1].ts).toFixed(1)},${H - B} L${L},${H - B} Z`;
  const ticks = [0, 0.5, 1].map((k) => top * k);
  const minutes = (t1 - t0) / 60_000;
  return sv("svg", { class: "chart line", viewBox: `0 0 ${W} ${H}`, role: "img", "aria-label": `Cost over time: ${money(points[points.length - 1].usd)} of ${money(cap)}` },
    ticks.map((v) => [sv("line", { x1: L, x2: W - R, y1: y(v), y2: y(v), class: "grid" }), sv("text", { x: L - 6, y: y(v) + 4, class: "lab", "text-anchor": "end" }, `$${v.toFixed(v < 10 ? 1 : 0)}`)]),
    cap ? [sv("line", { x1: L, x2: W - R, y1: y(cap), y2: y(cap), class: "cap" }), sv("text", { x: W - R, y: y(cap) - 5, class: "lab cap-lab", "text-anchor": "end" }, `limit ${money(cap)}`)] : null,
    sv("path", { d: area, class: "area" }), sv("path", { d, class: "stroke" }),
    points.length < 60 ? points.map((p) => sv("circle", { cx: x(p.ts), cy: y(p.usd), r: 2.4, class: "pt" }, sv("title", {}, `${new Date(p.ts).toTimeString().slice(0, 8)}  ${money(p.usd)}`))) : null,
    sv("text", { x: L, y: H - 6, class: "lab" }, new Date(t0).toTimeString().slice(0, 5)),
    sv("text", { x: W - R, y: H - 6, class: "lab", "text-anchor": "end" }, `+${minutes < 90 ? `${Math.round(minutes)} min` : `${(minutes / 60).toFixed(1)} h`}`));
}

const toneOfStep = (x) => (x.outcome === "completed" ? (x.retries ? "wait" : "ok") : x.outcome === "failed" || x.outcome === "parked" ? "bad" : "live");

function chartsScreen(id) {
  skeleton("grid");
  let lastJson = "";
  poll(3000, async (first) => {
    const [r, st] = await Promise.all([api(`/api/runs/${encodeURIComponent(id)}`), api(`/api/runs/${encodeURIComponent(id)}/stats`)]);
    const json = JSON.stringify(st);
    if (json === lastJson && !first) return;
    lastJson = json;
    const rows = (key) => st.steps.map((x) => ({ label: shortStep(x.step), value: x[key], tone: toneOfStep(x) }));
    const panel = (i, ico, title, note, body) => h("section", { class: "panel rise", vars: { "--i": i } }, h("div", { class: "panel-head" }, h("h2", {}, icon(ico), title), note ? h("span", { class: "small muted" }, note) : null), body);
    const empty = h("p", { class: "muted small" }, "No steps yet.");
    mount([...runHeader(r, "charts"),
      h("div", { class: "grid-2 even" },
        panel(0, "dollar", "Cost per step", money(st.totalUsd), st.steps.length ? barChart(rows("costUsd"), money) : empty),
        panel(1, "clock", "Machine time per step", `${st.activeMin.toFixed(1)} min`, st.steps.length ? barChart(rows("activeSec"), secs, "time") : empty),
        panel(2, "activity", "Cost over time", `limit ${money(st.capUsd)}`, costLine(st.costOverTime, st.capUsd)),
        panel(3, "loop", "Retries per step", `${st.retries} in all`, st.steps.length ? barChart(rows("retries"), (n) => String(Math.round(n)), "retries") : empty)),
      h("p", { class: "legend small muted" }, h("span", { class: "sw ok" }), "first try", h("span", { class: "sw wait" }), "needed a retry", h("span", { class: "sw live" }), "running", h("span", { class: "sw bad" }), "failed or parked"),
    ], first);
  });
}

// ---------- one run: statistical ----------

const kTokens = (n) => (n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1000 ? `${(n / 1000).toFixed(1)}K` : String(Math.round(n)));

function statsScreen(id) {
  skeleton("grid");
  let lastJson = "";
  const prev = {};
  poll(3000, async (first) => {
    const [r, st] = await Promise.all([api(`/api/runs/${encodeURIComponent(id)}`), api(`/api/runs/${encodeURIComponent(id)}/stats`)]);
    const json = JSON.stringify(st);
    if (json === lastJson && !first) return;
    lastJson = json;
    const tile = (i, key, ico, label, value, fmt, unit, small, cls) => {
      const big = h("span");
      countUp(big, value, fmt, prev[key] ?? 0);
      prev[key] = value;
      return h("div", { class: `panel tile rise ${cls ?? ""}`, vars: { "--i": i } }, h("div", { class: "k" }, icon(ico), label), h("div", { class: "big" }, big, unit ? h("span", { class: "u" }, unit) : null), h("div", { class: "sm" }, small));
    };
    const left = Math.max(0, st.capUsd - st.totalUsd);
    const ftp = st.firstTimePass.finished ? (st.firstTimePass.passed / st.firstTimePass.finished) * 100 : 0;
    mount([...runHeader(r, "stats"), h("div", { class: "tiles" },
      tile(0, "cost", "dollar", "Total cost", st.totalUsd, money, "", `${st.costOverTime.length} model or agent calls`),
      tile(1, "left", "gauge", "Limit left", left, money, "", `of ${money(st.capUsd)} · ${Math.round((st.totalUsd / (st.capUsd || 1)) * 100)}% used`, left < st.capUsd * 0.1 ? "warn" : ""),
      tile(2, "active", "clock", "Machine time", st.activeMin, (n) => n.toFixed(1), "min", `wall clock ${st.wallMin.toFixed(0)} min, including waiting for people`),
      tile(3, "attempts", "loop", "Attempts", st.attempts, (n) => String(Math.round(n)), "", `${st.retries} retr${st.retries === 1 ? "y" : "ies"} across ${st.steps.length} steps`),
      tile(4, "ftp", "check", "First-time pass", ftp, (n) => String(Math.round(n)), st.firstTimePass.finished ? "%" : "", `${st.firstTimePass.passed} of ${st.firstTimePass.finished} finished steps`),
      tile(5, "gates", "shield", "Gates passed", st.gates.passed, (n) => String(Math.round(n)), `/ ${st.gates.passed + st.gates.failed}`, st.gates.failed ? `${st.gates.failed} failed (a failed gate makes the step retry)` : "none failed", st.gates.failed ? "warn" : ""),
      tile(6, "human", "user", "Human stops", st.humanStops, (n) => String(Math.round(n)), "", "cards answered in the terminal"),
      tile(7, "tokens", "activity", "Tokens in / out", st.tokens.input, kTokens, `/ ${kTokens(st.tokens.output)}`, `${kTokens(st.tokens.cached)} read from the prompt cache`),
    )], first);
  });
}

// ---------- one run: text ----------

function logScreen(id) {
  skeleton();
  const ui = { step: "", type: "", q: "", follow: true, source: "events", open: new Set(), built: false };
  let data = { events: [], trace: [], total: 0 };
  let list, count, stepSel, typeSel;
  const options = (sel, values, all) => {
    const cur = sel.value;
    sel.replaceChildren(h("option", { value: "" }, all), ...values.map((v) => h("option", { value: v }, v)));
    sel.value = values.includes(cur) ? cur : "";
  };
  const paint = () => {
    const q = ui.q.trim().toLowerCase();
    let rows;
    if (ui.source === "events") {
      rows = data.events.filter((e) => (!ui.step || e.step === ui.step) && (!ui.type || e.type === ui.type) && (!q || `${e.type} ${e.step ?? ""} ${JSON.stringify(e.detail)}`.toLowerCase().includes(q)));
      list.replaceChildren(...rows.map((e) => {
        const d = h("details", { class: `ev k-${e.type.split(".")[0]}`, "data-seq": e.seq, open: ui.open.has(e.seq) },
          h("summary", {}, h("span", { class: "seq" }, `#${e.seq}`), h("span", { class: "t" }, new Date(e.ts).toTimeString().slice(0, 8)), h("span", { class: "ty" }, e.type),
            h("span", { class: "st" }, e.step ? `${e.step}${e.attempt ? `#${e.attempt}` : ""}` : "")),
          h("pre", {}, JSON.stringify(e.detail, null, 2)));
        d.addEventListener("toggle", () => { if (d.open) ui.open.add(e.seq); else ui.open.delete(e.seq); });
        return d;
      }));
    } else {
      rows = data.trace.filter((t) => (!ui.step || t.step === ui.step) && (!q || `${t.kind} ${t.msg}`.toLowerCase().includes(q)));
      list.replaceChildren(...rows.map((t) => h("div", { class: `tl k-${t.kind}` }, h("span", { class: "t" }, new Date(t.ts).toTimeString().slice(0, 8)), h("span", { class: "st" }, t.step ?? "run"), h("span", {}, t.msg))));
    }
    count.textContent = `${rows.length} of ${ui.source === "events" ? data.events.length : data.trace.length} ${ui.source === "events" ? "events" : "trace lines"}`;
    if (ui.follow) list.scrollTop = list.scrollHeight;
  };
  poll(2000, async () => {
    const [r, ev] = await Promise.all([api(`/api/runs/${encodeURIComponent(id)}`), api(`/api/runs/${encodeURIComponent(id)}/events`)]);
    const changed = ev.total !== data.total || ev.trace.length !== data.trace.length;
    data = ev;
    if (!ui.built) {
      ui.built = true;
      stepSel = h("select", { "aria-label": "Step", onchange: () => { ui.step = stepSel.value; paint(); } });
      typeSel = h("select", { "aria-label": "Event type", onchange: () => { ui.type = typeSel.value; paint(); } });
      const search = h("input", { type: "text", placeholder: "Search", "aria-label": "Search", oninput: () => { ui.q = search.value; paint(); } });
      const follow = h("input", { type: "checkbox", checked: true, onchange: () => { ui.follow = follow.checked; if (ui.follow) paint(); } });
      const src = (key, label) => h("button", { type: "button", class: `tab${ui.source === key ? " on" : ""}`, "data-src": key, onclick: (e) => {
        ui.source = key;
        e.currentTarget.parentElement.querySelectorAll(".tab").forEach((b) => b.classList.toggle("on", b.dataset.src === key));
        typeSel.disabled = key !== "events";
        paint();
      } }, label);
      list = h("div", { class: "log", role: "log", "aria-live": "off" });
      list.addEventListener("scroll", () => {
        const atBottom = list.scrollTop + list.clientHeight >= list.scrollHeight - 8;
        if (ui.follow !== atBottom) { ui.follow = atBottom; follow.checked = atBottom; }
      });
      count = h("span", { class: "small muted" });
      mount([...runHeader(r, "log"), h("section", { class: "panel" },
        h("div", { class: "log-bar" }, h("div", { class: "tabs-in" }, src("events", "Ledger events"), src("trace", "Trace lines")), stepSel, typeSel, search,
          h("label", { class: "follow" }, follow, h("span", { class: "live" }), "Follow")),
        list,
        h("div", { class: "log-foot" }, count, h("code", { class: "small muted" }, `factory logs ${r.runId} --follow`)))], true);
    }
    if (changed || !list.childElementCount) {
      options(stepSel, [...new Set([...data.events.map((e) => e.step), ...data.trace.map((t) => t.step)].filter(Boolean))], "All steps");
      options(typeSel, [...new Set(data.events.map((e) => e.type))].sort(), "All event types");
      paint();
    }
  });
}

// ---------- one run: preview ----------

const VIEWPORTS = [["phone", 390], ["tablet", 768], ["desktop", 1280]];
/** One resize listener for the whole page; the preview screen sets what it does. */
let onResize = () => {};
window.addEventListener("resize", () => onResize());

function lightbox(img) {
  const close = () => { box.classList.remove("open"); setTimeout(() => box.remove(), reduced ? 0 : 220); document.removeEventListener("keydown", esc); };
  const esc = (e) => { if (e.key === "Escape") close(); };
  let body;
  if (img.beforeUrl) {
    const after = h("img", { src: img.url, alt: `${img.screen} after`, class: "after" });
    const range = h("input", { type: "range", min: 0, max: 100, value: 50, "aria-label": "Before and after", class: "ba-range" });
    const set = () => { after.style.clipPath = `inset(0 0 0 ${range.value}%)`; handle.style.transform = `translateX(${range.value}%)`; };
    const handle = h("div", { class: "ba-handle" }, h("span", {}));
    body = h("div", { class: "ba" }, h("img", { src: img.beforeUrl, alt: `${img.screen} before` }), after, h("div", { class: "ba-line" }, handle), range,
      h("span", { class: "ba-lab l" }, "before"), h("span", { class: "ba-lab r" }, "after"));
    range.addEventListener("input", set);
    set();
  } else body = h("img", { src: img.url, alt: img.screen });
  const box = h("div", { class: "lightbox", role: "dialog", "aria-label": img.screen, onclick: (e) => { if (e.target === box) close(); } },
    h("figure", {}, h("button", { class: "icon-btn x", type: "button", "aria-label": "Close", onclick: close }, icon("x")), body,
      h("figcaption", {}, h("strong", {}, img.screen), img.req ? h("span", { class: "tag" }, img.req) : null, h("span", { class: "tag" }, img.viewport))));
  document.body.append(box);
  document.addEventListener("keydown", esc);
  nextFrame(() => box.classList.add("open"));
}

async function previewScreen(id) {
  skeleton("grid");
  const [r, p] = await Promise.all([api(`/api/runs/${encodeURIComponent(id)}`), api(`/api/runs/${encodeURIComponent(id)}/preview`)]);
  if (p.none) {
    mount([...runHeader(r, "preview"), h("div", { class: "slot big-empty rise" }, icon("cursor"), h("strong", {}, "No preview for this run"), h("span", {}, p.none))], true);
    return;
  }
  const pv = p.preview;
  const url = (path) => p.base + path.split("/").map(encodeURIComponent).join("/");
  const parts = [];
  if (pv.site) {
    const screens = pv.site.screens.length ? pv.site.screens : [{ path: pv.site.entry, title: "Start" }];
    let width = 1280;
    const frame = h("iframe", { sandbox: "allow-scripts", title: "Clickable preview", src: url(screens[0].path), referrerpolicy: "no-referrer", loading: "lazy" });
    const stage = h("div", { class: "device" }, frame);
    const fit = () => {
      const avail = stage.parentElement ? stage.parentElement.clientWidth : width;
      const k = Math.min(1, avail / width);
      frame.style.width = `${width}px`;
      frame.style.transform = `scale(${k})`;
      stage.style.height = `${Math.round(720 * k)}px`;
      stage.style.width = `${Math.round(width * k)}px`;
    };
    const vpBtns = VIEWPORTS.map(([name, w]) => h("button", { type: "button", class: `tab${w === width ? " on" : ""}`, "data-w": w, onclick: (e) => {
      width = w; e.currentTarget.parentElement.querySelectorAll(".tab").forEach((b) => b.classList.toggle("on", Number(b.dataset.w) === w)); fit();
    } }, icon(name === "desktop" ? "browser" : "grid"), `${name} ${w}`));
    const list = h("ul", { class: "screens" }, screens.map((sc, i) => h("li", {}, h("button", { type: "button", class: i === 0 ? "on" : undefined, onclick: (e) => {
      frame.src = url(sc.path);
      list.querySelectorAll("button").forEach((b) => b.classList.remove("on")); e.currentTarget.classList.add("on");
    } }, h("span", {}, sc.title), sc.req ? h("span", { class: "tag" }, sc.req) : null))));
    parts.push(h("section", { class: "panel rise", vars: { "--i": 0 } },
      h("div", { class: "panel-head" }, h("h2", {}, icon("cursor"), "Clickable preview"), h("div", { class: "tabs-in vp" }, vpBtns)),
      h("div", { class: "pv" }, h("div", {}, h("div", { class: "eyebrow" }, "Screens"), list, h("p", { class: "small muted" }, "Runs in a locked frame: it can't reach this app, the network or your files.")),
        h("div", { class: "device-wrap" }, stage))));
    nextFrame(fit);
    onResize = fit;
  }
  if (pv.images.length) {
    const imgs = pv.images.map((i) => ({ ...i, url: url(i.file), beforeUrl: i.before ? url(i.before) : undefined }));
    parts.push(h("section", { class: "panel rise", vars: { "--i": 1 } },
      h("div", { class: "panel-head" }, h("h2", {}, icon("image"), "Designs"), h("span", { class: "small muted" }, `${imgs.length} image${imgs.length === 1 ? "" : "s"} · click to enlarge`)),
      h("div", { class: "gallery" }, imgs.map((img, i) => h("button", { type: "button", class: "shot rise", vars: { "--i": i }, onclick: () => lightbox(img) },
        h("img", { src: img.url, alt: img.screen, loading: "lazy" }),
        h("span", { class: "cap" }, h("strong", {}, img.screen), img.req ? h("span", { class: "tag" }, img.req) : null, h("span", { class: "tag" }, img.viewport), img.beforeUrl ? h("span", { class: "tag ba-tag" }, "before / after") : null))))));
  }
  mount([...runHeader(r, "preview"), h("div", { class: "stack" }, parts)], true);
}

// ---------- design ----------

async function designScreen(id) {
  skeleton("grid");
  const [r, d] = await Promise.all([api(`/api/runs/${encodeURIComponent(id)}`), api(`/api/runs/${encodeURIComponent(id)}/design`)]);
  let size;
  if ("none" in d.uiSize) size = h("p", { class: "muted" }, d.uiSize.none);
  else {
    const s = d.uiSize.size;
    size = [
      h("div", { class: "level-name" }, s.name),
      h("div", { class: "levels" }, d.levels.map((l) => h("div", { class: l.level === s.level ? "on" : undefined }, l.name))),
      h("p", { class: "small" }, h("strong", {}, "Design work: "), s.work),
      s.reasons.length ? h("ul", { class: "reasons small" }, s.reasons.map((x) => h("li", {}, x))) : null,
      d.uiSize.approvalCardLine ? h("div", { class: "quote" }, h("div", { class: "k" }, "On the approval card"), md(d.uiSize.approvalCardLine))
        : d.uiSize.cardLine ? null : h("div", { class: "quote small muted" }, "The plan touches no UI, so the approval card has no UI size line."),
    ];
  }
  let inv;
  if ("none" in d.inventory) inv = h("div", { class: "slot" }, icon("browser"), h("strong", {}, "No web UI found"), h("span", { class: "small" }, d.inventory.none));
  else {
    const i = d.inventory;
    inv = [
      h("div", { class: "tags" }, [i.stack.framework, i.stack.styling, i.stack.componentSystem].filter((x) => x && x !== "none-detected").map((x) => h("span", { class: "tag" }, x)),
        h("span", { class: "tag" }, h("span", { class: "n" }, "at"), i.commit.slice(0, 8)), h("span", { class: "tag" }, h("span", { class: "n" }, "verdict"), i.verdict)),
      h("h3", {}, `Pages (${i.pages.length})`),
      i.pages.length ? h("div", { class: "table-wrap" }, h("table", {}, h("thead", {}, h("tr", {}, h("th", {}, "Route"), h("th", {}, "Heading"), h("th", {}, "File"))),
        h("tbody", {}, i.pages.map((p) => h("tr", {}, h("td", { class: "mono" }, p.route), h("td", {}, p.heading ?? h("span", { class: "faint" }, "-")), h("td", { class: "mono small muted" }, p.path)))))) : h("p", { class: "muted" }, "No pages found."),
      h("h3", {}, `Building blocks (${i.buildingBlocks.length})`),
      h("div", { class: "tags" }, i.buildingBlocks.map((c) => h("span", { class: "tag", title: c.path }, c.name, h("span", { class: "n" }, `${c.uses}×`)))),
      h("h3", {}, `Shared components (${i.sharedComponents.length})`),
      i.sharedComponents.length ? h("div", { class: "tags" }, i.sharedComponents.map((c) => h("span", { class: "tag", title: c.path }, c.name, h("span", { class: "n" }, `${c.uses}×`)))) : h("p", { class: "small muted" }, "None."),
      h("p", { class: "small muted" }, `Theme tokens: ${i.tokens.light} light, ${i.tokens.dark} dark, ${i.tokens.theme} in @theme · off-system styling: ${i.offSystem.hexColors} hex colours, ${i.offSystem.arbitraryValues} arbitrary values, ${i.offSystem.inlineStyle} inline styles`),
    ];
  }
  const style = d.styleChecks.length
    ? h("div", { class: "chips" }, d.styleChecks.map((g) => h("span", { class: `chip ${g.passed ? "pass" : "fail"}` }, icon(g.passed ? "check" : "x"), g.gateId)))
    : h("p", { class: "muted small" }, "No style check results for this run. The pipeline doesn't run the style check yet; by hand: ", h("code", {}, "factory design lint --git <base> <head> --repo <repo>"), ".");
  mount([...runHeader(r, "design"),
    h("div", { class: "grid-2" },
      h("div", { class: "stack" },
        h("section", { class: "panel rise", vars: { "--i": 0 } }, h("div", { class: "panel-head" }, h("h2", {}, icon("ruler"), "UI change size")), size),
        h("section", { class: "panel rise", vars: { "--i": 1 } }, h("div", { class: "panel-head" }, h("h2", {}, icon("shield"), "Style check")), style),
        h("div", { class: "slot rise", vars: { "--i": 2 } }, icon("image"), h("strong", {}, "Before/after screenshots"), h("span", {}, "not built yet")),
        h("div", { class: "slot rise", vars: { "--i": 3 } }, icon("cursor"), h("strong", {}, "Clickable prototype (estimate mode)"), h("span", {}, "not built yet")),
      ),
      h("section", { class: "panel rise", vars: { "--i": 1 } }, h("div", { class: "panel-head" }, h("h2", {}, icon("grid"), "The app's pages and building blocks")), inv),
    )], true);
}

// ---------- dashboard ----------

async function dashboardScreen() {
  skeleton();
  const { outcomes: o, stages, recent = [] } = await api("/api/dashboard");
  const tile = (i, ico, label, value, fmt, unit, small) => {
    const big = h("span");
    countUp(big, value ?? NaN, (n) => (value === undefined || value === null ? "-" : fmt(n)));
    return h("div", { class: "panel tile rise", vars: { "--i": i } }, h("div", { class: "k" }, icon(ico), label), h("div", { class: "big" }, big, unit ? h("span", { class: "u" }, unit) : null), h("div", { class: "sm" }, small));
  };
  const maxCost = Math.max(0.01, ...stages.map((s) => s.avgCostUsd));
  const fills = [];
  const hbar = (value, share, cls, i) => {
    const fill = h("div", { class: "fill" });
    fill.style.transitionDelay = `${i * 40}ms`;
    fills.push([fill, Math.max(0, Math.min(1, share))]);
    return h("div", { class: `hbar ${cls}` }, h("div", { class: "track" }, fill), h("span", { class: "v" }, value));
  };
  mount([
    h("div", { class: "page-head" }, h("div", {}, h("div", { class: "eyebrow" }, "Dashboard"), h("h1", {}, "How the factory is doing"),
      h("p", { class: "sub" }, `Across all ${o.runs} runs on this computer: the same numbers as factory report --all.`))),
    o.runs ? h("div", { class: "tiles" },
      tile(0, "check", "Delivered", o.delivered, (n) => String(Math.round(n)), `of ${o.runs}`, `${o.parked} parked, ${o.waiting} waiting, ${o.running} running`),
      tile(1, "dollar", "Cost per delivered change", o.costPerDeliveredUsd, money, "", `all spend ${money(o.totalCostUsd)}, parked runs included · a delivered run alone ${money(o.avgDeliveredRunCostUsd)}`),
      tile(2, "clock", "Request → branch", o.wallMin.median, (n) => n.toFixed(n < 10 ? 1 : 0), o.wallMin.median === undefined ? "" : "min", `wall-clock median, includes waiting for people · worst ${mins(o.wallMin.worst)} · machine time median ${mins(o.activeMinMedian)}`),
      tile(3, "user", "Human stops", o.humanStopsPerDelivered, (n) => n.toFixed(1), "", `cards per delivered run · only the plan approval: ${pct(o.approvalOnlyShare)}`),
      tile(4, "shield", "First-time pass", o.firstTimePass.rate === undefined ? undefined : o.firstTimePass.rate * 100, (n) => String(Math.round(n)), o.firstTimePass.rate === undefined ? "" : "%", `of ${o.firstTimePass.finished} finished steps`),
    ) : h("div", { class: "panel empty" }, "No runs yet."),
    stages.length ? h("section", { class: "panel rise", vars: { "--i": 5 } }, h("div", { class: "panel-head" }, h("h2", {}, icon("bars"), "Per stage"), h("span", { class: "small muted" }, "most expensive first")),
      h("div", { class: "table-wrap" }, h("table", {},
        h("thead", {}, h("tr", {}, h("th", {}, "Stage"), h("th", { class: "num" }, "Runs"), h("th", {}, "First-time pass"), h("th", {}, "Avg cost"), h("th", { class: "num" }, "Avg time"), h("th", {}, "Most common problem"))),
        h("tbody", {}, stages.map((s, i) => h("tr", {},
          h("td", { class: "mono" }, s.stage), h("td", { class: "num" }, s.count),
          h("td", {}, hbar(pct(s.firstTimePassRate), s.firstTimePassRate, "ok", i)),
          h("td", {}, hbar(money(s.avgCostUsd), s.avgCostUsd / maxCost, "", i)),
          h("td", { class: "num" }, secs(s.avgActiveSec)),
          h("td", { class: "small" }, s.topProblem ? `${s.topProblem.reason} (${s.topProblem.count}×)` : h("span", { class: "faint" }, "-")),
        )))))) : null,
    recent.length ? h("section", { class: "panel rise", vars: { "--i": 6 } }, h("div", { class: "panel-head" }, h("h2", {}, icon("activity"), "Recent runs"), h("a", { href: "#/runs", class: "small" }, "All runs")),
      h("ul", { class: "recent" }, recent.map((r, i) => h("li", { class: `k-${tone(r.status)} rise`, vars: { "--i": i } },
        h("a", { href: `#/runs/${encodeURIComponent(r.runId)}` }, h("span", { class: "bar" }), h("span", { class: "req" }, r.request || r.runId),
          pill(r.status), h("span", { class: "mono small muted" }, money(r.costUsd)), h("span", { class: "small faint nowrap" }, ago(r.createdAt))))))) : null,
  ], true);
  nextFrame(() => { for (const [f, share] of fills) f.style.transform = `scaleX(${share})`; });
}

// ---------- router ----------

async function route() {
  generation++;
  clearTimeout(timer);
  onResize = () => {};
  document.querySelectorAll(".lightbox").forEach((b) => b.remove());
  closeDrawer();
  const hash = location.hash.replace(/^#/, "") || "/new";
  const parts = hash.split("/").filter(Boolean).map(decodeURIComponent);
  const top = parts[0] ?? "new";
  document.querySelectorAll("[data-nav]").forEach((a) => a.classList.toggle("on", a.dataset.nav === top));
  document.title = `AI Factory · ${{ new: "New run", runs: parts[1] ? parts[1] : "Runs", dashboard: "Dashboard" }[top] ?? ""}`;
  try {
    if (top === "new" && parts[1] === "brownfield") await requestScreen();
    else if (top === "new") modeScreen();
    else if (top === "runs" && parts[1] && parts[2] === "design") await designScreen(parts[1]);
    else if (top === "runs" && parts[1] && parts[2] === "preview") await previewScreen(parts[1]);
    else if (top === "runs" && parts[1] && parts[2] === "charts") chartsScreen(parts[1]);
    else if (top === "runs" && parts[1] && parts[2] === "stats") statsScreen(parts[1]);
    else if (top === "runs" && parts[1] && parts[2] === "log") logScreen(parts[1]);
    else if (top === "runs" && parts[1]) runScreen(parts[1]);
    else if (top === "runs") runsScreen();
    else if (top === "dashboard") await dashboardScreen();
    else modeScreen();
  } catch (e) {
    showError(e);
  }
}

window.addEventListener("hashchange", route);
route();
