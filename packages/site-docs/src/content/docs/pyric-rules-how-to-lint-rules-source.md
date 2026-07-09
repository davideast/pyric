---
title: "How to lint a rules source"
navLabel: "Lint a rules source"
group: "pyric / rules"
section: "How-to"
order: 66
---
# How to lint a rules source

This guide shows you how to lint a Firestore rules source and act on the result.

## Lint a string
```ts
import { lintFirestoreRules } from 'pyric/rules';

const result = lintFirestoreRules(source);
```
`result.warnings` is an array of `LintWarning`. `result.metrics` is the structural summary. If the source did not parse, `result.parseError` is set and budget checks were skipped.

## Branch on parse error first

A parse error means "this isn't a ruleset yet" — different category from any lint warning. Check it before reading warnings:
```ts
const result = lintFirestoreRules(source);
if (result.parseError) {
  console.error(
    `Parse error at line ${result.parseError.line}, col ${result.parseError.column}: `
    + result.parseError.message,
  );
  process.exit(1);
}
// Safe to read result.warnings and result.metrics here.
```
Pre-parse syntax hints (JS-isms like `===`, `?.`, `??`, backtick strings) fire even when the file doesn't parse, so `result.warnings` may already contain useful entries.

## Block deploys on errors only

`warnings` mixes severities. The deploy path in `pyric-tools/deploy` refuses to swap a ruleset when any warning has `severity: 'error'`. Mirror that behaviour:
```ts
const errors = result.warnings.filter((w) => w.severity === 'error');
if (errors.length > 0) {
  for (const w of errors) console.error(`[${w.rule}] ${w.message}`);
  process.exit(1);
}
```
## Catch silent rule weakening on update

Pass the previously-deployed source as `options.previousSource`. The linter activates `RULES_WEAKENED` and emits one warning per security predicate that was removed:
```ts
const result = lintFirestoreRules(newSource, { previousSource: oldSource });
const weakened = result.warnings.filter((w) => w.rule === 'RULES_WEAKENED');
```
`RULES_WEAKENED` is a `warning`, not an `error` — there are legitimate reasons to delete a predicate (refactor, dedupe). The signal is "review this", not "block the deploy".

## Activate `REQUEST_TIME_NOT_PINNED`

If your rules read `request.time`, the simulator's verdict depends on wallclock unless every test case pins `requestTime`. Pass your test suite to surface unpinned cases:
```ts
const result = lintFirestoreRules(source, { testCases });
const unpinned = result.warnings.filter((w) => w.rule === 'REQUEST_TIME_NOT_PINNED');
```
See [Pin `request.time` for deterministic tests](../pyric-rules-how-to-pin-request-time/) for the fix.

## Inspect structural metrics

`result.metrics` gives you the at-a-glance shape of the ruleset:
```ts
const m = result.metrics;
console.log(
  `${m.allowRuleCount} rules, ${m.functionCount} functions, `
  + `max chain depth ${m.maxChainDepth} (${m.maxChainOp}), `
  + `max let bindings ${m.maxLetBindings} in ${m.maxLetBindingsFunction || 'n/a'}`,
);
```
Use these to plot trends across PRs or to assert on growth in CI.

## Where to look next

- Want the exact thresholds and detection algorithms? See [Lint rules reference](../pyric-rules-reference-lint-rules/).
- Want to know *why* these particular rules exist? See [Runtime budget and shared gates](../pyric-rules-explanation-runtime-budget-and-shared-gates/) and [Agent failure modes](../pyric-rules-explanation-agent-failure-modes/).
