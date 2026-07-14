# 0002: Complete the Auth backend split as a mechanical follow-up

Status: Accepted follow-up for the app-registry/SharedWorker PR

Date: 2026-07-13

## Finding

`packages/pyric/src/auth/sandbox-backend.ts` remains above the repository's
600-line structural trigger. The conventions call for an `auth/sandbox/`
facade plus one file per backend concept.

## Decision for this PR

Do not combine the full mechanical split with the app-registry lifecycle
behavior change. This PR extracts the new project-lifetime concept into
`auth/sandbox/project-store.ts`; app-local sessions, provider delegation, and
listener teardown remain independently owned and covered by multi-app tests.
The previously reported first-app ownership problem is therefore fixed rather
than deferred.

The remaining file split changes no public behavior. It is explicitly accepted
as structural follow-up because the merge-readiness goal forbids unrelated
refactoring and the migration policy requires mechanical moves to be reviewed
separately from behavior changes.

## Follow-up boundary

Before the next Auth behavior climb:

1. Characterize the existing backend families without weakening current tests.
2. Move them mechanically under `auth/sandbox/`, with `backend.ts` as the
   lifecycle-owning facade.
3. Keep `pyric/auth` exports and behavior unchanged.
4. Run the complete Auth, app-registry, conformance, and package entry-path
   suites before and after the move.

This exception covers only the structural split. Any correctness, isolation,
or lifecycle defect remains blocking for this PR.
