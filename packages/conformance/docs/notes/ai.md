# `pyric/ai` — maintainer notes

Moved verbatim out of `packages/conformance/registry/ai.ts` (intro narrative). Not part of the site.

This surface climbed under Conformance Driven Development
(map: https://github.com/davideast/pyric/issues/92). Every row below was
born `unverified` at admission: the row universe and the red conformance
suites came first, the mirror implementation came after. All 78 rows are
now flipped: the climb lane (`bun run compat:climb-ai`, the suites at
`packages/pyric/test/ai`) passes 78 of 78 with no assertion
weakened, and every row records the tier of evidence that vouches for it.

Evidence tiers per `packages/conformance/docs/ai/cdd-deltas.md`:

- `oracle-backed` (10 rows): the suite replays value-deterministic facts
  from a cited observation (error envelopes, countTokens, byte-compared
  stream framing, the thought-signature rejection).
- `shape-backed` (23 rows): the suite replays an observation's distilled
  shape facts (key sets, enum values, streaming semantics); values are
  nondeterministic in production.
- `unit-backed` (28 rows): SDK mechanics with no vouching observation
  (dispatch, ChatSession behavior, Schema builders, response helpers).
- `sandbox-only` (17 rows): the answer-engine seam, which has no
  production analogue.

72 rows conform; 6 are documented divergences from the installed
firebase/ai 2.12.0, each with the reason pinned in its notes.

Generated-content values are never claims. Production output is
nondeterministic, so no row asserts on generated text, and the suites only
compare text when the scripted engine was explicitly scripted to return it
(the shape-backed tier ruling in `packages/conformance/docs/ai/cdd-deltas.md`).

Probe references: `unit:<file>` means a passing Bun test in
`packages/pyric/test/ai/<file>` (the climb lane). Captures live at
`packages/conformance/observations/ai/ai-*.json`; a row that cites one replays the
capture's distilled facts in the named test.
