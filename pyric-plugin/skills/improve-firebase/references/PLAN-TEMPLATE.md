# Firebase improvement plan template

Write one plan per selected finding. The executor has no conversation context and must not need Firebase judgment to infer the intended change.

```markdown
# NNN — <Imperative title>

- **Status**: TODO
- **Commit**: <git rev-parse --short HEAD>
- **Severity**: CRITICAL | HIGH | MEDIUM | LOW
- **Outcome**: Authorization & identity | Data integrity & model fit | Queries, indexes, performance & cost | Runtime behavior & side effects | Production readiness & regression safety
- **Evidence**: E0 | E1 | E2 | E3 | E4
- **Estimated scope**: <files and rough size>
- **Depends on**: <plan ids or none>

## Problem

Cite exact `path:line` locations and include the relevant current code/config. State the user-visible security, correctness, latency, quota, cost, or release-confidence impact. Include the Pyric command/tool input and decisive output; redact user data and secrets.

    // functions/src/example.ts:42 — current
    <exact excerpt>

## Target behavior

State an observable invariant before showing target code. For Security Rules, name the actor/operation/path/query/payload matrix that must ALLOW and DENY. For indexes, show the exact query shape and exact composite config expected from extraction.

    // target
    <complete target excerpt>

## Repo conventions to follow

- Imitate `<concrete path:line exemplar>` for Rules, tests, queries, or Functions.
- Preserve the repository's naming, module format, test harness, and Firebase initialization boundaries.

## Steps

1. At `<path:line>`, make one concrete edit and preserve named surrounding behavior.
2. Add the exact focused positive and negative test cases at `<test path>`.
3. Regenerate only the named artifact when required; review the semantic diff.
4. Re-run the evidence command from this plan and remove unrelated churn.

## Boundaries

- Do not deploy or mutate production.
- Do not broaden unrelated Rules, query, schema, Auth, or public API behavior.
- Do not add dependencies unless this plan explicitly justifies one.
- Keep generated files generated; change their source of truth.
- Stop if code drift invalidates the cited excerpt or evidence. Report the drift instead of improvising.

## Verification

- **Static**: `<exact Pyric lint/index command>` succeeds and the targeted diagnostic or index drift is gone.
- **Local behavior**: `<exact tool/case>` proves the intended ALLOW control and one-dimension DENY mutation, query result bound, transaction outcome, or Function side effect.
- **Journey regression**: `<exact pyric verify command/fixture>` reports no failing divergence when applicable.
- **Hosted behavior**: `<exact rules-test-api|both command>` only when required and credentials/project scope are already configured.
- **Repository checks**: `<focused tests, typecheck, lint>`.
- **Done when**: <specific evidence and observable behavior>, with unsupported Pyric surfaces explicitly listed.
```

## Planning rules

- Never paste credentials, production document values, or sensitive leaf data into a plan.
- Include exact test-case inputs, not “test another user.”
- For a Rules fix, pair every new ALLOW with an adjacent DENY mutation.
- For a query/index fix, pair generated config with the source query and its Rules-compatible identity constraints.
- For performance/cost, require a measurement: document count, listener result bound, read/write count, payload size, or captured hot-path frequency. Do not optimize from aesthetics.
- For Pyric gaps, write a verification step against Firebase rather than pretending local proof exists.
- Update `plans/README.md` with status, order, dependencies, and strongest evidence grade.
