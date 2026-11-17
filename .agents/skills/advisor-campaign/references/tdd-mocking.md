# When and how to mock

Mock at **external system boundaries** only:

- external CLI or HTTP boundaries in CI scripts (for example, `gh` or `git`
  process invocations);
- wall-clock time or randomness when deterministic ordering is under test;
- temporary filesystem directories at CLI boundaries.

Never mock:

- this repository's own packages, sandboxes, parsers, or rules evaluators;
- internal collaborators within a surface;
- anything deterministic that can run directly in-process.

## Designing clean boundary seams

### 1. Pass boundary I/O explicitly

Accept a narrow boundary object rather than hardcoding child-process or network
calls deep inside decision logic:

```ts
// Easy to test deterministically without touching GitHub
export function reconcileVerdicts(io: VerdictIo, prNumber: number): Decision {
  const pull = fetchPull(io, prNumber);
  return evaluateVerdicts(pull);
}
```

Keep pure decision rules in pure functions that take plain data structures, and
keep thin I/O adapters at the outer edge (`merge-queue.ts` vs
`merge-queue-github.ts`, `campaign-verdicts.ts`).

### 2. Prefer operation-specific adapters over catch-all mocks

When an adapter wraps multiple external operations, expose typed methods per
operation rather than forcing every test to parse raw URL strings unless the CLI
invocation format itself is the contract being verified:

```ts
// GOOD: Each boundary operation has an explicit contract
interface IssueTracker {
  listOpenByPrefix: (prefix: string) => IssueSummary[];
  createIssue: (title: string, bodyFile: string) => string;
  addLabel: (issueNumber: number, label: string) => void;
}
```

When the exact `gh` or `git` argument vector IS part of the contract (such as
token routing or `gh api` endpoint paths), also include one subprocess test using
a minimal fake executable in a temporary `PATH` directory so the real CLI
entrypoint is exercised end-to-end.
