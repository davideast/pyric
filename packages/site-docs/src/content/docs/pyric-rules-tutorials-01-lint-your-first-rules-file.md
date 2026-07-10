---
title: "Lint your first rules file"
group: "pyric / rules"
section: "Tutorials"
order: 93
---
# Lint your first rules file

In this tutorial you will install `pyric/rules`, write a small rules file with a deliberate problem in it, and use the linter to find that problem. By the end you will have seen the parse → lint cycle end-to-end, and you will know what a `LintWarning` looks like in practice.

This tutorial assumes you have Node.js 18+ or Bun 1.x available. No Firebase project is required — everything runs in-process.

## What you will build

A standalone script that prints lint warnings for a small Firestore rules file. We will deliberately introduce one structural problem and one security problem so the linter has something interesting to report.

## Step 1 — Set up a working folder

Create a new folder and a `package.json`. We will use Bun, but the steps are identical with npm.
```bash
mkdir rules-lint-tutorial
cd rules-lint-tutorial
bun init -y
```
Add `pyric/rules`:
```bash
bun add pyric/rules
```
You now have a working project. Let's write a rules file.

## Step 2 — Write a rules file with a problem

Create a file called `firestore.rules` next to your `package.json` and paste the following:
```rules
rules_version = '2';
service cloud.firestore {
  match /databases/{db}/documents {

    // A notes collection where any signed-in user can read,
    // but only the owner can write.
    match /notes/{noteId} {
      allow read: if request.auth != null;
      allow write: if request.auth.uid == resource.data.ownerId;
    }

    // A wide-open admin panel — looks innocent but isn't.
    match /admin/{document=**} {
      allow read, write: if true;
    }
  }
}
```
Two things are about to happen when we lint this file:

1. The `admin/{document=**}` block has `if true` on a write rule. The linter is going to flag that as a `RECURSIVE_WILDCARD_OPEN` error.
2. Everything else is fine, so you will also see the file's metrics — function count, allow-rule count, source size, and so on.

## Step 3 — Run the linter

Create a file called `lint.ts`:
```ts
import { readFileSync } from 'node:fs';
import { lintFirestoreRules } from 'pyric/rules';

const source = readFileSync('./firestore.rules', 'utf-8');
const result = lintFirestoreRules(source);

if (result.parseError) {
  console.error('Rules failed to parse:', result.parseError.message);
  process.exit(1);
}

console.log('Metrics:', result.metrics);
console.log(`Found ${result.warnings.length} warning(s):`);
for (const w of result.warnings) {
  console.log(`  [${w.severity}] ${w.rule}: ${w.message}`);
  if (w.fix) console.log(`     fix: ${w.fix}`);
}
```
Run it:
```bash
bun run lint.ts
```
You will see output similar to this:
```
Metrics: {
  sourceSize: 322,
  functionCount: 0,
  allowRuleCount: 3,
  maxChainDepth: 0,
  maxChainOp: '',
  maxLetBindings: 0,
  maxLetBindingsFunction: '',
  maxCallDepth: 0,
  maxEstimatedExpressions: 0,
  getCallCount: 0
}
Found 1 warning(s):
  [error] RECURSIVE_WILDCARD_OPEN: Recursive wildcard match (/admin/{document=**}) with an always-true predicate exposes every document under this prefix. This is the Firebase open-rules anti-pattern — never ship it.
     fix: Either narrow the match path to specific collections, or replace `if true` with a real predicate (auth identity, ownership, role).
```
Notice three things:

- The linter found the open-rule. It distinguishes `RECURSIVE_WILDCARD_OPEN` (recursive wildcard plus `if true`) from `PERMISSIVE_RULE` (any write rule whose predicate folds to constant `true`). This precision lets you fix the right thing.
- The severity is `error`, not `warning`. In Pyric the deploy path refuses to swap a ruleset with linter errors, so this warning would actually block a bad deploy.
- The `notes/{noteId}` rules pass silently. The linter only emits warnings — clean files produce an empty `warnings` array.

## Step 4 — Fix the rule and re-lint

Edit `firestore.rules` and replace the admin block with something narrower:
```rules
    match /admin/{document=**} {
      allow read, write: if request.auth.token.role == 'admin';
    }
```
Run `bun run lint.ts` again. The error disappears:
```
Found 0 warning(s):
```
You have now seen the full lint cycle. The linter accepted a clean file, rejected a dangerous one, and pointed at a specific fix.

## Step 5 — Introduce a parse error on purpose

Edit the same file and change `allow read, write: if request.auth.token.role == 'admin';` to:
```rules
      allow read, write: if request.auth?.token?.role === 'admin';
```
That is JavaScript syntax — Firestore Rules has no `?.` and no `===`. Re-run the linter:
```
Found 2 warning(s):
  [warning] INVALID_OPERATOR: Found JS-style `===` in source — Firestore Rules uses `==` for equality.
  [warning] INVALID_OPERATOR: Found JS-style `?.` in source — Firestore Rules has no optional chaining.
Rules failed to parse: ...
```
The pre-parse syntax-hint checks fire even when the file does not parse. This means a typo gets a precise diagnostic instead of a generic "expected `)` got `?`" message from the grammar.

Revert the file to the working version when you're done.

## What you have learned

- `lintFirestoreRules(source)` returns a `LintResult` with `warnings`, `metrics`, and optionally `parseError`.
- Warnings carry a `rule` code, a `severity` (`'warning' | 'error'`), a human message, and an optional `fix`.
- Errors block deploys; warnings are advisory.
- Pre-parse syntax hints fire even when the file is unparseable, giving precise diagnostics on JS-style typos.

## What to do next

You have rules and you have lint feedback. The next thing most people want is to verify the rules behave the way they think — without deploying. That is what the [Write a test suite for your rules](../pyric-rules-tutorials-02-write-a-test-suite-for-your-rules/) tutorial covers.
