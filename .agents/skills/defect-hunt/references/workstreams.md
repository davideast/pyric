# Hunt angles

One hunter per angle; hunters share no state. Each angle names its technique,
its referee, and what a finding looks like. Pick by expected yield for the
surface, and retire an angle once a round on it finds nothing new.

The domain skill lists the surfaces and which angles have paid off on each
(for the rules engines, see
[rules-engine-defect-hunt](../../rules-engine-defect-hunt/SKILL.md)).

## 1. Contract sweep: highest yield, no credentials

**Technique.** For every public entry point, list what its types and docs say
it accepts. For each accepted input, ask: is it read, does it change the
output, and does a test mention it? Feed a value through and diff the output
with and without it. Feed the values a plain JavaScript caller can pass:
`undefined`, `{}`, `NaN`, `''`, a misspelled key.

**Referee.** pyric's documented contract (JSDoc, docs pages, exported types,
ADRs; see [contract-adr.md](contract-adr.md)).

**Finds.** Fields parsed and dropped; builders that coerce bad arguments into
something valid-looking; options honored on one surface and ignored on a
sibling; checks the CLI runs that the library or MCP surface skips; typos
silently ignored because no runtime rejects unknown fields.

## 2. Differential: highest assurance

**Technique.** Run the same input on pyric and on its referee and compare.
Against production: through committed observations first, a new capture when
none covers the case. Against siblings: the same operation sequence on every
plane ([differential-planes.md](differential-planes.md)), or the same case
through every surface that answers it (simulator, sandbox, replay).
Generate inputs (grammar-guided or random sequences), then shrink each
disagreement to a minimal case.

**Referee.** Production, or the planes against each other. When two pyric
surfaces disagree, find which one is right (production or contract) before
calling either a bug; otherwise report "surfaces disagree" and name the
unknown fact.

**Finds.** Host semantics where production errors; input production refuses
that pyric accepts; a plane that delivers, orders or settles differently.

**Output.** Each disagreement as a minimal scenario or fixture, ready to pin.

## 3. Metamorphic: no credentials

**Technique.** Meaning-preserving rewrites must not change any outcome:
equivalent operators, De Morgan, commuted operands, reordered keys, a joined vs
a chained path, a document vs its `toJSON()` form. Round trips (build,
serialize, parse, compile) are stable and deterministic. Monotonicity: adding a
grant never turns allow into deny; adding a constraint never turns deny into
allow.

**Referee.** pyric against itself, with the same "surfaces disagree" rule as
the differential angle.

**Finds.** Normalization done one way on one path and another way on the next;
output that depends on declaration order; a builder that loses parentheses for
one operand shape.

## 4. Fault injection

**Technique.** Break the environment at the moments the contract talks about:
drop the socket mid-operation, close it before a frame leaves, restart the
host, go silent past the heartbeat, revoke a read while a listener is open,
contend a transaction, interrupt a commit, feed pathological input (a regex
with nested repeats, a 20,000-term expression, a `1e21` count). Drive it
through the real entry point where the runtime behavior lives: a real socket,
a real process, a browser where the lifecycle matters (AGENTS.md boundary 7).

**Referee.** The written contract for the failure (for example ADR-0019's
reconnect and delivery rules, [contract-adr.md](contract-adr.md)), or
production SDK behavior under the same fault
([oracle-sdk-runtime.md](oracle-sdk-runtime.md)).

**Finds.** A listener that survives a write revoking its read; an operation
failed that the contract says is held; a call settled twice; a crash or hang
where the contract promises a clean error; exponential backtracking.

## Measuring before the hunt

Not an angle, but it points hunters at thin evidence. Build the
construct × observation matrix; run mutation testing over the surface's source
and read the survivors; list documented options no test mentions. A survivor
is a lead, not a finding, until a repro shows a wrong answer through a public
entry point. A defect only an internal caller could reach is a note, not a
finding.
