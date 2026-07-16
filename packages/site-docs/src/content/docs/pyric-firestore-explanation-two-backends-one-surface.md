---
title: "Why package resolution owns backend selection"
navLabel: "Two backends, one surface"
group: "pyric / firestore"
section: "Explanation"
order: 11015
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

## The package boundary now carries the invariant

`pyric/firestore` has only sandbox targets. Its compiled artifact has no
`firebase/firestore` dependency. Direct calls accept a `Sandbox`, a
`SandboxContext`, or a privately-associated `FirebaseApp`; an app produced by
the unswapped Firebase package is rejected.

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
