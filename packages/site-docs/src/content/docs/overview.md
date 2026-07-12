---
title: "Pyric is Firebase, running locally"
navLabel: "Overview"
group: "Overview"
section: ""
order: 1
description: "Understand what Pyric is and what you get, in one short read."
---

# Pyric is Firebase, running locally

The `firebase/*` code, unchanged, against a backend that runs locally. In development the imports resolve to Pyric. In production they resolve to Firebase. The install line is the whole relationship:
```
npm i pyric === npm i firebase
```
Same imports, same calls, same behavior, mirrored one to one. If you know `getDoc` and `onSnapshot`, you already know this library.

Starting it costs one command and no account.
```bash
npm i -g pyric-tools
pyric dev
```
No cloud project. No emulator, no Java, no port to configure. A working backend in the first minute.

## Every write stays local

The backend runs inside the app process. In the browser, that is the tab itself. In Node, it is the process the tests run in.

So the data is local state, handled like a file:

- Seed it: `pyric dev --seed seed.json`
- Keep it across restarts: `pyric dev --persist`
- Promote lived state to a committable fixture: `pyric snapshot`
- Start over: `pyric dev --fresh`

## Every operation returns a verdict

The `firestore.rules` file is enforced from the first request, in-process. Every operation gets an answer you can read, and a denial names the rule that said no:
```
[#7] request    deny   get    notes/n1  by bob    0.2ms  Rule #0 (read,write) deny
```
You stop deploying rules to find out what they mean. Lint them, simulate requests, turn the cases into a test suite, all without a network call.

## Server code changes one line

The mirror holds in Node too:
```
npm i pyric-admin === npm i firebase-admin
```
`initializeApp({ sandbox })` points a script at the sandbox. `initializeApp({ credential })` points it at production. Bare `initializeApp()` lets the environment decide, so the file can carry zero Pyric identifiers.

## One CLI from first run to deploy

`pyric dev` is one command of several. The same CLI covers the rest of the workflow:

- `pyric init` scaffolds a web or Node app
- `pyric rules:lint` and `pyric rules:simulate` check rules in CI
- `pyric verify` replays a captured session against new rules and reports which verdicts change
- `pyric deploy rules` (or `indexes`, or `hosting`) pushes to a real Firebase project

## A coding agent gets the same backend

One flag exposes the whole backend to a coding agent over MCP:
```bash
pyric dev --bridge
```
The agent can seed data, run queries, and simulate a rules verdict before it writes, all in the same event stream Studio shows. Nothing leaves the machine. One page sets it up: [set up an agent](../set-up-an-agent/).

## Ship the same code to real Firebase

A production build resolves `firebase/*` to real Firebase with the same config. There is no graduation step.
```bash
vite build          # ships real firebase/*
pyric deploy rules  # push the ruleset you proved
```
The rules arrive already exercised against the app's real behavior, and composite indexes come from the queries the app actually runs. "Behaves like Firebase" is tested, not asserted: probes record what production actually does, and CI replays every recording on every change. Firestore, Auth, and Rules hold that bar today. Realtime Database and Storage are experimental, and [how we know it matches Firebase](../how-we-know-it-matches-firebase/) says exactly what that costs you.

## Where to go next

Start with [the quickstart](../start-building/). If you came for rules, go straight to [prove a user can access only their own data](../secure-it-with-rules/).
