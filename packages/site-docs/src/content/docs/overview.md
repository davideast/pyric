---
title: "Firebase that runs in your browser"
navLabel: "Overview"
group: "Overview"
section: ""
order: 1
description: "Understand what Pyric is and what you get, in one short read."
---

# Firebase that runs in your browser

Pyric is Firestore, Auth, Realtime Database, Storage, and the Security Rules engine, implemented in TypeScript and running inside your app. In the browser, that means the page itself. The whole backend executes in the tab. In Node, it is the process your tests run in. Your code keeps its ordinary `firebase/*` imports. During development they resolve to Pyric. In production they resolve to Firebase. Nothing in your source changes.

That is the whole trick, and it starts with one command.
```bash
npm i -g pyric-tools
pyric dev
```
No account. No cloud project. No emulator, no Java, no port to babysit. You have a full Firebase stack before your coffee is warm, and it behaves like the real one because that claim is tested, not assumed. Pyric runs probes against production Firebase, records what actually happens, and replays every recorded behavior against itself in CI. When it diverges from Firebase, that is a documented row or a bug, never a surprise.

## Build the app, prove the rules, ship the same code

You build your app. Sign users in with the auth calls you already know. Write documents, run queries, keep the UI live with snapshots. Write security rules and find out, before you deploy, exactly what they allow and deny, because every operation in Pyric produces a verdict you can read, and a denial tells you which rule said no and what data it saw.

Then you ship. The same code goes to production against real Firebase. Your rules leave development already exercised against your app's real behavior. Your composite indexes come from your actual queries instead of a hand-kept file. And before anything goes live, you can replay a captured session against the new rules and learn which operations would change verdict, before production learns it for you.

## Your agent works the same backend

The backend is local state with a tool surface, so a coding agent can work on it the way you do. Point Claude Code, Cursor, or any MCP client at the sandbox and the agent can seed data, run queries, simulate a rules verdict before writing, and check its own work. Nothing it does leaves your machine. Everything it does is inspectable, live, in the same event stream you watch.

## It focuses on the hard parts

Firebase development has hard parts, and they are not the parts the manuals dwell on. Rules that pass locally and fail in production. A denial with no explanation. Query shapes that quietly demand indexes. Limits that are real but written down nowhere.

Pyric was built by working those parts until they gave, and what was learned is in the product. The rules linter carries the exact limits of the production compiler. The standard library ships rule modules verified against the real engine, including rate limiting and cross-document checks that most rulesets never attempt. The event stream exists because a bare `permission-denied` is not an answer. None of this asks for your trust. Run it, break a rule on purpose, and read the verdict.

## Where to go next

Start with [the quickstart](../start-building/). If you came here for rules, go straight to [prove your rules protect the app](../secure-it-with-rules/).
