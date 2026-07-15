# Workflow documentation inventory

This inventory records the disposition of every authored guide page for issue #312. Package documentation remains authoritative for API depth. The porter proves that every package source is either published, promoted into the workflow, or explicitly superseded.

## Authored guide pages

| Source | Classification | Navigation disposition |
|---|---|---|
| `content/overview.md` | Pyric-specific workflow help | Overview |
| `content/get-started/start-building.md` | Pyric-specific workflow help | Run locally |
| `content/get-started/how-the-swap-works.md` | Pyric-specific workflow help | Run locally |
| `content/agent/set-up-your-agent.md` | Pyric-specific workflow help | Run locally |
| `content/ship/test-in-node.md` | Pyric-specific workflow help | Run locally |
| `content/build/sign-in-and-manage-users.md` | Firebase API task with Pyric-specific local behavior | Develop with Firebase APIs |
| `content/build/store-and-query-data.md` | Firebase API task with Pyric-specific local behavior | Develop with Firebase APIs |
| `content/build/sync-realtime-data.md` | Firebase API task with Pyric-specific local behavior | Develop with Firebase APIs |
| `content/build/store-files.md` | Firebase API task with Pyric-specific local behavior | Develop with Firebase APIs |
| `content/build/receive-messages.md` | Firebase API task with Pyric-specific local delivery behavior | Develop with Firebase APIs |
| `content/build/run-ai-logic-locally.md` | Firebase API task with Pyric-specific local answer engines | Develop with Firebase APIs |
| `packages/cli/docs/how-to/run-rtdb-onvaluecreated.md` | Pyric-specific local Functions workflow | Promoted in place to Develop with Firebase APIs; existing route and source retained |
| `content/build/which-data-service.md` | Ordinary Firebase product choice | Develop with Firebase APIs, retained as a short decision page that points to Firebase product documentation |
| `content/observe/see-whats-happening.md` | Pyric-specific inspection workflow | Inspect and correct, Inspect the sandbox |
| `content/secure/read-a-denial.md` | Pyric-specific inspection workflow | Inspect and correct, Inspect the sandbox |
| `content/observe/shape-your-data.md` | Pyric-specific correction workflow | Inspect and correct, Inspect the sandbox |
| `content/agent/watch-and-review.md` | Pyric-specific inspection workflow | Inspect and correct, Inspect the sandbox |
| `content/secure/secure-it-with-rules.md` | Firebase task with Pyric-specific local behavior | Inspect and correct, Correct Security Rules |
| `content/secure/simulate-and-lint.md` | Pyric-specific correction workflow | Inspect and correct, Correct Security Rules |
| `content/secure/rules-patterns.md` | Pyric-specific rules guidance | Inspect and correct, Correct Security Rules |
| `content/secure/rules-standard-library.md` | Pyric-specific rules guidance | Inspect and correct, Correct Security Rules |
| `content/secure/rtdb-rules-in-typescript.md` | Pyric-specific rules guidance | Inspect and correct, Correct Security Rules |
| `content/secure/firestore-rules-limits.md` | Production-measured rules guidance | Inspect and correct, Correct Security Rules; replaces the rejected playful route |
| `content/secure/whats-possible.md` | Rules case studies | Inspect and correct, Correct Security Rules |
| `content/agent/what-your-agent-can-do.md` | Pyric-specific workflow help | Inspect and correct, Work with an agent |
| `content/agent/skills.md` | Pyric-specific workflow help | Inspect and correct, Work with an agent |
| `packages/cli/docs/how-to/verify-against-a-captured-session.md` | Pyric-specific boundary verification | Promoted in place to Verify the boundary; existing route and source retained |
| `content/secure/write-a-rules-test-suite.md` | Boundary verification | Verify the boundary |
| `content/secure/audit-your-rules.md` | Boundary verification | Verify the boundary |
| `content/ship/ship-to-production.md` | Pyric-specific production handoff | Ship unchanged |
| `content/ship/set-up-the-project.md` | Ordinary Firebase production setup | Ship unchanged, reduced to the Pyric boundary and links to official Firebase guidance |
| `content/trust/how-we-know-it-matches-firebase.md` | Conformance explanation | Conformance |
| `content/trust/whats-experimental.md` | Conformance limitation | Conformance |

## Generated and package-owned documentation

| Material | Classification | Disposition |
|---|---|---|
| Product `COMPAT.md` files and `conformance/SCORES.md` | Conformance evidence | Remain generated, itemized under Conformance, and linked from the authored explanation |
| TypeDoc API pages | Generated reference | Remain generated and searchable; never enter the primary workflow navigation |
| Package tutorials, how-to pages, explanations, and hand-authored references | Product-specific depth | Remain built and searchable beneath Reference unless promoted or superseded explicitly |
| `@pyric/ui` component pages | Generated implementation reference for component consumers | Remain beneath Reference; not used to teach the Pyric workflow |

## Obsolete navigation concepts

The following groupings are superseded: Get started, Build, Secure & debug, Observe & shape, Ship & test, Work with an agent, and Trust. Their pages remain useful, but their former taxonomy does not describe the local-to-production lifecycle.

No route changes are required for this reclassification. The final heading pass in #313 may rename a route only when the benefit justifies complete inbound-link handling.
