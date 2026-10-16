# Workstreams

Pick by expected yield. Each names its technique, its referee, and what a finding
looks like. One hunter per workstream; they share no state.

## 1. Contract sweep — highest yield, no credentials

**Technique.** For every public entry point, list what its types and docs say it
accepts. For each accepted input, ask: is it read, does it change the output, and
is there a test that mentions it? Feed a value through and diff the output with
and without it.

**Referee.** pyric's documented contract (JSDoc, docs pages, exported types).

**Finds.** Fields parsed and dropped; builders that coerce bad arguments
(`undefined`, `{}`, `NaN`, empty strings) into something valid-looking; options
honored on one surface but not its siblings; deploy checks the CLI runs and the
library or MCP surface skips.

**Also demand** an unknown-field policy: plain JavaScript callers get no excess
property check, so a typo is silently ignored unless the runtime throws.

## 2. Simulator vs production — highest assurance

**Technique.** Grammar-guided fuzzing (well-typed expressions over `auth`,
path variables, `data`, `newData`, `root`, `now`, string methods, mixed-type
`==`, `null` operands, precedence, runtime errors inside `||` and `&&`), each
paired with random data and auth. Structural fuzzing (cascades, `.validate` on
delete, wildcard vs literal siblings, multi-path updates). Deploy-acceptance
fuzzing (random rule documents sent through the dry-run or test endpoint).

**Referee.** Production, through existing observations first, a new capture when
none covers the case.

**Finds.** JavaScript semantics where production errors (coercion, `.length` on
non-strings, `null` index, division by zero); rules production refuses to deploy
that the simulator evaluates anyway; claims missing from simulated auth.

**Output.** Shrink each disagreement to a minimal case and write it as a corpus
scenario.

## 3. Metamorphic and internal differential — no credentials

**Technique.** Meaning-preserving rewrites must not change any decision:
`===`↔`==`, `!==`↔`!(==)`, joined vs chained `child()`, De Morgan, commuted
operands, reordered keys. Round trips (DSL → JSON → compile → serialize) are
stable and deterministic. Engines agree: simulator ≡ sandbox ≡ replay on the same
case. Monotonicity: adding a grant never turns ALLOW into DENY; adding a
`.validate` never turns DENY into ALLOW.

**Referee.** pyric against itself. When two surfaces disagree, find which one is
right before calling either a bug (documented contract or production); otherwise
report "surfaces disagree" and say which fact is unknown.

**Finds.** Priority, increment and normalization handled differently by the
sandbox and `simulate()`; DSL output that differs from its own JSON form.

## 4. Property fuzzing of DSL, compiler and parser

**Technique.** Random constraint trees: compiling never crashes or hangs; the
output passes pyric's own deploy check or compilation fails with an error; output
does not depend on declaration order. Malformed and adversarial expressions give
a clean parse error, never a crash, a hang, or catastrophic regex backtracking.

**Referee.** pyric's own invariants, and production's deploy check for anything
that compiles.

**Finds.** Lost parentheses (a regex character class containing `/` broke one
builder's precedence detection and let a signed-out write through); uncaught
exceptions from escape handling; exponential `matches()` patterns.

## 5. Security lint soundness

**Technique.** A corpus of known-vulnerable patterns (public write, cascade
over-grant, delete skipping `.validate`, unvalidated unknown keys, auth-free
conditional writes): each security finding must fire. Then the reverse: triage
false positives on pyric's own stdlib and corpus. Test constant folding against
production (`true || X` folds; `X || true` does not absorb a runtime error on the
left).

**Referee.** The lint's documented intent; production for anything about
evaluation.

**Finds.** A finding silenced by an unrelated `.validate: true`; tautologies like
`1 == 1` not treated as constants.

## 6. Coverage and mutation

**Technique.** Build the grammar × observation matrix. Run mutation testing over
the engine source; read survivors. List features with zero observations.

**Referee.** Measurement. A survivor is a lead, not a finding, until a repro shows
a wrong answer on a public surface.

**Finds.** Untested surfaces (trace, coverage merging, explain) whose answers turn
out wrong. Check that a finding is reachable through a public entry point before
filing it; an internal helper misused only by a hypothetical caller is a note,
not a bug.

## 7. Sandbox enforcement

**Technique.** Exercise the sandbox SDK surfaces where rules gate access:
transactions, listeners across auth and data changes, onDisconnect, priority,
increment, the admin handle. Both planes: the in-page sandbox and the served
worker (`packages/cli/src/serve/`).

**Referee.** Production observations under `observations/rtdb-modular/` and
`observations/firestore/`.

**Finds.** A transaction handing an unreadable value to the update function; a
listener that survives a write revoking its `.read`; an admin handle that does not
bypass rules on every operation.
