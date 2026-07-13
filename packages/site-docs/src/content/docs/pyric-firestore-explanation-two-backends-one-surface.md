---
title: "Why package resolution owns backend selection"
navLabel: "Two backends, one surface"
group: "pyric / firestore"
section: "Explanation"
order: 12017
---
# Why package resolution owns backend selection

Pyric and Firebase expose the same canonical module name in different
environments. The environment chooses the package before either implementation
loads:
```text
import 'firebase/firestore'
           |
           +-- Pyric inactive --> Firebase SDK --> production
           |
           `-- Pyric active ----> pyric/firestore --> sandbox
```
This is stronger than choosing a backend inside `getFirestore`. A sandbox
module cannot accidentally acquire a production client, and a production
module does not carry dormant simulator code.

## The old internal-dispatch model

The original mirror loaded `firebase/firestore`, constructed either a sandbox
or production target, and branched inside every operation. A single package
therefore owned two implementations:
```text
pyric/firestore
  +-- target.kind === sandbox --> local engine
  `-- target.kind === prod ----> firebase/firestore
```
That arrangement had three structural problems:

1. Direct mirror imports could reach production even though the mirror was
   meant to be a sandbox.
2. Browser bundling required inert Firebase stubs to stop recursive rewrites.
3. Conformance claims could credit production forwarding rather than sandbox
   behaviour.

## The package boundary now carries the invariant

`pyric/firestore` has only sandbox targets. Its compiled artifact has no
`firebase/firestore` dependency. Direct calls accept a `Sandbox`, a
`SandboxContext`, or a sandbox `PyricApp`; a real `FirebaseApp` is rejected.

Production remains Firebase because the activation layer is absent. The Vite
plugin and Node register hook are therefore the only switch:
```text
source code
  import { getFirestore } from 'firebase/firestore'
                         |
                  package resolution
                    /           \
             Firebase SDK    Pyric mirror
              production       sandbox
```
## Why canonical imports matter

Application source should keep importing `firebase/app` and
`firebase/firestore`. That makes the environment swap explicit and testable:

- The inactive Node seam proves imports remain real Firebase.
- The active Node seam proves canonical imports complete a sandbox operation.
- The Vite seam proves the same operation through browser-oriented resolution.
- The compiled-isolation gate proves the mirror cannot silently regain a
  production dependency.

Direct `pyric/firestore` imports remain useful for sandbox-specific tests and
tools, where the sandbox owner is constructed explicitly.

## Conformance consequence

The compatibility matrix compares sandbox behaviour with frozen production
observations. Production forwarding is not evidence of simulator conformance.
Rows that discuss production describe the untouched Firebase side of the
package boundary, not a production target inside Pyric.
