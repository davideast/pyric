---
title: "Agent failure modes the linter catches"
navLabel: "Agent failure modes"
group: "pyric / rules"
section: "Explanation"
order: 190
---
# Agent failure modes the linter catches

Most of the linter's compilation and budget rules came from production: we hit the limit, learned the number, encoded it. A separate set of rules came from somewhere different. We watched LLM-driven agents try to write rules and fail in characteristic ways.

These rules are advisory in nature but defensive in posture. Each one exists because an agent shipped the same broken pattern more than once in our playground sessions. This page tells the stories.

## Escaping a denial with `if true`

The most common failure mode. The agent writes a rule with a careful predicate. A test case denies when the agent expected it to allow. The agent doesn't understand why, can't reproduce the rule's mental model, and replaces the predicate with `if true` to make the test pass.

The deploy ships. The collection is now publicly writable.

The linter catches this with two rules:

- **`PERMISSIVE_RULE`**: any write rule whose predicate folds to constant `true`. The fold handles boolean literals, `&&` / `||` of booleans, `!` of a boolean. It does not try to prove `1 == 1` or follow function calls; a few false negatives are acceptable, a single false positive would block a legitimate deploy.
- **`RECURSIVE_WILDCARD_OPEN`**: a match path with `{document=**}` combined with an always-true predicate. The recursive wildcard makes the open-rule especially dangerous because it overrides every specific rule beneath it. Separate from `PERMISSIVE_RULE` so the diagnostic names the specific anti-pattern.

Both are `severity: 'error'`. The deploy path refuses to swap a ruleset that contains either.

The fix isn't to relax the linter. It's to give the agent a real diagnostic for the original denial. Each `CaseResult`'s `trace` array shows exactly which rule decided; `explainCase` renders it into a readable string. If the agent learns to read that trace, the escape doesn't happen.

## Silently removing predicates

A subtler variant. The agent writes:

```rules
allow update: if request.auth.uid == resource.data.ownerId
              && status == 'open';
```

A test case fails because the test set `status` to `'closed'`. The agent doesn't update the test data. It removes the `status == 'open'` conjunct from the rule. The test passes. The deploy ships. Updates against closed records are no longer gated.

`RULES_WEAKENED` exists for this. When you pass the previously-deployed source to the linter (via the engine-internal `lintFirestoreRules` on `pyric/rules/internal`, since the public `lint` and `firestoreRules(source).lint()` take no options):

```ts
lintFirestoreRules(newSource, { previousSource: oldSource });
```

…the linter normalises every match path, finds the corresponding allow rule by op-set, extracts the top-level conjuncts of each predicate (split only on `&&`, never `||`), and reports every conjunct that existed before and is missing now.

`RULES_WEAKENED` is `warning`, not `error`. There are real reasons to delete a predicate: a refactor, a dedupe, an intentional broadening. The signal is "review this", not "refuse the deploy". A human (or a more careful agent) decides whether the removal is intentional.

## JavaScript hallucinations

LLMs trained primarily on JavaScript will write `.filter()`, `.map()`, `.toLowerCase()`, `===`, `?.`, `??` in rules sources. None of these exist in the Firestore rules DSL. They either fail to parse (with an unhelpful "expected `)`" message) or parse and then fail at runtime (silently denying every request).

The pre-parse syntax-hint pass fires on the raw source, before the parser runs, so the diagnostic is precise even when the file is unparseable:

- **`INVALID_OPERATOR`**: `===`, `!==`, `?.`, `??`, backtick template literals. Each gets a specific message naming the JS operator and the Firestore-equivalent (or absence of one).

The post-parse hallucination pass walks the AST for syntactically-valid-but-semantically-wrong calls:

- **`HALLUCINATED_METHOD`**: method calls that don't exist in the rules surface.
- **`HALLUCINATED_GLOBAL`**: references to globals the engine doesn't expose (`Math`, `JSON`, `Date`).
- **`WRONG_CONTEXT_PATH`**: `get(...)` calls whose path doesn't begin with `/databases/$(database)/documents/`.
- **`LENGTH_PROPERTY`**: `.length` access on a string or list (the rules surface uses `.size()`).
- **`INVALID_PATH_INTERPOLATION`**: match-style `{ident}` used inside a path literal where Firestore requires `$(ident)`.
- **`METHOD_MISSING_PARENS`**: an identifier in expression position that looks like a method name without parens.

Each rule produces a fix string when possible. The agent gets "you wrote `.length`, Firestore wants `.size()`" instead of a generic syntax error.

## Time-dependent flakiness

A rule reads `request.time` (a date-gated discount window, a trial-period check, an audit-log retention rule). The agent's test case doesn't pin `requestTime`, so the simulator falls back to wallclock. The test passes today, fails three months later when the rule's date threshold has rolled past wallclock. CI starts going red intermittently.

`REQUEST_TIME_NOT_PINNED` activates when `options.testCases` is passed to the linter. For each rule that transitively reads `request.time`, the linter emits one warning per test case that targets the rule and doesn't set `requestTime`. The fix is mechanical: add the ISO-8601 string. The diagnostic is precise: it names the rule, the test case, the path.

This is the only lint rule that depends on a test suite, and the dependency is opt-in (`options.testCases` defaults to undefined). Source-only calls to the internal `lintFirestoreRules(source)` (or the public `lint(source)` / `firestoreRules(source).lint()`, which never take a test suite at all) behave as they always did.

## The shape of these rules

Every rule on this page shares three properties:

- **It came from observation, not specification.** No one sat down to design `RULES_WEAKENED`; we watched it ship a regression and added the check the next day.
- **It targets the agent, not the language.** A careful human reading the source would catch most of these on review. The point is to surface them automatically.
- **It carries a precise fix.** "Your rule is wrong" is a useless diagnostic for an agent looping on the linter's output. "Replace `if true` with `request.auth.uid == resource.data.ownerId`" is something the agent can act on directly.

The list is not closed. As we watch new failure modes emerge (typically when a model architecture changes, or a new playground scenario surfaces a recurring mistake), new rules join it.
