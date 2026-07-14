# 0005: Split the SharedWorker wire schema after the app-registry PR

Status: Accepted follow-up for the app-registry/SharedWorker PR

Date: 2026-07-14

## Finding

`packages/cli/src/serve/worker/protocol.ts` is above the repository's 600-line
review threshold and contains the wire records for several service families.
The app-registry work adds lifecycle control frames to that already broad
schema. This is a documented module-boundary debt, not a behavioral failure in
the new app/session lifecycle.

## Decision for this PR

Keep one authoritative discriminated union while the deletion, disconnect,
and app-configuration frames are under review. Splitting the schema now would
mechanically touch every worker client and host family, substantially enlarging
the diff without changing the public contract or fixing a demonstrated bug.

This decision waives only the file-size/module-shape P2. It does not waive
protocol correctness, exhaustiveness, package compatibility, or any app/session
isolation finding.

## Follow-up boundary

In a dedicated mechanical PR:

1. Move each service family's message records into a leaf module.
2. Keep one central exported inbound/outbound union and shared control frames.
3. Preserve every current discriminant and serialized field byte-for-byte.
4. Add compile-time exhaustiveness checks and run the full worker, browser,
   bridge-relay, packaging, and install-matrix gates before merging.
