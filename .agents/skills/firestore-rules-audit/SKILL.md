---
name: firestore-rules-audit
description: Audit Firestore security rules for public access, semantic errors, unsafe match-block composition, and missing validation. Use when the user asks to review firestore.rules, check rules for vulnerabilities, or explain why a rule allows/denies an operation.
---

# Firestore Rules Audit

Answer three questions about a ruleset, with evidence:

1. Who can do what? (access analysis)
2. Do the expressions work in their operation context? (semantic validity)
3. Do the match blocks compose safely? (structural analysis)

## Steps

1. **Read the ruleset.** Use the project's `firestore.rules`, or
   `firestore_rules.get` for deployed state. Complete when you can list every
   match block and the operations each allows.

2. **Lint.** Run `firestore_rules.lint`. Complete when every lint finding is
   either carried into the report or explained away.

3. **Access analysis.** For each match block, record identity × operation
   (get/list/create/update/delete) → allow/deny. Flag public writes, public
   reads on sensitive paths, and create/update/delete without an auth check.
   Complete when the access matrix has no blank cells.

4. **Semantic checks.** Verify each expression against its operation context:
   - `list` cannot rely on a single document's `resource.data` — a list query
     must be constrained so it can only return readable documents.
   - `create` reads `request.resource.data`; there is no `resource.data` yet.
   - Authorization derives from `resource.data` (what exists); the writer
     controls `request.resource.data`, so validation — not authorization —
     reads it.

   Complete when every `resource.data` / `request.resource.data` use is
   justified for its operation.

5. **Composition checks.** Any matching `allow` grants access — permissive
   wildcards override specific restrictions elsewhere. Flag recursive
   wildcards (`{doc=**}`) that bypass sibling rules, undefined function calls,
   unused functions whose names near-miss a called one, and repeated
   `get()`/`exists()` calls that multiply per-request cost. Complete when
   every wildcard's reach is stated.

6. **Prove the findings.** Back each critical/high finding with
   `firestore_rules.simulate` (vary auth context and operation) or a
   `firestore_rules.test` suite on the Rules Test API (needs project
   credentials); `pyric.verify_cases` derives the case list from a captured
   session fixture, and `pyric.verify` replays the whole fixture against
   candidate rules. Complete when each such finding cites a passing
   simulation/test demonstrating the problem.

7. **Report.**

   ```
   ## Firestore Rules Audit
   ### Summary
   ### Findings            (grouped critical → low, each with evidence + fix)
   ### Positive Observations
   ### Recommended Fixes
   ```

If the user asks for remediation: change the rules, re-lint, then re-run the
simulations or tests that exposed each finding and confirm they now deny.

## Reference — high-signal patterns

- `allow write: if true` or `allow write: if request.auth != null` on
  user-owned data — critical or high depending on path sensitivity.
- Validation absent on any user-controlled create/update — high.
- `request.auth.uid == resource.data.ownerId` on `create` — broken (no
  `resource` yet); the intent needs `request.resource.data.ownerId`
  plus a uid check.
- Role fields writable by the user they empower — privilege escalation.
