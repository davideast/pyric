---
title: "How to lint a rules source"
navLabel: "Lint a rules source"
group: "pyric / rules"
section: "How-to"
order: 13004
---
# How to lint a rules source

Lint a Firestore rules source, read the result, and gate a deploy on it. Everything here runs in-process.

## Lint a string

```ts
import { lint } from 'pyric/rules';

const issues = lint(source);
```

`issues` is a `RuleIssue[]`. Each issue carries `origin`: `'parse'` for a compile blocker, `'validate'` for a structural/security finding, `'lint'` for a budget/quality/hallucination warning. `lint` never throws, even on empty or unparseable source.

## Branch on parse errors first

A parse error means "this isn't a ruleset yet", a different category from any lint or validation finding. Filter on `origin === 'parse'` before acting on the rest:

```ts
const issues = lint(source);
const parseErrors = issues.filter((i) => i.origin === 'parse');
if (parseErrors.length > 0) {
  for (const e of parseErrors) {
    console.error(`Line ${e.line ?? '?'}: ${e.message}`);
  }
  process.exit(1);
}
// Safe to treat the rest of `issues` as validate/lint findings.
```

Pre-parse syntax hints (JS-isms like `===`, `?.`, `??`, backtick strings) fire even when the file doesn't parse, so `issues` may already contain useful entries before the parse-error check.

## Block deploys on errors only

`issues` mixes severities. The deploy path in `pyric-tools/deploy` refuses to swap a ruleset when any issue has `severity: 'error'`. Mirror that behaviour:

```ts
const errors = issues.filter((i) => i.severity === 'error');
if (errors.length > 0) {
  for (const e of errors) console.error(`[${e.code}] ${e.message}`);
  process.exit(1);
}
```

## Catch silent rule weakening on update, and pin `request.time`

Two lint rules, `RULES_WEAKENED` and `REQUEST_TIME_NOT_PINNED`, need extra input beyond a bare source string: the previously-deployed source, and your test suite, respectively. Neither `lint(source)` nor `firestoreRules(source).lint()` takes options, so both checks are reached through the engine-internal `lintFirestoreRules(source, options)`, imported from `pyric/rules/internal`:

```ts
import { lintFirestoreRules } from 'pyric/rules/internal';

const result = lintFirestoreRules(newSource, {
  previousSource: oldSource,
  testCases,
});

const weakened = result.warnings.filter((w) => w.rule === 'RULES_WEAKENED');
const unpinned = result.warnings.filter((w) => w.rule === 'REQUEST_TIME_NOT_PINNED');
```

`RULES_WEAKENED` is a `warning`, not an `error`. There are legitimate reasons to delete a predicate (refactor, dedupe). The signal is "review this", not "block the deploy". See [How to compare two rulesets for weakening](../pyric-rules-how-to-compare-rulesets-for-weakening/) and [Pin `request.time` for deterministic tests](../pyric-rules-how-to-pin-request-time/).

## Inspect structural metrics

The internal `lintFirestoreRules` result also carries `metrics`, the structural summary. `lint(source)` has no equivalent on the public surface:

```ts
import { lintFirestoreRules } from 'pyric/rules/internal';

const result = lintFirestoreRules(source);
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
