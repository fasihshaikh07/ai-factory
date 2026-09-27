// Secret redaction for packs and tool results (context-builder §2.6).
// Built-in rules are a backstop; the real control is no live secrets where a model acts.
// Hits become stable placeholders «SECRET_n»; values are never stored.

const RULES: { id: string; re: RegExp }[] = [
  { id: "private-key", re: /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g },
  { id: "aws-access-key", re: /\b(AKIA|ASIA)[0-9A-Z]{16}\b/g },
  { id: "github-token", re: /\b(gh[pousr]_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{60,})\b/g },
  { id: "anthropic-key", re: /\bsk-ant-[A-Za-z0-9_-]{20,}\b/g },
  { id: "openai-key", re: /\bsk-(proj-)?[A-Za-z0-9_-]{32,}\b/g },
  { id: "slack-token", re: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g },
  { id: "jwt", re: /\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g },
  { id: "azure-storage", re: /AccountKey=[A-Za-z0-9+/=]{40,}/g },
  // password=... inside connection strings or config, keep the key, redact the value
  { id: "password-assignment", re: /((?:password|pwd|passwd|secret|api[_-]?key|access[_-]?token)\s*[=:]\s*["']?)([^"'\s;,}]{6,})/gi },
];

export interface Redaction { text: string; hits: { rule: string; placeholder: string }[] }

/** Redact with placeholders that stay stable across calls within one run (same value → same n). */
export class Redactor {
  private readonly seen = new Map<string, string>();

  redact(text: string): Redaction {
    const hits: Redaction["hits"] = [];
    let out = text;
    for (const rule of RULES) {
      out = out.replace(rule.re, (...m: string[]) => {
        const isAssign = rule.id === "password-assignment";
        const value = isAssign ? m[2]! : m[0]!;
        if (isAssign && /^(«SECRET_\d+»|\*+|x+|dummy|changeme|placeholder|your[_-].*|<.*>|\{\{.*)$/i.test(value)) return m[0]!;
        let ph = this.seen.get(value);
        if (!ph) {
          ph = `«SECRET_${this.seen.size + 1}»`;
          this.seen.set(value, ph);
        }
        hits.push({ rule: rule.id, placeholder: ph });
        return isAssign ? `${m[1]}${ph}` : ph;
      });
    }
    return { text: out, hits };
  }

  get count(): number {
    return this.seen.size;
  }
}

/** Scan without redacting: where secrets are (for per-commit scans). Values are never returned. */
export function scanText(file: string, text: string): { file: string; line: number; rule: string }[] {
  const hits: { file: string; line: number; rule: string }[] = [];
  const lines = text.split("\n");
  lines.forEach((line, i) => {
    const r = new Redactor().redact(line);
    for (const h of r.hits) hits.push({ file, line: i + 1, rule: h.rule });
  });
  // multi-line private keys
  if (/-----BEGIN [A-Z ]*PRIVATE KEY-----/.test(text) && !hits.some((h) => h.rule === "private-key")) {
    const line = lines.findIndex((l) => l.includes("PRIVATE KEY-----")) + 1;
    hits.push({ file, line, rule: "private-key" });
  }
  return hits;
}
