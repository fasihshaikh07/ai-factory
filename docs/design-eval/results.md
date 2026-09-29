# Design toolkit: evaluation on real repos (2026-09-29)

## Summary

- **Size classifier accuracy on 56 hand-labelled Next.js commits: 47 right with the port, 32 with the original script.** On the 42 hard commits (the ones either tool ranked "new screen" or higher, or where the two disagree) it is 34 against 19. On a plain sample of 14 other commits both get 13.
- **Over-ranking is mostly gone.** Of the 30 labelled commits that needed no design step or only a screen tweak, the original ranked 16 as "new screen" or "design-system change". The port ranks 5. Each of those 16 would have started a mock, and 9 of them a human style decision.
- **No under-ranking of big changes.** The original ranked 5 real design-system changes as screen tweaks (for example a global font switch and new theme settings). The port ranks all 19 correctly.
- **Pages found:** taxonomy 14 of 14 (original 0), skateshop 36 of 36 (original 0).
- **Drift test:** the fidelity lint now fails all three checks on both a no-`src/` and a `src/` repo. The original passed all three on the no-`src/` repo and missed the unknown import on both.
- **What the port still gets wrong:** code edits to shared building blocks that don't change how they look (a prop removed, a class written in its shorter form, an export style change). Only a before/after screenshot can tell those apart. It also can't tell a moved route that has changed content from a new page.

## Repos and commits

| repo | kind | commits run |
|---|---|---|
| shadcn-admin (`e16c87f`) | Vite + TanStack Router, `src/` | last 80 non-merge on `main` |
| taxonomy (`298a885`) | Next.js app router, no `src/` | whole `main` history, 117 non-merge commits with a parent |
| skateshop (`e954d54`) | Next.js app router, `src/` | last 80 non-merge on `main` |

The local `drift` branches were used only for the drift test.

To rerun it: `npx tsx docs/design-eval/eval.ts <evalDir> <originalToolsDir>`. The script runs the original `pick-tier.mjs` with the context from its own `design-inventory.mjs`, the same way the earlier back-test did. It also runs the port with no settings (everything auto-detected).

## How the labels were made

There are 56 commits in `labels.csv`: 26 from taxonomy and 30 from skateshop. Each was labelled by reading its diff, not its message. They fall into two groups:
- **upper (42):** every commit where the original or the port said "new screen" or "design-system change", or where the two disagreed. This is where mistakes cost the most.
- **sample (14):** 7 per repo, taken at a fixed step from the commits where both tools agreed on "no UI" or "screen tweak".

So the set leans towards hard cases on purpose. Accuracy over all commits would be higher for both tools.

Labelling rules (what design work the change would really have needed):
- **no UI:** nothing a user sees changes. This covers config, server code, docs, and edits to UI files that change no output (import moves, type fixes, renames, metadata-only `head` files).
- **screen tweak:** a visible change to existing screens. For example copy, layout, a restyled card, a responsive fix, a route rename, a new small component inside an existing screen.
- **new screen:** a new page a user can visit, or a new dialog, drawer or form flow.
- **design-system change:** the shared look changes. For example theme tokens, fonts, Tailwind theme settings (colours, fonts, container, animations), or a building block that is new or changes how it looks.

When a commit does several of these, the biggest one counts.

## Accuracy

| set | original | port |
|---|---|---|
| all 56 | 32 | 47 |
| taxonomy (26) | 14 | 21 |
| skateshop (30) | 18 | 26 |
| upper (42) | 19 | 34 |
| sample (14) | 13 | 13 |

Confusion, original (rows = label, columns = what the tool said):

| label \ tool | no UI | screen tweak | new screen | design-system |
|---|---|---|---|---|
| no UI (12) | 6 | 1 | 1 | 4 |
| screen tweak (18) | 0 | 7 | 6 | 5 |
| new screen (7) | 0 | 0 | 6 | 1 |
| design-system (19) | 0 | 5 | 1 | 13 |

Confusion, port:

| label \ tool | no UI | screen tweak | new screen | design-system |
|---|---|---|---|---|
| no UI (12) | 7 | 3 | 0 | 2 |
| screen tweak (18) | 0 | 15 | 1 | 2 |
| new screen (7) | 0 | 0 | 6 | 1 |
| design-system (19) | 0 | 0 | 0 | 19 |

### Where the original went wrong, and what fixed it

- **Helper and metadata files counted as new pages:** `head.tsx`, a new `layout.tsx` in a renamed route folder, `pages/api/og.tsx`, `_components/*`. Fixed: only `page.tsx` (and the pages router's page files, minus `api` and `_app`/`_document`) count as pages.
- **Navigation edits counted as design-system changes:** any edit to `header.tsx`, `nav.tsx` or `sidebar.tsx`. The port lists them as a screen tweak with a note to check them on the card. The old rule is still there behind `--nav-raises`.
- **Deleted files counted as edits,** including the removal of an email-preview tool folder. Fixed: deleting a file is never more than a screen tweak. Email templates, tests and `public/` are not app screens.
- **Global changes missed:** `tailwind.config.*` and `theme.ts` were never checked, because the script dropped `.js`/`.ts` files before testing its theme rule. The port reads the changed lines. It finds theme settings (fonts, colours, container, animations), but not content paths or plugins.
- **globals.css:** this only counts as a design-system change when custom properties or `@theme` change. The same rule applies to any stylesheet, which also caught the code-highlight palette in `mdx.css`.

### Remaining port mistakes (9)

- **3 × a building block edited in code only** (`ui/avatar.tsx` switched to `next/image`, `ui/toast.tsx` changed its export style, `command.tsx` dropped a `className` prop). There was no visual change, but the port ranks them as design-system changes. Type-only and import-only edits are already caught (the port compiles both versions without types and compares them). These edits change the running code, so no file rule can tell. The before/after screenshot of a screen tweak is what settles it.
- **2 × canonical class rewrites** (`min-w-[8rem]` → `min-w-32`, `left-[50%]` → `left-1/2`). These look the same, but the classes differ. It's the case the research left as a design-system change. A table of equivalent classes could fix it, but I didn't build one.
- **3 × edits with no visible effect ranked as tweaks:** an auth refactor touching pages, a move of `ui/` imports, and a metadata-only `head.tsx`. A file-list rule can't see these. Being one level high here is harmless.
- **1 × route rename seen as a new page:** a page was deleted and a new one added under a new URL. Treating that as a new screen is the safe side.

## Pages found

| repo | real pages | original | port |
|---|---|---|---|
| taxonomy | 14 `page.tsx` | 0 | 14 (app router) |
| skateshop | 36 `page.tsx` | 0 | 36 (app router) |
| shadcn-admin | 6 feature entries, 25 route files | 6 | 31 (6 feature folders + 25 file routes) |

Components with a usage count above 0 on taxonomy went from 0 of 66 to 42 of 66: 12 of 36 building blocks and 30 of 30 shared components. The low building-block number is real. Taxonomy ships many shadcn components it never imports. On skateshop it is 34 of 37 building blocks and 69 of 81 shared components.

## Drift test (fidelity lint)

The change adds a new `components/ui/fancy.tsx` building block with hex colours, arbitrary values and an inline style. It also adds a page component that imports it with double quotes.

| check | taxonomy (no `src/`): original / port | skateshop (`src/`): original / port |
|---|---|---|
| tokens only | PASS (missed) / **FAIL** | FAIL / **FAIL** |
| existing components only | PASS (missed) / **FAIL** | PASS (missed) / **FAIL** |
| no new building blocks | PASS (missed) / **FAIL** | FAIL / **FAIL** |

The port also flags the inline style. It doesn't flag `h-[2.25rem]`-style values that the app's own building blocks already use. The same test runs on small fixture repos in `src/design/design.test.ts`. If the inventory finds no components at all, the lint now reports "could not check", and the gate fails instead of passing.

## Limits of this evaluation

- One person labelled the commits, and that person also wrote the port. Some labels are judgement calls, for example whether a code-highlight palette in a content stylesheet is a design-system change. A second labeller would make the numbers firmer.
- The labelled set is weighted towards hard cases, and it covers two repos by the same kind of author (open-source Next.js templates).
- The size check from a plan's file list (the mode used before any code exists) was not evaluated on real plans, because there are none yet. On these commits, the git mode reads the file contents, and the plan mode can't.
