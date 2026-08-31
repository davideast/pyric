# Context — Pyric Security Rules Soundness Parity

## Technical Environment
- Monorepo using Bun: `bun test`
- Workspace root: `/Users/deast/repos/davideast/pyric`
- Rules engines:
  - Firestore security rules (CEL-like expression evaluator)
  - Cloud Storage security rules (shares or resembles Firestore expression evaluator)
  - RTDB rules simulator (tree-based `.read`, `.write`, `.validate` rules, `DataSnapshot` navigation)
- Relevant files and packages to be mapped during Phase 0 Survey.
