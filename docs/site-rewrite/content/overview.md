---
title: Firebase that runs in your browser
navLabel: Overview
outcome: Understand what Pyric is and what you get, in one short read.
status: draft
---

# Firebase that runs in your browser

Pyric runs supported Firebase application code against a local backend during development. The application keeps its ordinary `firebase/*` imports and Firebase configuration. A normal production build resolves those imports to Firebase again. The source does not branch between local development and production.

Start a new application with one command:

```bash
npx create-pyric my-app
```

Local development needs no Firebase account, cloud project, emulator, or Java runtime. The mirrored services do not connect to production. Local writes cannot delete production data or create Firebase usage charges, and local rules changes do not deploy.

## Follow the application from local development to production

The documentation follows one workflow:

1. **Run locally.** Start the sandbox and connect the application, tests, or coding agent.
2. **Develop with Firebase APIs.** Keep writing normal Auth, Firestore, Realtime Database, Storage, Messaging, and AI Logic code.
3. **Inspect and correct.** Read local operations and rules verdicts, then adjust application code, data, or Security Rules.
4. **Verify the boundary.** Replay captured behavior and test candidate rules before production.
5. **Ship unchanged.** Build with real Firebase and deploy through `firebase-tools` or the Firebase Console.

Development moves back and forth between writing Firebase code and inspecting what happened. The boundary check comes after that loop, before the production build.

Conformance sits underneath the workflow as separate evidence. It records which Pyric behaviors have been compared with production Firebase, which differ, and which remain unsupported or unverified.

## Your agent works the same backend

The backend is local state with a tool surface, so a coding agent can work on it the way you do. Point Claude Code, Cursor, or any MCP client at the sandbox and the agent can seed data, run queries, simulate a rules verdict before writing, and check its own work. Nothing it does leaves your machine. Everything it does is inspectable, live, in the same event stream you watch.

## It focuses on the hard parts

Firebase development has hard parts, and they are not the parts the manuals dwell on. Rules that pass locally and fail in production. A denial with no explanation. Query shapes that quietly demand indexes. Limits that are real but written down nowhere.

Pyric was built by working those parts until they gave, and what was learned is in the product. The rules linter carries the exact limits of the production compiler. The standard library ships rule modules verified against the real engine, including rate limiting and cross-document checks that most rulesets never attempt. The event stream exists because a bare `permission-denied` is not an answer. None of this asks for your trust. Run it, break a rule on purpose, and read the verdict.

## Where to go next

Start with [Run Firebase locally](./get-started/start-building.md). The [conformance explanation](./trust/how-we-know-it-matches-firebase.md) documents the evidence and its limits.
