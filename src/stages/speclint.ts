// Deterministic spec lint (spec-stage §4). L7 (open questions) and L5 details are partial in the POC.
import type { ChangeClass, SpecDraft } from "../contracts/index.js";

export interface LintResult { check: string; passed: boolean; details: string; blocking: boolean }

const EARS = [
  /^The .+ shall .+/i,                                   // ubiquitous
  /^When .+, the .+ shall .+/i,                          // event
  /^While .+, the .+ shall .+/i,                         // state
  /^If .+, then the .+ shall .+/i,                       // unwanted
  /^Where .+, the .+ shall .+/i,                         // optional feature
  /^(While|When) .+, (when|while) .+, the .+ shall .+/i, // complex
];
const VAGUE = /\b(fast|quick(ly)?|user[- ]friendly|easy|easily|robust|efficient(ly)?|appropriate(ly)?|adequate|reasonable|as needed|etc\.?|some|several|many|few|flexible|seamless(ly)?|intuitive|optimal|minimi[sz]e|maximi[sz]e)\b/i;
const NUMBER = /\d/;
const OBSERVABLE = /\b(respon[sd]|status|return|row|record|table|database|db|call|request|sent|email|message|screen|page|display|shown|show|visible|error|log|event|header|body|json|field|value|count|list|file)\w*/i;
const LITERAL_ID = /\b([A-Z]{2,}-\d+|\d{4,}|[A-Z][a-z]+ (Inc|LLC|Ltd|GmbH|Corp))\b/;

export function lintSpec(spec: SpecDraft, ctx: { spans: string[]; changeClass: ChangeClass; anchorOk: (reqId: string) => boolean }): LintResult[] {
  const out: LintResult[] = [];
  const add = (check: string, fails: string[], blocking = true) =>
    out.push({ check, passed: fails.length === 0, details: fails.length ? fails.slice(0, 8).join("; ") : "ok", blocking });

  // L1 ids unique and well-formed
  const ids = [...spec.requirements.map((r) => r.id), ...spec.requirements.flatMap((r) => r.acceptance.map((a) => a.id)), ...spec.nfrs.map((n) => n.id)];
  const dup = ids.filter((id, i) => ids.indexOf(id) !== i);
  const badReq = spec.requirements.filter((r) => !/^REQ-\d+$/.test(r.id)).map((r) => `bad id ${r.id}`);
  const badAc = spec.requirements.flatMap((r) => r.acceptance.filter((a) => !new RegExp(`^AC-${r.id.slice(4)}\\.\\d+$`).test(a.id)).map((a) => `${a.id} should be AC-${r.id.slice(4)}.n`));
  add("L1 ids", [...dup.map((d) => `duplicate ${d}`), ...badReq, ...badAc]);

  // L2 REQ ↔ AC
  add("L2 req-ac", spec.requirements.flatMap((r) => [
    ...(r.op !== "REMOVED" && !r.acceptance.length ? [`${r.id} has no acceptance criterion`] : []),
    ...r.acceptance.filter((a) => !a.given.trim() || !a.when.trim() || !a.then.trim()).map((a) => `${a.id} is missing Given/When/Then`),
  ]));

  // L3 EARS
  add("L3 ears", spec.requirements.flatMap((r) => {
    const f: string[] = [];
    if (!EARS.some((re) => re.test(r.ears.trim()))) f.push(`${r.id} isn't in an EARS pattern`);
    if ((r.ears.match(/\bshall\b/gi) ?? []).length !== 1) f.push(`${r.id} needs exactly one "shall"`);
    if (/\band\/or\b/i.test(r.ears)) f.push(`${r.id} uses "and/or"`);
    return f;
  }));

  // L4 vague words without a number
  add("L4 vague", [...spec.requirements.map((r) => ({ id: r.id, t: r.ears })), ...spec.nfrs.map((n) => ({ id: n.id, t: n.text }))]
    .filter((x) => VAGUE.test(x.t) && !NUMBER.test(x.t)).map((x) => `${x.id} uses a vague word ("${x.t.match(VAGUE)![0]}") with no number`));

  // L5 NFR metric
  add("L5 nfr", spec.nfrs.filter((n) => !n.metric.trim() || !NUMBER.test(n.metric)).map((n) => `${n.id} has no measurable metric`));

  // L6 out of scope present
  add("L6 scope", spec.outOfScope.length ? [] : ["out-of-scope list is empty; say explicitly what isn't changing"], false);

  // L8 anchors
  add("L8 anchors", spec.requirements.filter((r) => r.op !== "ADDED").flatMap((r) =>
    !r.anchors?.length ? [`${r.id} is ${r.op} but has no anchor to existing code`] : !ctx.anchorOk(r.id) ? [`${r.id} has an anchor that doesn't match the code`] : [],
  ));

  // L9 size
  const acs = spec.requirements.reduce((n, r) => n + r.acceptance.length, 0);
  const maxReq = ctx.changeClass === "bugfix" ? 4 : 12;
  add("L9 size", spec.requirements.length > maxReq || acs > 30 ? [`${spec.requirements.length} requirements / ${acs} ACs is over the budget for a ${ctx.changeClass}; split into a run sequence`] : []);

  // L10 traceability
  const covered = new Set(spec.requirements.flatMap((r) => r.sources));
  add("L10 trace", [
    ...ctx.spans.filter((s) => !covered.has(s) && !spec.outOfScope.some((o) => o.includes(s))).map((s) => `intent span ${s} isn't covered by any requirement or listed as out of scope`),
    ...spec.requirements.filter((r) => !r.sources.length).map((r) => `${r.id} has no source span`),
  ]);

  // L11 observable surface
  add("L11 observable", spec.requirements.flatMap((r) => r.acceptance.filter((a) => a.level !== "manual" && !OBSERVABLE.test(a.then)).map((a) => `${a.id}'s Then doesn't name something observable (response, row, call, screen)`)));

  // L12 literal ids (advisory)
  add("L12 literals", spec.requirements.filter((r) => LITERAL_ID.test(r.ears)).map((r) => `${r.id} hardcodes "${r.ears.match(LITERAL_ID)![0]}"; should it be configuration?`), false);

  return out;
}
