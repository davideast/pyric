# Functions RTDB first-slice inventory

Status: admitted under Conformance Driven Development; production behavior captured, local replay red.

## Contract source

- Upstream entry: `firebase-functions/v2/database`
- Upstream SDK: `firebase-functions` 7.2.5
- Admitted factory: `onValueCreated(ref | ReferenceOptions, handler)`
- Product seam: unchanged exported production function source, from an RTDB
  commit through awaited handler completion and an Admin write made via
  `event.data.ref`
- Pyric ownership: local execution and bridge transport only. There is no
  `pyric-functions` mirror and no Functions MCP surface.

## First slice

- Node only
- `onValueCreated` only
- one local RTDB instance
- exact paths and named single-segment wildcards
- serialized handler execution within the current development session, without
  a cross-event arrival-order guarantee
- `event.params`, `event.data`, and Admin-capable `event.data.ref`
- unchanged CommonJS production source using the real Functions SDK

## Captured production facts

1. Exact absent-to-present creation delivers once.
2. Updates and deletes do not deliver.
3. Existing data is not replayed when a trigger starts.
4. Named wildcard parameters are populated.
5. An ancestor object creation fans out to matching descendants.
6. A matching descendant is projected from an ancestor write.
7. A multi-path update produces the matching create events.
8. `DataSnapshot` value, key, existence, child, enumeration, and JSON shape.
9. `event.data.ref` is an Admin reference and its returned Promise is usable.
10. `authType` and `authId` carry the writer context.
11. A returned Promise keeps the execution open until it settles.
12. A thrown/rejected handler is reported by the managed runtime; the
    retry-disabled Eventarc request's acknowledgement status is captured
    separately.
13. Delivery order for sequential creates is observed, not assumed.

## Explicit exclusions

- `onValueWritten`, `onValueUpdated`, and `onValueDeleted`
- Firestore, Auth, Storage, HTTPS, callable, scheduled, and task functions
- retries and deployed concurrency semantics
- more than one RTDB instance
- durable delivery or replay across Pyric restarts
- deployment, secrets, configuration parameters, and production lifecycle
- a general Cloud Functions emulator or package mirror
