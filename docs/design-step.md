# The design step: where it plugs into the factory (2026-09-29)

## Summary

The design research gave us a set of free, scripted checks for UI changes. They are now ported to TypeScript in `src/design/`, with tests. They work on Next.js apps (app router and pages router, with or without `src/`) as well as on the Vite app they were first written for. They use no model and no network.

The four pieces, and where each sits in a run:

| Piece | What it does | Where it plugs in | State |
|---|---|---|---|
| **Inventory** | Scans the app: framework, theme tokens, shared building blocks (for example `components/ui`), shared components with how often each is used, pages, and how much styling sits outside the design system | **Discover**, into the repo profile | Built, with a CLI command. Not yet called by discover (see "Wiring still to do") |
| **UI change size** | Sorts a change into **no UI**, **screen tweak**, **new screen** or **design-system change**, with a plain list of reasons | **After plan**, from the plan's file list; again **after integrate**, from the real diff | Built. The approval card now shows the size |
| **Size-cap check** | Fails when the finished diff is a bigger UI change than the size that was approved | **After integrate**, as a gate | Gate predicate built and tested. Not yet called by integrate |
| **Fidelity check** | Lint of the diff: theme tokens only, existing components only, no new building blocks. Also traces requirements to screens both ways, and compares layout and accessibility between the approved mock and the final screens | **After implement** (lint) and at **accept** (screenshots) | Lint, trace and comparisons built. The screenshot step itself is not built |
| **Brief cleaner** | Turns an untrusted design extract (Figma export, screenshot reading, brand guide) into typed fields only | Before **design-read**, in the locked room | Built |

What the size decides:
- **No UI:** no design step.
- **Screen tweak:** a short screen note, no mock, plus a before/after screenshot.
- **New screen:** a mock in the real app on a design branch, and state screenshots at 390 and 1280 px on the approval card.
- **Design-system change:** as for a new screen, plus a diff of the tokens or building blocks for the human to accept.

On real repos, the ported size check agrees with hand labels on 47 of 56 commits; the teammate's original got 32. It finds every page on two Next.js apps, where the original found none. See `docs/design-eval/results.md`.

**Not built:** the screenshot step (it needs a Node + Chromium lab container), the design mock step, direction proposals for new apps (their data files are missing), the pixel diff, and the calls from discover and integrate.

## The four sizes, precisely

The classifier (`src/design/size.ts`) takes a list of files, each marked add, modify or delete. In git mode it also reads each file before and after the change.

- **Design-system change:**
  - a new building block (a new file under the app's building-block folder, for example `components/ui/`);
  - a building block whose running code changes;
  - a stylesheet whose custom properties or `@theme` block change;
  - Tailwind theme settings that change (colours, fonts, container, animations);
  - a new app.
- **New screen:**
  - a new page: Next.js `app/**/page.tsx`, a pages-router page, a feature folder entry, or a file route;
  - a new file whose name contains the whole word dialog, drawer, sheet, modal, form or wizard (so `user-form.tsx` counts, `platform-badge.tsx` doesn't).
- **Screen tweak:** any other change to a UI file (`.tsx`, `.jsx`, stylesheets), including navigation, layouts, `loading`/`error`/`not-found`, and helper components in private `_components` folders.
- **No UI:** nothing above. Tests, stories, email templates and `public/` don't count.

Rules that keep it from over-ranking:
- Deleting a file never makes a change bigger than a screen tweak.
- A file moved without changes doesn't count, unless it is a page whose URL changes (then it is a screen tweak).
- In git mode, a building-block edit that is a pure reorder of classes, changes only types, or changes only imports stays a screen tweak. Both versions are compiled without types and compared.
- `globals.css` counts as a design-system change only when its tokens change. In plan mode, where there is no content yet, a planned `globals.css` edit is a screen tweak with a note: the size-cap check after the build catches it if it turns out to touch tokens.

Where the app keeps things is detected, not hard-coded:
- **Source root:** `src/` or the repo root.
- **Import aliases:** from `tsconfig.json` or `jsconfig.json` paths, defaulting to `@/`.
- **Building-block folder:** from `components.json`, else `components/ui`, else `ui/`.
- **Page conventions:** from the framework and folders.

The CLI takes overrides for the source root and the building-block folder.

## Where each piece plugs in

### Discover: inventory into the repo profile
- `buildInventory(dirSource(snapshot.root))` over the run's snapshot. It is a file walk that takes about a second, so it reruns on every run. There is no cache and no "should we re-extract" decision (see "Dropped").
- Run it only when the repo (or a folder in it) has a `package.json` with `react` or `next`.
- Store it as part of the repo profile. Two things go on the onboarding card: the verdict (consistent, partial or no design system) and the summary lines from `inventorySummary()`.
- If the verdict is "no design system", record that on the onboarding card. New pages then copy their nearest sibling page. Don't start a design-system extraction unless the human asks.

### After plan: the size, from the plan's file list
- `plannedChanges(fileScope, snapshotFiles, layout)` turns the plan's paths and globs into planned changes:
  - an existing path is a modify;
  - a missing path is an add;
  - a glob that matches nothing under `app/` is read as a new page.
- `sizeChange()` then gives the size and the reasons.

### Approval card: the size, and later the mock
- **Built now.** The card gets one line under "Files the plan will touch", for example: `UI size: **new screen** (new page app/(shop)/invoices/page.tsx (route /invoices)). Design work: …`. The line is left out when the plan touches no UI, so .NET runs see the same card as before. The change to `src/stages/spec.ts` is three added lines; the logic is in `src/design/card.ts`.
- **Later:** for a new screen or bigger, the card shows the mock screenshots (390 and 1280 px, every state), and the requirement-to-screen trace. The approved size is stored with the approval, so the size-cap check can read it. The human can raise the size on the card, but never lower it.

### After implement: fidelity lint (per task)
- `lintDiff(inventoryAtBase, diffFromGit(worktree, taskStart, head))`, then the `design.fidelity-lint` gate. It fails:
  - on hex colours;
  - on arbitrary Tailwind values the app's own building blocks don't already use;
  - on inline styles;
  - on imports of components that are neither in the inventory nor added by this change;
  - on any new building block.
- If the inventory found no components, the lint reports "could not check" and the gate fails. A gate that passes having checked nothing is worse than no gate.

### After integrate: size-cap check
- Producer: `sizeFromGit(worktree, base, integratedHead)`, stored as an artifact.
- Gate: `design.size-cap` with inputs `{ actual, approved: { level } }`. It fails when the real change is bigger than the approved size, and lists the reasons.
- It can be waived by a human, like the diff-size gate.

### Accept: screenshots and comparisons (not built)
The screenshot step writes one report per state: element boxes, accessibility results, and whether the page scrolls sideways. `compareReports(approved, final)` then:
- **fails** on a new accessibility problem. That includes a new element that breaks a rule the page already broke, because the comparison is by rule and element, not by rule alone;
- **fails** on a missing state or sideways scrolling;
- reports moved or missing elements as evidence for the PR reviewer, not as a new human stop.

## Wiring still to do (exact places)

Discover and integrate are the .NET path's busiest code and are being changed on `main`, so these calls are described here and not made yet:

1. **Discover** (`src/stages/build.ts`, `discoverStep.run`):
   - After the refusal checks, when `snapshotFor(ctx)` has a `package.json` with `react` or `next`, call `buildInventory(dirSource(snap.root))`.
   - Store it with `ctx.ledger.putJson(...)` and return its sha as a second named output, `design`. Nothing reads it yet, so this changes no other step.
   - A .NET repo's frontend folder is usually a `noGo` glob, so it isn't in the snapshot. For a mixed repo, the inventory would need its own snapshot rule (read-only, frontend folder only).
2. **Approve:** record the size with the approval (`data: { uiSize: level }`), so integrate can read the approved level from the ledger.
3. **Integrate** (`src/stages/build.ts`, `integrateStep`):
   - After the existing gates, compute `sizeFromGit(repo, baseCommit, head)`.
   - Run `runGate(designSizeCap, ctx.ledger, ctx.writer, { actual, approved }, ctx.policy, { step: "integrate" })`, but only when the approved size isn't "no UI". .NET runs skip it.
4. **Implement** (`implementStep` task checks): the same pattern with `designFidelityLint`, only for UI tasks.
5. **Project config** (`src/config/project.ts`): an optional `design:` block with `sourceRoot`, `uiDir`, `brandFonts` and `navRaises`. It is not added yet, because the config is still .NET-only (`stack: dotnet`).

## Brief cleaner and the untrusted-text rule

`cleanBrief(raw, inventory, { brandFonts })` keeps only typed fields:
- palette entries (a plain name plus a hex colour);
- font names (Google Fonts, generic families, or the project's configured brand fonts);
- spacing and radius numbers in range;
- screens made of named regions, mapped to components in the inventory.

Everything else is dropped and logged. Text is folded to plain letters (NFKC) before it is checked, so full-width look-alike letters don't slip past the filter.

Free-text notes are kept apart as `untrustedNotes`. Following the context builder's rule that untrusted text is only allowed in read-only steps, `writerView(brief)` (what a writing step such as design-mock or implement may see) never contains them. The notes may go to design-read (read-only, locked room), fenced as untrusted.

The filter on notes is a first pass only. The real protection is that the notes never reach a writing step, and that the human approves the resulting design on the card.

## Dropped

The **extraction cache and its "should we re-extract" check** (`should-extract`, `update-extraction-cache`) are not ported. They guard an expensive extraction step that exists in none of the shared material. The inventory itself is a cheap file walk, so it reruns on every run, from the run's own snapshot. If the teammate later shows an expensive model-driven extraction, the cache can come back in front of that step only.

## Not ported, and what a Next.js screenshot step needs

- **Direction proposals** (`propose-directions`) need five ui-ux-pro-max data files we don't have. Without them, it alternates density at random. That leaves the new-app style pick out for now.
- **State screenshots and the acceptance probe** (`capture-states`, `accept-user-detail`) only work on a Vite dev server: they import fixture modules by source path inside the browser. A Next.js-capable replacement needs:
  - **Seeded fixtures by id, or MSW:** one fixture set, served the same way to the mock, the screenshots and accept. Otherwise every pixel diff fails.
  - **A frozen clock and fixed random seed,** so "3 minutes ago" and generated data don't change between runs.
  - **Reduced motion and no animations,** and waits on network idle and fonts loaded.
  - **Fixed viewports** at 390 and 1280 px, one screenshot and one report (element boxes, accessibility results, sideways scroll) per state.
  - **A Node + Chromium lab container with no network,** reading the run's snapshot or worktree, not the developer's folder. It builds the app (`next build` and `next start`, or the dev server) with packages restored read-only, like the .NET test lab.
  - **Playwright tests with a machine-readable report** for the acceptance checks, written by our test writer from the acceptance criteria and locked by hash. Not hand-written probe scripts.
- **The pixel diff** needs image libraries (pixelmatch, pngjs). They are not added until the screenshot step exists. The layout comparison already catches the case where a real layout change falls under the pixel threshold.

## Running it by hand

```
factory design inventory <repo> [--ref <commit>] [--json] [--source-root src] [--ui-dir src/components/ui]
factory design size --plan <file.json> [--repo <repo>]      # { files: [{ path, change }] } or a plan with tasks[].fileScope
factory design size --git <base> <head> [--repo <repo>] [--nav-raises]
factory design lint --git <base> <head> [--repo <repo>]     # exits 1 unless everything passed
factory design brief <extract.json> [--repo <repo>] [--brand-font "Acme Sans"]
```

## Known limits

- Code edits to a building block that don't change its look (a removed prop, an export style change) still count as design-system changes. So do class rewrites to an equivalent shorter form (`min-w-[8rem]` → `min-w-32`). Only a before/after screenshot can settle these.
- The size check from a plan's file list has not been measured on real plans yet, because there are none. In plan mode there is no file content, so building-block edits are always read as design-system changes.
- Apps without Tailwind or shadcn (MUI, CSS modules) get an inventory and a size, but the token lint knows only Tailwind arbitrary values and hex colours.
