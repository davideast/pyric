---
title: "How to compare two rulesets for weakening"
navLabel: "Compare rulesets"
group: "pyric / rules"
section: "How-to"
order: 12002
---
# How to compare two rulesets for weakening

When you ship a rules change, the most dangerous mistake is silently removing a security predicate to make a failing test pass. Here's how to catch that before it deploys.

`RULES_WEAKENED` needs the previously-deployed source to diff against. The public `lint(source)` and `firestoreRules(source).lint()` take no options, so this check is reached through the engine-internal `lintFirestoreRules`, imported from `pyric/rules/internal`: not part of the public contract, but the mechanism this guide relies on.

## Lint with the previous source

Pass the previously-deployed source as `options.previousSource`:
```ts
import { lintFirestoreRules } from 'pyric/rules/internal';

const result = lintFirestoreRules(newSource, { previousSource: oldSource });

const weakened = result.warnings.filter((w) => w.rule === 'RULES_WEAKENED');
for (const w of weakened) {
  console.log(`[WEAKENED] ${w.message}`);
}
```
The linter walks both rulesets, normalises every match path, and diffs the predicates conjunct-by-conjunct on each allow rule. Every conjunct that existed in `previousSource` but is missing from the current source produces one `RULES_WEAKENED` warning.

## What it detects

Three weakening shapes are surfaced:

- **Removed match block**: `match /admin/{x} { allow … }` existed before; it's gone now. Only reported if the previous block had `allow` rules. Empty parent shells disappearing is silent.
- **Removed allow rule**: same match path, but `allow update: …` was deleted.
- **Removed conjunct**: same match path and same allow op-set, but a conjunct was dropped. For example, `auth.uid == ownerId && status == 'open'` becoming just `auth.uid == ownerId`.

## What it does not detect

By design:

- **Added conjuncts**: refinement is fine.
- **Changed conjuncts**: replacing `status == 'open'` with `status in ['open', 'pending']` is treated as a removal (the old conjunct is gone) plus an addition (silent). The removal warning is the actionable signal.
- **`||` rearrangements inside a conjunct**: the linter doesn't descend into `||` sub-trees, because splitting an OR would change semantics. The entire OR is one conjunct.
- **Function-body changes**: the linter compares the predicate that appears in the `allow` statement. If you weaken a helper function used by that predicate, the predicate string is unchanged and the warning does not fire. Run the simulator to catch behavioural regressions of that shape.

## Wire it into CI

Pull the live ruleset before linting the candidate:
```bash
firebase firestore:rules:get > previous.rules
```
Then in your check script:
```ts
import { readFileSync } from 'node:fs';
import { lintFirestoreRules } from 'pyric/rules/internal';

const previousSource = readFileSync('previous.rules', 'utf-8');
const newSource = readFileSync('firestore.rules', 'utf-8');

const result = lintFirestoreRules(newSource, { previousSource });
const weakened = result.warnings.filter((w) => w.rule === 'RULES_WEAKENED');

if (weakened.length > 0) {
  console.error(`Refusing to deploy: ${weakened.length} predicate(s) removed.`);
  for (const w of weakened) console.error(`  · ${w.message}`);
  process.exit(1);
}
```
`RULES_WEAKENED` is a `warning`, not an `error`. The deploy gate stays under your control: require human ack, or treat it as a hard block as above.

## When the previous source is malformed

If `previousSource` fails to parse, the linter silently skips the diff and the rest of the lint continues. A broken prior should not block a clean candidate.

## Where to look next

- For why this check exists, see [Agent failure modes](../pyric-rules-explanation-agent-failure-modes/#silently-removing-predicates).
- For the conjunct-extraction algorithm, see [`RULES_WEAKENED` in the lint rules reference](../pyric-rules-reference-lint-rules/#rules_weakened).
