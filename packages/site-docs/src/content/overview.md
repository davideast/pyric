---
title: "A local-first Firebase framework for agents"
navLabel: "Overview"
group: "Overview"
section: ""
order: 10
description: "Understand what Pyric is and what you get, in one short read."
---

# A local-first Firebase framework for agents

Pyric is a local Firebase development environment. Your code keeps its ordinary `firebase/*` imports. During development they resolve to a sandbox on your machine. In production they resolve to Firebase. Nothing in your source changes.

A coding agent works that same sandbox: seed data, run queries, simulate a rules verdict, and check its own work. Nothing it does leaves your machine. Everything it does is inspectable, live, in the same event stream you watch.

Start with a coding agent:

```bash
npx plugins add davideast/pyric
```

Or from the terminal:

```bash
npm create pyric@latest my-app
cd my-app
npm install
npm run dev
```

No account. No cloud project. Local writes cannot touch production. Pyric records comparisons with production Firebase in its conformance reference, including documented divergences, unsupported APIs, and areas that have not been verified.

## Build the app, prove the rules, ship the same code

You build your app with five service workflows: sign in and manage users, store and query data, sync realtime data, store files, and receive messages. Every local operation produces a Security Rules verdict you can inspect.

Then you ship. With the development resolver inactive, the same canonical imports load real Firebase. Before anything goes live, replay a captured session against the candidate Security Rules and learn which operations would change verdict. Pyric produces those local artifacts; `firebase-tools` or the Firebase Console deploys them.

## It focuses on the hard parts

Firebase development has hard parts, and they are not the parts the manuals dwell on. Rules that pass locally and fail in production. A denial with no explanation. Query shapes that quietly demand indexes. Limits that are real but written down nowhere.

Pyric was built by working those parts until they gave, and what was learned is in the product. The rules linter carries the exact limits of the production compiler. The standard library ships rule modules verified against the real engine, including rate limiting and cross-document checks that most rulesets never attempt. The event stream exists because a bare `permission-denied` is not an answer. None of this asks for your trust. Run it, break a rule on purpose, and read the verdict.

## Where to go next

Start with [the quickstart](./get-started/start-building.md). If you came here for an agent, go to [connect an agent](./agent/set-up-your-agent.md). If you came here for rules, go straight to [prove your rules protect the app](./secure/secure-it-with-rules.md).
