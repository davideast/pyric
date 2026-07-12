# Docs rewrite content (step 4 drafts)

Every page of the new docs, written to WRITING-BRIEF.md against HIERARCHY.md v3. All pages carry `status: draft` frontmatter. This tree is for review; wiring it into the site generator (`packages/site-docs/scripts/port-content.ts`) is the step after the red pen.

## The map

| Nav | File | New or re-hung |
|---|---|---|
| Overview | `overview.md` | new (voice anchor) |
| **GET STARTED** | | |
| Start building | `get-started/start-building.md` | new landing over reused tutorials |
| How firebase/* imports resolve | `get-started/how-the-swap-works.md` | new |
| **BUILD** | | |
| Sign in and manage users | `build/sign-in-and-manage-users.md` | new (Auth finally gets its guide) |
| Store and query data | `build/store-and-query-data.md` | new landing over reused how-tos |
| Sync realtime data | `build/sync-realtime-data.md` | new, experimental-labeled |
| Store files | `build/store-files.md` | new, experimental-labeled |
| Which data service? | `build/which-data-service.md` | new |
| **SECURE & DEBUG** (the rules wing) | | |
| Secure it with rules | `secure/secure-it-with-rules.md` | new wing landing |
| Simulate and lint | `secure/simulate-and-lint.md` | new over reused how-tos |
| Write a rules test suite | `secure/write-a-rules-test-suite.md` | new over reused tutorial |
| Read a denial | `secure/read-a-denial.md` | new |
| The rules standard library | `secure/rules-standard-library.md` | new (from STDLIB.md) |
| Rules patterns | `secure/rules-patterns.md` | new (ported from firebase-agent-sdk skills) |
| RTDB rules in TypeScript | `secure/rtdb-rules-in-typescript.md` | new (constraints DSL) |
| The limits that actually bite | `secure/limits-that-bite.md` | new (from LINTER_SPEC + linter thresholds) |
| Audit rules and data | `secure/audit-a-ruleset.md` | new (from the audit skills) |
| What's possible | `secure/whats-possible.md` | new (the gallery) |
| **OBSERVE & SHAPE** | | |
| See what's happening | `observe/see-whats-happening.md` | new landing over reused how-tos |
| Shape your data | `observe/shape-your-data.md` | new landing over reused how-tos |
| **SHIP & TEST** | | |
| Ship to production | `ship/ship-to-production.md` | new landing over reused deploy tree |
| Set up the project | `ship/set-up-the-project.md` | new (control-plane enablement) |
| Test in Node | `ship/test-in-node.md` | new over reused harness tutorial |
| **WORK WITH AN AGENT** | | |
| Set up an agent | `agent/set-up-an-agent.md` | new (per-client recipes) |
| What an agent can do | `agent/what-an-agent-can-do.md` | new (capability-taught) |
| Skills | `agent/skills.md` | new (catalog) |
| **TRUST** | | |
| How we know it matches Firebase | `trust/how-we-know-it-matches-firebase.md` | new over conformance docs |
| **REFERENCE** | (unchanged: existing per-package reference + COMPAT) | re-hung as-is |

## What re-hanging means

The deep existing pages (the rules how-tos, the sandbox how-tos, the deploy tree, the reference trees) are not rewritten here. The new pages above are the doorways and the connective tissue; they link into the existing pages, which get re-shelved under these sections when the generator's nav plan is remapped. Prose-level voice cleanup of those older pages is a later, separate pass.

## Review guide

Read `overview.md` first; it is the voice contract in action. Then read one page per section to check the voice holds. The knowledge pages (`secure/rules-standard-library.md`, `secure/limits-that-bite.md`, `secure/rules-patterns.md`, `secure/whats-possible.md`) carry the most new claims; their facts trace to STDLIB.md, LINTER_SPEC.md, the chess log, and the firebase-agent-sdk skill references.
