// A tiny, safe Markdown renderer for cards and PR text. Everything is HTML-escaped first; only a
// fixed set of tags is added afterwards (headings, lists, quotes, code, bold, italics, simple
// tables). No raw HTML, no links, no images: card text comes from models and from requests.
// Cards are written for a terminal, so lines are kept as they are (no re-flowing).

/** Escape text for HTML (content and attribute values). */
export function esc(text) {
  return String(text)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

/** Inline marks on already-escaped text. */
function inline(escaped) {
  return escaped
    .replace(/`([^`]+)`/g, "<code>$1</code>")
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
    .replace(/(^|[\s(])_([^_\n]+)_(?=$|[\s).,;:])/g, "$1<em>$2</em>");
}

/** Markdown → safe HTML string. */
export function renderMarkdown(text) {
  const lines = String(text ?? "").replace(/\r\n?/g, "\n").split("\n");
  const out = [];
  let i = 0;
  const para = [];
  const flush = () => {
    if (para.length) out.push(`<p>${para.join("<br>")}</p>`);
    para.length = 0;
  };
  while (i < lines.length) {
    const line = lines[i];
    const fence = /^```/.test(line);
    if (fence) {
      flush();
      const body = [];
      i++;
      while (i < lines.length && !/^```/.test(lines[i])) body.push(lines[i++]);
      i++;
      out.push(`<pre><code>${esc(body.join("\n"))}</code></pre>`);
      continue;
    }
    const h = /^(#{1,6})\s+(.*)$/.exec(line);
    if (h) { flush(); const n = Math.min(h[1].length + 1, 6); out.push(`<h${n}>${inline(esc(h[2]))}</h${n}>`); i++; continue; }
    if (/^\s*$/.test(line)) { flush(); i++; continue; }
    if (/^\s*(---|\*\*\*)\s*$/.test(line)) { flush(); out.push("<hr>"); i++; continue; }
    if (/^>/.test(line)) {
      flush();
      const body = [];
      while (i < lines.length && /^>/.test(lines[i])) body.push(inline(esc(lines[i++].replace(/^>\s?/, ""))));
      out.push(`<blockquote>${body.join("<br>")}</blockquote>`);
      continue;
    }
    if (/^\s*\|.*\|\s*$/.test(line)) {
      flush();
      const rows = [];
      while (i < lines.length && /^\s*\|.*\|\s*$/.test(lines[i])) rows.push(lines[i++]);
      const cells = (r) => r.trim().replace(/^\||\|$/g, "").split("|").map((c) => inline(esc(c.trim())));
      const body = rows.filter((r) => !/^\s*\|[\s:|-]+\|\s*$/.test(r));
      const [head, ...rest] = body;
      out.push(`<table><thead><tr>${cells(head).map((c) => `<th>${c}</th>`).join("")}</tr></thead><tbody>${rest.map((r) => `<tr>${cells(r).map((c) => `<td>${c}</td>`).join("")}</tr>`).join("")}</tbody></table>`);
      continue;
    }
    if (/^\s*([-*]|\d+\.)\s+/.test(line) && !/^\s{2,}/.test(line)) {
      flush();
      const ordered = /^\s*\d+\./.test(line);
      const items = [];
      while (i < lines.length && /^\s*([-*]|\d+\.)\s+/.test(lines[i]) && !/^\s{2,}/.test(lines[i])) {
        items.push(`<li>${inline(esc(lines[i++].replace(/^\s*([-*]|\d+\.)\s+/, "")))}</li>`);
      }
      out.push(ordered ? `<ol>${items.join("")}</ol>` : `<ul>${items.join("")}</ul>`);
      continue;
    }
    if (/^\s{2,}factory\s/.test(line) || /^( {4}|\t)/.test(line)) {
      flush();
      const body = [];
      while (i < lines.length && (/^\s{2,}factory\s/.test(lines[i]) || /^( {4}|\t)/.test(lines[i]))) body.push(lines[i++].replace(/^\s+/, ""));
      out.push(`<pre><code>${esc(body.join("\n"))}</code></pre>`);
      continue;
    }
    // other indented lines (answer options, notes) keep their indent
    const indent = /^(\s{2,})/.exec(line);
    para.push(indent ? `<span class="ind">${inline(esc(line.trim()))}</span>` : inline(esc(line)));
    i++;
  }
  flush();
  return out.join("\n");
}
