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
    h("div", { class: "subnav" }, h("a", { href: `#/runs/${id}`, class: tab === "run" ? "on" : undefined }, icon("activity"), "Progress"),
      h("a", { href: `#/runs/${id}/design`, class: tab === "design" ? "on" : undefined }, icon("browser"), "Design")),
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
  const { outcomes: o, stages } = await api("/api/dashboard");
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
  ], true);
  nextFrame(() => { for (const [f, share] of fills) f.style.transform = `scaleX(${share})`; });
}

// ---------- router ----------

async function route() {
  generation++;
  clearTimeout(timer);
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
