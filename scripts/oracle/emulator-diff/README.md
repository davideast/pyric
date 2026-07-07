# Emulator-diff harness — the no-secret prod oracle (T0-5 / INF-2 stopgap)

The live Rules-Test-API parity job (T0-7) needs the `PARITY_SA_BASE64` secret.
This harness is the deterministic, **no-secret** stopgap: the Firebase emulator's
rules engine is the *same evaluator as production* for expression semantics, so
diffing pyric's local simulator against it catches the whole `RULES-*` class for
free. It is the oracle the behavior tracks (esp. T3) confirm disputed semantics
against before flipping a test (plan section 2, STOP section 5.4).

## Files

- `corpus.ts` — disputed-semantics corpus. Each case = a ruleset + one request
  + the verdict production returns (`expectedProd`, cited to the ledger/clone).
  Seeded with the **RULES-B2 … RULES-B9** repros.
- `harness.ts` — runs every case through pyric's `SimulateFirestoreRulesHandler`
  AND (when reachable) the emulator, then diffs.

## Usage

```bash
# Sim vs the documented prod verdict (no emulator needed — deterministic):
bun run scripts/oracle/emulator-diff/harness.ts          # exit 1 while bugs present
bun run scripts/oracle/emulator-diff/harness.ts --json

# Pre-fix regression guard — passes while the known divergences are present,
# fails once one unexpectedly converges (a fix landed → update the corpus):
bun run scripts/oracle/emulator-diff/harness.ts --expect-known-bugs

# Sim vs a LIVE emulator (or the live Rules Test API). Point at any endpoint
# that honors the firebaserules :test contract:
bun run scripts/oracle/emulator-diff/harness.ts --oracle-url=<emulator-url>
#   env equivalents: FIRESTORE_RULES_TEST_URL, FIRESTORE_RULES_TEST_TOKEN
```

With the Firebase CLI installed the canonical local recipe is to launch the
Firestore emulator and pass its rules-test endpoint as `--oracle-url`
(`firebase emulators:exec --only firestore '<the harness command>'`). The CLI is
not bundled in CI here; the documented-oracle mode is what runs by default and is
deterministic.

## Verdict columns

- **pyric** — pyric's local simulator verdict.
- **oracle** — the emulator verdict when wired, else the documented `expectedProd`.
  `src` shows which.
- A `✗` row = pyric disagrees with the oracle (the bug is live).

## Current state (pre-fix, 2026-06-10)

7 of 8 cases diverge (RULES-B2, B4, B5, B6, B7, B8, B9). RULES-B3's headline
`error || true` example **converges** — pyric already absorbs that form — so it's
marked `expectDivergence: false` and kept as a regression anchor; T3 should probe
the narrower `false || (err)` direction against a live emulator.

## When a track fixes an evaluator bug

1. Re-run the harness; the fixed case stops showing `✗`.
2. Confirm against a live emulator (`--oracle-url`) for any disputed semantic
   before flipping a unit test (plan section 2).
3. Remove the case from the corpus, or flip its `expectDivergence` to `false`.
