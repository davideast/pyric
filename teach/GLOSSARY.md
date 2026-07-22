# Conformance glossary

This is the vocabulary authority for Pyric's conformance system: the single
place each term below is defined, so a reviewer judging whether a claim
exceeds its evidence can point at one file. `docs/conformance/cdd.md` and the
`packages/conformance` package use these terms in exactly the senses given
here, and lean on the distinctions at the end rather than restating them.

One rule governs all of it: evidence flows in, claims flow out, and only the
registry changes claims. Every term below is a kind of evidence, a kind of
claim, or a check that holds one against the other.

## Core terms

### Observation

A frozen, version-stamped record of what real production Firebase did once,
captured by a rig and stored as JSON at
`packages/conformance/observations/<surface>/<name>.json`. The filename is the
key: it never changes once a registry row cites it. An observation is
evidence, not a claim. It states what production did, at a date, at an SDK
version, and says nothing about the mirror. Only real production is ever
captured; there is no emulator anywhere in the capture fleet, because an
emulator's behavior is only ever a claim about an emulator.

### Registry

The single source of truth for claims. Every compatibility row lives in a
`CompatibilitySurfaceRegistry` file under `packages/conformance/registry/`,
one per `COMPAT.md` document, and every generated page, report, audit, and
suite derives from those rows. The system's one rule runs through it:
evidence flows in, claims flow out, and only the registry changes claims. A
capture, a test, or a generated page never changes what is claimed; editing a
row is the only act that does.

### Row

One claim about the mirror, authored in a registry file. A row records a
status, an automation tier, the behavior it claims, the evidence behind that
behavior, and any observations it cites. It is a pointer into the evidence
tree, not evidence by itself. A row's `behavior` text may state a production
fact only where an observation vouches for it, and no row is ever stated
stronger than its evidence tier. Its status is one of five:

- `unverified` — authored but not yet checked; the honest "we have not looked".
- `conforms` — the sandbox matches production.
- `diverged-documented` — a known, written-down difference (see divergence).
- `unsupported` — a decision never to model it, with a written reason.
- `bug` — a defect, pinned by a failing probe.

### Conformance suite

The executable definition of a surface's rows: one test file whose path the
surface contract names. It holds one assertion set per row. A suite may be
born red — when the rows exist before the implementation, their assertion
sets fail on purpose, and the suite is the surface's definition of done,
written before the work.

### Assertion set

The single named block in a conformance suite that belongs to one row and
tests that row's claim. It asserts, against the sandbox, the facts the row's
`behavior` states, replaying the values of any cited observation rather than
re-deriving them by hand.

### Census

The diff between an upstream Firebase export set and what the mirror exports,
per mirror pair. It defines the shape universe: every upstream export the
surface intends to mirror becomes at least one row, and every one it does not
becomes a written disposition in the surface contract. The census sees shape,
never behavior — it knows which names exist, not what they do.
`compat:census` is a report and exits non-zero while any symbol is unmapped;
`compat:census-gate` is the gate that fails the build on a new gap.

### Divergence

A known, written-down difference between the mirror and a committed
observation. It is recorded, never hidden: the suite pins both sides —
production's value from the observation and the sandbox's actual behavior,
with a comment naming the difference, and assertions are never weakened to
pass. The row flips to `diverged-documented` and cites both. Every divergence
is classified in the row's notes as one of three kinds:

- **held** — waiting on evidence.
- **by-design** — a deliberate difference.
- **pending-fix** — an acknowledged defect, to be fixed.

For the climb lane a `diverged-documented` row counts like a conforming one:
its two-sided pin is expected to pass, and a failing pin is a regression.

### Oracle

Production Firebase, treated as the source of correct answers. A surface
consults the oracle through capture rigs, which freeze its answers as
observations. A row is `oracle-backed` when its passing assertion set replays
a cited observation, as opposed to `unit-backed`, where the row passes on a
unit test alone. `compat:oracle-check` replays each row's recorded checks
against its committed observation and fails if the two no longer agree; it
never contacts production, holding the frozen answer and the claim against
each other.

### Sandbox and mirror

The mirror is Pyric's public reimplementation of a Firebase surface. The
sandbox is that mirror running offline, with no network and no real project,
which is what a conformance suite asserts against. "Matches production" means
the sandbox reproduces a pinned observation offline.

### Gate

A check that fails the build. Gates come in two shapes: a ratchet, which lets
a number hold steady or improve but never regress, and a cliff, which has no
baseline and fails on any red at all. A report, by contrast, is
informational: it names what is missing or in flight and is read, never gated
on. The same fact often has both forms — `compat:census` is a report,
`compat:census-gate` is its gate.

## The policed distinctions

These four contrasts are what keep a claim from quietly outrunning its
evidence. Each is a pair, and the whole point is that the two sides are not
the same thing.

### Observed vs conforms

A row is **observed** when production has been consulted for it: a citation
exists, dated and version-stamped. A row **conforms** when the sandbox
matches that pinned record offline, proven by a passing assertion set. The
first is evidence in hand; the second is the mirror actually reproducing it.
A born-unverified row with a citation is observed and not yet conforming, and
says exactly that — here is what production does, and we have not yet built
the thing that matches it.

### Cited vs replayed

A row **cites** an observation when it points at it, in `oracleObservations`
or `conformanceChecks`. An assertion set **replays** an observation when it
asserts that observation's actual values against the sandbox. Citation is not
replay: citing records that production was consulted; replaying is the act of
holding the mirror to the recorded values. A cited-but-not-replayed
observation backs an observed claim; a replayed one is what lets a row
conform.

### Shape vs behavior

**Shape** is which names exist — the exports an application can import,
measured by the census as breadth. **Behavior** is what those names do when
called, measured against observations as fidelity. A surface can mirror every
export and still conform on few of them, so a full shape number sits happily
beside a low behavior number. The two are kept apart on purpose: folding them
together would inflate one with the other without changing what is true.

### Report vs gate

A **report** informs and never fails a run; a **gate** fails the build. The
climb lane holds both roles at once and keeps them from blurring: it is a
report about a climbing surface's progress and a gate only against
regression, exiting non-zero if and only if an already-conforming row breaks.
Non-blocking means its expected red never blocks a merge, and nothing more;
the regression gate inside it is real.

## Where to go next

- `docs/conformance/cdd.md` — how a new surface is built with these terms, in
  order, from first observation to graduation.
- `packages/conformance/README.md` — the map: what lives where, and how a
  claim links to its evidence.
- `packages/conformance/docs/how-to-run-the-conformance-system.md` — the
  operating manual: every command, what its output means, and how to find out
  by name what is not yet covered.
