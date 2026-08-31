# Briefing

## 🔒 My Identity
- Agent: Explorer 2 (`explorer_survey_2`)
- Role: explorer, read-only investigator
- Mission: Investigate Realtime Database (RTDB) rules simulator soundness for Pyric, specifically requirements R2 (Non-Truncating DataSnapshot Path Resolution) and R3 (Exhaustive Multi-Path RTDB Validation on Deletions).

## 🔒 Key Constraints
- Read-only investigation: do NOT edit, modify, or create any source code, test, or data files in the codebase.
- Write only to `.agents/explorer_survey_2/`.
- Produce evidence-based findings with exact file paths, line numbers, code snippets, root causes of false allows, and concrete remediation recommendations.
- Final outputs: `report.md` and `handoff.md`, followed by `send_message` to parent orchestrator.

## Current Mission
Investigate R2 and R3:
- R2: DataSnapshot child() and parent() navigation, virtual path truncation, chained .parent() behavior.
- R3: Multi-location write/update simulation, .validate schema rule collection/evaluation, subtree deletion bypassing sibling validation.

## Investigation State
- Explored paths:
  - `packages/pyric/src/rules/rtdb/grammar/simulator.ts` (DataSnapshot, evaluation engine)
  - `packages/pyric/src/rules/rtdb/simulation/handler.ts` (findFailingValidate, projectPostWriteTree, SimulateHandler)
  - `packages/pyric/src/rules/rtdb/simulation/spec.ts` (SimulationInputSchema, SimulateResult)
  - `packages/pyric/src/rules/rtdb/compiled-rules.ts` (compileRtdbRules, simulateRtdbRules)
  - `packages/pyric/src/database/sandbox/rules-eval.ts` (RulesEvaluator)
  - `packages/pyric/src/database/sandbox/write-plane.ts` (WritePlane.update, validateUpdate)
  - `packages/pyric/src/database/operations.ts` (update, remove, set)
  - `packages/pyric/test/rules/rtdb/grammar/simulator.test.ts`
  - `packages/pyric/test/rules/rtdb/simulation/handler.test.ts`
- Key findings:
  - R2: `DataSnapshot.child` breaks early at line 125 (`break;`) on missing/primitive nodes, dropping trailing path segments. `parent()` on line 145 re-invokes buggy `child()`. On missing paths, `data.child('a/b/c').parent().exists()` truncates to `/a` then collapses to `/` and returns `rootSnap.exists() === true` (false allow).
  - R3: Subtree deletions bypass sibling `.validate` schema rules because `findFailingValidate` only descends single `pathToWrite`, skips siblings at line 104, immediately aborts at line 79 on `!newData.exists()`, and only enumerates `snapshotChildKeys(newData)` at line 117 ignoring pre-write deleted keys. `WritePlane.update` lines 244/255 also fails to pass `updates` for shallow updates and evaluates only explicitly listed paths.
- Unexplored areas: none within R2 and R3 scope.

## Key Decisions
- Documented exact line numbers, reproducible proof-of-concept commands, root causes, and clean remediation algorithms for both R2 and R3.
- Ready to author final `report.md` and `handoff.md`.

## Progress Summary
- Empirical proof of both vulnerabilities confirmed via bun evaluation.
- Writing comprehensive report and handoff report.
