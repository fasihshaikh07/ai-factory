# AI Factory (POC)

Turns a typed request into a verified pull request on a .NET + Postgres repo.
Design: `docs/design/` (start with `BUILD-BRIEF.md`, then `stages-aligned.md`).

## Setup (once)
1. Docker Engine inside Ubuntu (not Docker Desktop). `factory doctor` checks it.
2. `~/.factory/.env` — you create it; the factory never asks for keys:
   `ANTHROPIC_API_KEY=...` (optional `OPENAI_API_KEY=...` for the critic and review), then `chmod 600 ~/.factory/.env`.
3. `~/.factory/projects/<name>.yaml` — copy `docs/project-example.yaml`.
4. `npm install`

## Use
    npm run factory -- doctor
    npm run factory -- start "what you want changed" --project <name>
    npm run factory -- show-card <run>
    npm run factory -- approve <run> <hash> --note "risk note"
    npm run factory -- status [run]
    npm run factory -- resume <run>
    npm run factory -- verify-evidence <run>

## What's built (brownfield slice)
discover + baseline → intake → ground → specify + lint → critic → plan → approval card →
stub commit → author-tests (must fail on the old code twice, then locked) →
implement per task ⟲ task verify → integrate → accept → review → deliver (branch + manifest; PR only if `forge` is set).

## Not built yet
Clarify questions, 3-draft spec merge and round trip; app boot + HTTP replay in accept;
review repair loop (blocking findings park); test-defect check and unlock card; applying `steer` changes;
Codex and jcode runners; URL-prefix TLS feed proxy (host allowlist for now); greenfield, estimate, linked runs.

## Tests
    npm test        # all offline, no model calls
