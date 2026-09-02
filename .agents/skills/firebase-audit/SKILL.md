---
name: firebase-audit
description: Audit a Firebase project's security and data posture — who can access what, what rules/data/auth exist, and where they disagree. Use when the user asks for a Firebase audit, a security review of rules and data, or "find the gaps" across Firestore/RTDB/Auth.
---

# Firebase Audit

Produce an evidence-based, severity-ranked report answering three questions:

1. Who can access what?
2. What rules, data, and auth configuration exist?
3. Where do rules, data shape, and identities disagree?

Stay read-only. Propose remediation in the report; apply changes only when the
user asks.

## Steps

1. **Collect rules.** Read `firestore.rules` and `database.rules.json` from the
   project — these are the rules the sandbox loaded. For Firestore,
   `sandbox.inspect` reports the same rules from the connected sandbox; it
   does not report Realtime Database rules, so read `database.rules.json`
   directly for those. Complete when every service in scope has a ruleset in
   hand (or a finding that none exists — that is itself critical).

2. **Collect data shape.** Map real paths with `firestore_discover_paths` and
   `firestore_data.list`; for RTDB use `database_data.crawl`. Complete
   when each top-level collection/path has a known shape and sample.

3. **Collect auth posture.** List the identities the sandbox holds with
   `auth_users.list`. Note which identities the rules assume (anonymous,
   signed-in, owner, custom claims) and whether the enabled providers can
   actually produce them. Complete when every `request.auth` assumption in the
   rules maps to a real provider or a finding.

4. **Cross-reference.** For each data path, pair it with the rule that governs
   it and the identity that reaches it. Flag:
   - data paths with no meaningful rule (default-open or root grants)
   - rules matching paths where no data exists (dead rules)
   - user-writable paths without validation
   - claimed auth boundaries with no identity able to exercise them

   Complete when every path appears in exactly one of: protected, flagged, or
   dead-rule.

5. **Verify the sharp findings.** Prove each critical/high finding with
   `firestore_rules.lint`, `firestore_rules.simulate` (vary the auth context:
   signed-out, owner, other user, claim-holder), `firestore_rules.test` (Rules
   Test API, needs project credentials), `pyric.verify` (replay a captured
   session against the candidate rules), or `database_rules.simulate`.
   Complete when every critical/high finding cites a simulation, test, or lint
   result, not just a reading of the rules.

6. **Report by severity.**

   ```
   ## Firebase Audit
   ### Summary
   ### Critical Findings    (public/root writes, auth bypasses)
   ### High Findings        (missing validation, broad reads on sensitive paths)
   ### Medium Findings      (dead rules, shape drift)
   ### Low Findings         (style, structure)
   ### Positive Observations
   ### Recommended Next Steps
   ```

   Complete when each finding names its evidence and its fix.

## Severity anchors

- Critical: unauthenticated write, root-level grant, or rule logic an attacker
  controls (authorization read from `request.resource.data`).
- High: user-controlled writes without validation; sensitive reads open to any
  signed-in user.
- Medium: rules and data shape disagree but no direct exposure.
- Low: naming, duplication, unused functions.

## Scope honesty

State in the summary exactly which evidence backs the audit (rules files,
discovered paths, simulations run). Traffic and denial history are visible in
the Pyric Playground today but not yet exposed to external agents through the
pyric tool surface — when live-traffic evidence would change a finding, say so
rather than inferring it.
