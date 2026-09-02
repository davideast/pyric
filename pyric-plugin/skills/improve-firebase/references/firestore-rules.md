# Firestore Rules Audit

Answer three questions about a ruleset, with evidence:

1. Who can do what? (access analysis)
2. Do the expressions work in their operation context? (semantic validity)
3. Do the match blocks compose safely? (structural analysis)

## Steps

1. **Read the source and artifact.** Read `firestore.modules.rules`,
   `firestore.rules`, the Firestore block in `firebase.json`, and
   [rules-standard-library.md](rules-standard-library.md). Confirm the modular
   file is the authored source, the plain version 2 file is generated, and
   `firebase.json` points at `firestore.rules`.

2. **Inspect the Standard Library.** Query the installed Firestore-compatible
   catalog before judging the document model or helper functions. Read exact
   signatures for the selected modules. Never copy module bodies.

3. **Resolve and lint.** Resolve `firestore.modules.rules` to a temporary file,
   compare it with `firestore.rules`, then run `firestore_rules.lint` on the
   generated output. Carry source/artifact drift and lint findings into the
   report.

4. **Access analysis.** For each match block, record identity × operation
   (get/list/create/update/delete) → allow/deny. Flag public writes, public
   reads on sensitive paths, and create/update/delete without an auth check.
   Complete when the access matrix has no blank cells.

5. **Semantic checks.** Verify each expression against its operation context:
   - `list` cannot rely on a single document's `resource.data` — a list query
     must be constrained so it can only return readable documents.
   - `create` reads `request.resource.data`; there is no `resource.data` yet.
   - Authorization derives from `resource.data` (what exists); the writer
     controls `request.resource.data`, so validation — not authorization —
     reads it.

   Complete when every `resource.data` / `request.resource.data` use is
   justified for its operation.

6. **Composition checks.** Any matching `allow` grants access — permissive
   wildcards override specific restrictions elsewhere. Flag recursive
   wildcards (`{doc=**}`) that bypass sibling rules, undefined function calls,
   unused functions whose names near-miss a called one, and repeated
   `get()`/`exists()` calls that multiply per-request cost. Complete when
   every wildcard's reach is stated.

7. **Prove the findings.** Back each critical/high finding with
   `firestore_rules.simulate` (vary auth context and operation) or a
   `firestore_rules.test` suite; `pyric.verify_cases` can generate
   the case list. Complete when each such finding cites a passing
   simulation/test demonstrating the problem.

8. **Report.**

   ```
   ## Firestore Rules Audit
   ### Summary
   ### Findings            (grouped critical → low, each with evidence + fix)
   ### Positive Observations
   ### Recommended Fixes
   ```

For an explicit `execute` request, edit `firestore.modules.rules`, regenerate
`firestore.rules`, review the generated semantic diff, re-lint the artifact,
then rerun the simulations or tests that exposed each finding.

## Reference — high-signal patterns

- `allow write: if true` or `allow write: if request.auth != null` on
  user-owned data — critical or high depending on path sensitivity.
- Validation absent on any user-controlled create/update — high.
- `request.auth.uid == resource.data.ownerId` on `create` — broken (no
  `resource` yet); the intent needs `request.resource.data.ownerId`
  plus a uid check.
- Role fields writable by the user they empower — privilege escalation.
