// Runs inside container A. Reads /job/in.json, drives the Claude Agent SDK in /work,
// writes /job/out/result.json. No git, no ledger, no real secrets; the API key is added
// by the factory proxy (ANTHROPIC_BASE_URL points at it).
import { readFileSync, writeFileSync } from "node:fs";
import { query } from "@anthropic-ai/claude-agent-sdk";

const job = JSON.parse(readFileSync("/job/in.json", "utf8"));
const out = { status: "error", instructionsLoaded: [], deniedEdits: [], usage: {}, costUsd: 0, turns: 0 };

// same small glob as the core: **, *, ?, basename match when no slash
function globRe(g) {
  let s = g.replace(/^\.\//, "");
  const anyDepth = !s.includes("/") || s.startsWith("**/");
  let re = "";
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === "*") {
      if (s[i + 1] === "*") { const sl = s[i + 2] === "/"; re += sl ? "(?:.*/)?" : ".*"; i += sl ? 2 : 1; } else re += "[^/]*";
    } else if (c === "?") re += "[^/]";
    else re += c.replace(/[.+^$()|[\]\\{}]/g, "\\$&");
  }
  return new RegExp(`^${anyDepth && !s.startsWith("**/") ? "(?:.*/)?" : ""}${re}(?:/.*)?$`);
}
const protectedRes = (job.protectedGlobs ?? []).map(globRe);
const scopeRes = (job.fileScope ?? []).map(globRe);
const rel = (p) => String(p ?? "").replace(/^\/work\/?/, "").replace(/^\.\//, "");

function editDecision(path) {
  const r = rel(path);
  if (r.startsWith("/") || r.startsWith("..")) return `Path ${path} is outside the workspace`;
  if (protectedRes.some((re) => re.test(r))) return `${r} is locked or protected; you may not change it`;
  if (scopeRes.length && !scopeRes.some((re) => re.test(r))) return `${r} is outside this task's file scope (${job.fileScope.join(", ")})`;
  return undefined;
}

const hooks = {
  PreToolUse: [{
    hooks: [async (input) => {
      const tool = input.tool_name;
      const ti = input.tool_input ?? {};
      if (["Write", "Edit", "MultiEdit", "NotebookEdit"].includes(tool)) {
        const reason = editDecision(ti.file_path ?? ti.notebook_path);
        if (reason) {
          out.deniedEdits.push(rel(ti.file_path ?? ti.notebook_path));
          return { hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: reason } };
        }
      }
      if (tool === "Bash" && /\bgit\b|curl|wget|nc |ssh |dotnet\s+(add|nuget)|npm\s+(i|install|add)\b/.test(String(ti.command ?? ""))) {
        return { hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: "No git, network or package installs here. New packages must be declared in the plan." } };
      }
      return {};
    }],
  }],
  InstructionsLoaded: [{
    hooks: [async (input) => { out.instructionsLoaded.push(input.file_path); return {}; }],
  }],
};

async function main() {
  const res = query({
    prompt: job.task,
    options: {
      cwd: "/work",
      model: job.model,
      effort: job.effort,
      maxTurns: job.maxTurns,
      maxBudgetUsd: job.maxUsd,
      settingSources: [],
      persistSession: false,
      permissionMode: "dontAsk",
      tools: ["Read", "Edit", "Write", "Glob", "Grep", "Bash"],
      allowedTools: ["Read", "Edit", "Write", "Glob", "Grep", "Bash"],
      systemPrompt: { type: "preset", preset: "claude_code", append: job.system, excludeDynamicSections: true },
      outputFormat: { type: "json_schema", schema: job.schema },
      hooks,
      env: { ...process.env, DISABLE_COMPACT: "1", DISABLE_AUTOUPDATER: "1", CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1", CLAUDE_AGENT_SDK_CLIENT_APP: "ai-factory/0.1" },
    },
  });
  for await (const m of res) {
    if (m.type === "system" && m.subtype === "init") out.sessionId = m.session_id;
    if (m.type === "result") {
      out.turns = m.num_turns;
      out.costUsd = m.total_cost_usd;
      out.usage = m.usage;
      out.modelUsage = m.modelUsage;
      if (m.subtype === "success" && !m.is_error) {
        out.status = "ok";
        out.output = m.structured_output;
      } else {
        out.status = { error_max_turns: "max-turns", error_max_budget_usd: "over-budget", error_max_structured_output_retries: "bad-output" }[m.subtype] ?? "error";
        out.error = m.subtype;
      }
    }
  }
}

main().catch((e) => { out.status = "error"; out.error = String(e?.message ?? e); })
  .finally(() => writeFileSync("/job/out/result.json", JSON.stringify(out)));
