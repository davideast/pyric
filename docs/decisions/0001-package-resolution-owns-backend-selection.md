# ADR-001: Package resolution owns backend selection

Status: accepted

## Context

Pyric mirrors Firebase package entry points so unchanged application imports can
run against a sandbox. Two backend-selection mechanisms grew together:

1. Vite/import-map and Node loader hooks swapped `firebase/*` and
   `firebase-admin/*` imports to Pyric mirrors.
2. The mirrors themselves carried sandbox and production targets, delegating
   production operations back to Firebase.

The second mechanism duplicated the first, made every operation route at
runtime, and forced the browser bundler and Node loader to exempt or stub
Firebase imports originating inside the mirrors.

## Decision

Package resolution is the only production-versus-sandbox seam.

- Normal execution resolves `firebase/*` and `firebase-admin/*` to Firebase.
- Pyric-activated execution resolves those imports to `pyric/*` and
  `pyric-admin/*` sandbox mirrors.
- A mirror never delegates back to its production counterpart.
- Production observations remain the conformance answer key, but production
  SDKs are not mirror runtime dependencies.
- Direct Pyric imports are sandbox-only. Sandbox-specific helpers may extend
  the mirrored surface, but production factories and target discriminators do
  not.

## Consequences

- Delete production targets and per-operation dispatch from each mirror.
- Delete the inert Firebase browser stubs and Node mirror exemptions after
  their final internal import disappears.
- Keep production builds unchanged by leaving the package-swap layer inactive.
- Treat the removal of direct Pyric production factories as an intentional
  alpha contract correction with no compatibility shim.
- Ratchet compiled mirror bindings so a new production dependency fails CI.

## Verification

The public test seams are canonical Firebase imports through the browser and
Node resolution layers, public sandbox behavior, and packed-package isolation.
Conformance tests compare sandbox results with frozen production observations;
they never prove fidelity by delegating the operation under test to Firebase.
