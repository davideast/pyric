# Briefing

## 🔒 My Identity
- Agent: Explorer 3
- Role: explorer, investigator
- Mission: Investigate requirement R5 (Closed-by-Default Unconfigured Sandboxes for RTDB and Storage) and monorepo build & test infrastructure for Pyric.

## 🔒 Key Constraints
- Read-only technical investigation.
- DO NOT edit, modify, or create any source code, test, or data files in the codebase outside of `.agents/explorer_survey_3/`.
- All outputs and reports must be placed in `/Users/deast/repos/davideast/pyric/.agents/explorer_survey_3/`.
- Communicate progress and results back to caller orchestrator (`b91d5b21-830a-43e7-8b69-6e9ceb0fee2d`) via `send_message`.

## Investigation State
- **Explored paths**:
  - `ORIGINAL_REQUEST.md`, `PRIORITIES.md`, `CONTEXT.md`, `package.json`
  - `packages/pyric/src/database/instances.ts`, `backend-for.ts`, `backend.ts`, `backend-state.ts`, `rules-eval.ts`, `write-plane.ts`, `sandbox-namespace.ts`, `sandbox-controls.ts`
  - `packages/pyric/src/storage/instances.ts`, `service.ts`, `enforce.ts`, `errors.ts`, `list.ts`
  - `packages/cli/src/serve/worker/serve-init.ts`, `packages/cli/test/serve/worker/serve-init.test.ts`
  - Test suites across `packages/pyric`, `packages/pyric-admin`, `packages/cli`
- **Key findings**:
  - **R5 RTDB**: Unconfigured RTDB sandbox allows by default because `RulesEvaluator.defaultPolicy` in `packages/pyric/src/database/sandbox/rules-eval.ts:102` defaults to `'allow'`. Changing line 102 to `'deny'` causes `compiled === null` to return `check: 'no-rule'`, and `WritePlane` throws `permissionDenied()` (`code === 'PERMISSION_DENIED'`). `/.info` metadata remains readable. Admin handles bypass.
  - **R5 Storage**: Unconfigured Storage sandbox allows by default because `enforceRules` in `packages/pyric/src/storage/enforce.ts:73–79` explicitly returns and emits `allow` when `!service.rules`. Replacing lines 73–79 with `throw unauthorized(...)` fails closed (`code === 'storage/unauthorized'`). Admin handles (`target.admin === true`) bypass.
  - **Monorepo & Tests**: Bun 1.3.14 workspace. `bun test --cwd packages/pyric` executes in ~15s (5,972 tests). Regression test placements and plans established for R1–R5.
- **Unexplored areas**: None. Investigation complete.
