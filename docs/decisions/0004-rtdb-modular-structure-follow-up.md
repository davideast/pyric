# 0004: Split the RTDB modular surface before its next behavior change

Status: Accepted follow-up for the app-registry/SharedWorker PR

Date: 2026-07-14

## Finding

`packages/pyric/src/database/modular.ts` predates the current source
conventions and remains a 1,475-line, multi-family file. This PR necessarily
touches its instance and listener paths so named app containers can own and
tear down RTDB listeners without changing the shared backend.

## Decision for this PR

Accept the remaining file-shape violation as a mechanical follow-up rather
than moving the complete RTDB surface while changing its app lifecycle. The
new listener-registry concept already lives in its own file, and focused unit,
multi-app, conformance, canonical-browser, and package-entry tests cover the
behavioral change. This exception waives only the existing source shape; it
does not waive any lifecycle, identity, rules, persistence, or API defect.

## Follow-up boundary

Before the next RTDB behavior climb:

1. Characterize the public instance, reference, read/write, query, listener,
   transaction, sentinel, and sandbox-control families.
2. Hoist shared state without changing behavior.
3. Split the families mechanically under `database/`, retaining
   `database/index.ts` as the package barrel and preserving public exports.
4. Keep the mechanical move and any later behavior change in distinct review
   units.
5. Run the complete RTDB, app-registry, persistence, conformance, browser, and
   packaging suites before and after the split.
