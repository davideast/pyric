## 2026-08-31T20:33:44Z

You are Worker 1 responsible for implementing Pyric Security Rules Soundness Parity (Requirements R1 through R5).
Your working directory is: /Users/deast/repos/davideast/pyric/.agents/worker_1

MANDATORY FIRST STEP: Read /Users/deast/repos/davideast/pyric/ORIGINAL_REQUEST.md before starting work.
Also read /Users/deast/repos/davideast/pyric/PROJECT.md and the three survey reports:
- /Users/deast/repos/davideast/pyric/.agents/explorer_survey_1/report.md (R1 & R4)
- /Users/deast/repos/davideast/pyric/.agents/explorer_survey_2/report.md (R2 & R3)
- /Users/deast/repos/davideast/pyric/.agents/explorer_survey_3/report.md (R5 & Test Infra)

MANDATORY INTEGRITY WARNING:
DO NOT CHEAT. All implementations must be genuine. DO NOT hardcode test results, create dummy/facade implementations, or circumvent the intended task. A teamwork_preview_auditor will independently verify your work. Integrity violations WILL be detected and your work WILL be rejected.

Skill to load:
/google/src/files/head/depot/google3/research/omega/teamwork/playbooks/software_engineering/SKILL.md

Exclusive File Write Ownership:
- `packages/pyric/src/rules/simulator/evaluator.ts`
- `packages/pyric/src/rules/simulator/eval-error.ts`
- `packages/pyric/src/storage/sandbox/rules-evaluator.ts`
- `packages/pyric/src/rules/rtdb/grammar/simulator.ts`
- `packages/pyric/src/rules/rtdb/simulation/handler.ts`
- `packages/pyric/src/database/sandbox/write-plane.ts`
- `packages/pyric/src/rules/simulator/document-lookups.ts`
- `packages/pyric/src/rules/simulator/evaluation-builtins.ts`
- `packages/pyric/src/database/sandbox/rules-eval.ts`
- `packages/pyric/src/database/sandbox-controls.ts`
- `packages/pyric/src/storage/enforce.ts`
- Associated test files and regression test suites.

Detailed Requirements to Implement:
1. R1. Strict Rules Unary Type Enforcement
2. R2. Non-Truncating DataSnapshot Path Resolution
3. R3. Exhaustive Multi-Path RTDB Validation on Deletions
4. R4. Document Path Canonicalization & Root Clamping
5. R5. Closed-by-Default Unconfigured Sandboxes
6. Regression Tests & Verification
