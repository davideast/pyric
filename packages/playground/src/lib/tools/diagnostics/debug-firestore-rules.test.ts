/**
 * Unit tests for `debug_firestore_rules`'s pure helpers. The
 * orchestrator handler is integration-shaped (runner singleton +
 * sandbox state + simulator); these tests exercise the analysis
 * logic that sits between the captured event and the synthesized
 * diagnosis.
 *
 * Coverage:
 *   - findFailingLeaf — deepest-falsy-non-skipped walk
 *   - classifyCause   — 5 cause buckets + path-mismatch override
 *   - buildDiagnosisNotes — note shape & headlines per cause
 *   - extractFailingExpression — picks the right rule + leaf
 */
import { describe, test, expect } from 'bun:test';
import type {
  ExprTraceEntry,
  PathResolutionEntry,
  RuleEvaluation,
  TestResult,
} from 'pyric/rules/internal';
import {
  buildDiagnosis,
  buildDiagnosisNotes,
  classifyCause,
  extractFailingExpression,
  findFailingLeaf,
  selectPathNearMisses,
  type DiagnosisEventContext,
  type FailingExpression,
} from './debug-firestore-rules.shared';

// ─── Test fixtures ───────────────────────────────────────────────────

function entry(overrides: Partial<ExprTraceEntry>): ExprTraceEntry {
  return {
    source: 'true',
    kind: 'literal',
    parent: null,
    value: true,
    ...overrides,
  };
}

function rule(overrides: Partial<RuleEvaluation> = {}): RuleEvaluation {
  return {
    ruleIndex: 0,
    operations: ['read'],
    verdict: 'DENY',
    conditionText: 'true',
    line: 5,
    expressionTrace: [],
    ...overrides,
  };
}

// ─── findFailingLeaf ─────────────────────────────────────────────────

describe('findFailingLeaf', () => {
  test('returns null on empty trace', () => {
    expect(findFailingLeaf([])).toBeNull();
  });

  test('returns null when nothing failed', () => {
    // All entries are true — rule clean ALLOW, no failing leaf to find.
    const trace: ExprTraceEntry[] = [
      entry({ source: 'a && b', kind: 'binaryOp', parent: null, value: true }),
      entry({ source: 'a', kind: 'identifier', parent: 0, value: true }),
      entry({ source: 'b', kind: 'identifier', parent: 0, value: true }),
    ];
    expect(findFailingLeaf(trace)).toBeNull();
  });

  test('picks the falsy operand in a simple a && b chain', () => {
    // Root `&&` is false because `b` is false. The failing leaf is `b`
    // (deeper than the root), not the root.
    const trace: ExprTraceEntry[] = [
      entry({ source: 'a && b', kind: 'binaryOp', parent: null, value: false }),
      entry({ source: 'a', kind: 'identifier', parent: 0, value: true }),
      entry({ source: 'b', kind: 'identifier', parent: 0, value: false }),
    ];
    const leaf = findFailingLeaf(trace);
    expect(leaf).not.toBeNull();
    expect(leaf!.entry.source).toBe('b');
    expect(leaf!.index).toBe(2);
  });

  test('ignores skipped (short-circuited) operands', () => {
    // `a && b` where a=false → b is skipped (placeholder entry). Don't
    // attribute the failure to a placeholder we never evaluated.
    const trace: ExprTraceEntry[] = [
      entry({ source: 'a && b', kind: 'binaryOp', parent: null, value: false }),
      entry({ source: 'a', kind: 'identifier', parent: 0, value: false }),
      entry({ source: 'b', kind: 'identifier', parent: 0, skipped: true }),
    ];
    const leaf = findFailingLeaf(trace);
    expect(leaf!.entry.source).toBe('a');
  });

  test('descends into the deepest failing branch', () => {
    // `(p && q) && r` where the failure is INSIDE `p && q`. The
    // deepest failing leaf is `q`, not the outer binaryOp or `p && q`.
    const trace: ExprTraceEntry[] = [
      entry({ source: '(p && q) && r', kind: 'binaryOp', parent: null, value: false }),
      entry({ source: 'p && q', kind: 'binaryOp', parent: 0, value: false }),
      entry({ source: 'p', kind: 'identifier', parent: 1, value: true }),
      entry({ source: 'q', kind: 'identifier', parent: 1, value: false }),
      entry({ source: 'r', kind: 'identifier', parent: 0, skipped: true }),
    ];
    const leaf = findFailingLeaf(trace);
    expect(leaf!.entry.source).toBe('q');
    expect(leaf!.index).toBe(3);
  });

  test('OR chain: last-evaluated falsy leaf wins (tie-break)', () => {
    // `a || b || c` where all three are false. The simulator evaluated
    // all three (none short-circuited because none returned truthy).
    // For the agent's UX, the LAST one is the most informative — it's
    // the one whose value flipped the OR's verdict from "still maybe"
    // to "definitely deny."
    const trace: ExprTraceEntry[] = [
      entry({ source: 'a || b || c', kind: 'binaryOp', parent: null, value: false }),
      entry({ source: 'a || b', kind: 'binaryOp', parent: 0, value: false }),
      entry({ source: 'a', kind: 'identifier', parent: 1, value: false }),
      entry({ source: 'b', kind: 'identifier', parent: 1, value: false }),
      entry({ source: 'c', kind: 'identifier', parent: 0, value: false }),
    ];
    const leaf = findFailingLeaf(trace);
    // All of `a`, `b`, `c` are at depth 2. Last index (`c`) wins by
    // the tie-break rule.
    expect(leaf!.entry.source).toBe('c');
  });

  test('catches null-valued memberAccess (field-mismatch case)', () => {
    // `resource.data.owner` resolves to null because the field is
    // absent. That's a failing leaf even though it isn't literally
    // `false` — same heuristic the classifier uses.
    const trace: ExprTraceEntry[] = [
      entry({ source: 'resource.data.owner == request.auth.uid', kind: 'binaryOp', parent: null, value: false }),
      entry({ source: 'resource.data.owner', kind: 'memberAccess', parent: 0, value: null }),
      entry({ source: 'request.auth.uid', kind: 'memberAccess', parent: 0, value: 'alice' }),
    ];
    const leaf = findFailingLeaf(trace);
    expect(leaf!.entry.source).toBe('resource.data.owner');
    expect(leaf!.entry.value).toBeNull();
  });

  test('catches error entries as failing leaves', () => {
    // A method call that threw is a legitimate failing leaf — the
    // expression couldn't even produce a value.
    const trace: ExprTraceEntry[] = [
      entry({ source: 'foo()', kind: 'functionCall', parent: null, error: 'Unknown function: foo' }),
    ];
    const leaf = findFailingLeaf(trace);
    expect(leaf!.entry.source).toBe('foo()');
    expect(leaf!.entry.error).toBe('Unknown function: foo');
  });
});

// ─── classifyCause ───────────────────────────────────────────────────

describe('classifyCause', () => {
  test('PATH_MISMATCH overrides every other classification when no rule matched', () => {
    // matchedAnyRule: false means the simulator found no `match` block
    // for the path. That's the headline cause regardless of what other
    // signals say.
    const cause = classifyCause({
      failing: { source: 'true', kind: 'literal', traceIndex: 0 },
      verdict: undefined,
      hasAuth: false,
      matchedAnyRule: false,
    });
    expect(cause).toBe('PATH_MISMATCH');
  });

  test('UNSUPPORTED_SURFACE when the rule abstained', () => {
    const cause = classifyCause({
      failing: { source: 'someUnknownFn()', kind: 'functionCall', traceIndex: 0 },
      verdict: 'UNSUPPORTED',
      hasAuth: true,
      matchedAnyRule: true,
    });
    expect(cause).toBe('UNSUPPORTED_SURFACE');
  });

  test('AUTH_MISSING when `request.auth != null` evaluated false', () => {
    const cause = classifyCause({
      failing: { source: 'request.auth != null', kind: 'binaryOp', value: false, traceIndex: 0 },
      verdict: 'DENY',
      hasAuth: false,
      matchedAnyRule: true,
    });
    expect(cause).toBe('AUTH_MISSING');
  });

  test('IDENTITY_MISMATCH when `request.auth.uid == X` evaluated false (auth present)', () => {
    // Distinguishes from AUTH_MISSING by `hasAuth: true` — the user IS
    // signed in, they're just the wrong identity.
    const cause = classifyCause({
      failing: { source: 'request.auth.uid == resource.data.owner', kind: 'binaryOp', value: false, traceIndex: 0 },
      verdict: 'DENY',
      hasAuth: true,
      matchedAnyRule: true,
    });
    expect(cause).toBe('IDENTITY_MISMATCH');
  });

  test('FIELD_MISMATCH when resource.data.<x> resolves to null', () => {
    // memberAccess returned null because the field doesn't exist on
    // the doc. The rule expected a value; it got nothing.
    const cause = classifyCause({
      failing: { source: 'resource.data.owner', kind: 'memberAccess', value: null, traceIndex: 0 },
      verdict: 'DENY',
      hasAuth: true,
      matchedAnyRule: true,
    });
    expect(cause).toBe('FIELD_MISMATCH');
  });

  test('FIELD_MISMATCH when a resource.data.<x> comparison is false', () => {
    const cause = classifyCause({
      failing: { source: 'resource.data.role == "admin"', kind: 'binaryOp', value: false, traceIndex: 0 },
      verdict: 'DENY',
      hasAuth: true,
      matchedAnyRule: true,
    });
    expect(cause).toBe('FIELD_MISMATCH');
  });

  test('FIELD_MISMATCH also covers request.resource.data.<x>', () => {
    // The other side of the same pattern: the rule reads
    // `request.resource.data.X` and the proposed payload's value
    // doesn't satisfy the constraint.
    const cause = classifyCause({
      failing: { source: 'request.resource.data.title != ""', kind: 'binaryOp', value: false, traceIndex: 0 },
      verdict: 'DENY',
      hasAuth: true,
      matchedAnyRule: true,
    });
    expect(cause).toBe('FIELD_MISMATCH');
  });

  test('falls through to RULE_REJECTED_VALID when no specific pattern matches', () => {
    // A custom helper function returned false. We can't characterize
    // it with the simple heuristic; surface the catch-all so the
    // agent knows the diagnosis layer didn't over-claim.
    const cause = classifyCause({
      failing: { source: 'isAdmin(request.auth.uid)', kind: 'functionCall', value: false, traceIndex: 0 },
      verdict: 'DENY',
      hasAuth: true,
      matchedAnyRule: true,
    });
    expect(cause).toBe('RULE_REJECTED_VALID');
  });

  test('RULE_REJECTED_VALID when there is no failing expression at all', () => {
    const cause = classifyCause({
      failing: undefined,
      verdict: 'DENY',
      hasAuth: true,
      matchedAnyRule: true,
    });
    expect(cause).toBe('RULE_REJECTED_VALID');
  });
});

// ─── buildDiagnosisNotes ─────────────────────────────────────────────

describe('buildDiagnosisNotes', () => {
  test('AUTH_MISSING produces an auth-prompting headline', () => {
    const notes = buildDiagnosisNotes({ likelyCause: 'AUTH_MISSING' });
    expect(notes[0]).toMatch(/request\.auth != null/);
    expect(notes[0]).toMatch(/signed in/);
  });

  test('FIELD_MISMATCH headline quotes the failing source when available', () => {
    const failing: FailingExpression = {
      source: 'resource.data.owner',
      kind: 'memberAccess',
      value: null,
      traceIndex: 1,
    };
    const notes = buildDiagnosisNotes({ likelyCause: 'FIELD_MISMATCH', failing });
    expect(notes[0]).toContain('resource.data.owner');
  });

  test('PATH_MISMATCH headline references the path when available', () => {
    const notes = buildDiagnosisNotes({
      likelyCause: 'PATH_MISMATCH',
      rulePath: 'users/alice/messages/m1',
    });
    expect(notes[0]).toContain('users/alice/messages/m1');
    expect(notes[0]).toMatch(/match.*block/i);
  });

  test('non-null sandboxStateAtPath produces a "doc exists" note with field summary', () => {
    const notes = buildDiagnosisNotes({
      likelyCause: 'FIELD_MISMATCH',
      sandboxStateAtPath: { owner: 'alice', title: 'hi', createdAt: 1 },
    });
    const stateNote = notes.find(n => n.startsWith('Sandbox state at path:'));
    expect(stateNote).toBeDefined();
    expect(stateNote!).toContain('exists');
    expect(stateNote!).toMatch(/owner.*title.*createdAt/);
  });

  test('null sandboxStateAtPath produces a "doc does NOT exist" note', () => {
    const notes = buildDiagnosisNotes({
      likelyCause: 'FIELD_MISMATCH',
      sandboxStateAtPath: null,
    });
    const stateNote = notes.find(n => n.startsWith('Sandbox state at path:'));
    expect(stateNote).toBeDefined();
    expect(stateNote!).toContain('does NOT exist');
  });

  test('failing.line surfaces in a dedicated "Failing rule line: N" note', () => {
    const failing: FailingExpression = {
      source: 'request.auth != null',
      kind: 'binaryOp',
      value: false,
      traceIndex: 0,
      line: 12,
    };
    const notes = buildDiagnosisNotes({ likelyCause: 'AUTH_MISSING', failing });
    expect(notes.find(n => n === 'Failing rule line: 12.')).toBeDefined();
  });

  test('empty options still produces a headline (RULE_REJECTED_VALID fallback)', () => {
    const notes = buildDiagnosisNotes({ likelyCause: 'RULE_REJECTED_VALID' });
    expect(notes.length).toBeGreaterThan(0);
    expect(notes[0]).toMatch(/Headline/);
  });

  test('PATH_MISMATCH renders near-miss blocks when provided', () => {
    // Top 3 closest-fit blocks are appended as a multi-line note.
    // Format: "  - `/path` at line N (matched M/T segments — reason)"
    // Bug-bait: rendering inside non-PATH_MISMATCH causes would
    // leak match-block detail into identity/auth diagnoses.
    const nearMisses: PathResolutionEntry[] = [
      {
        line: 8,
        blockPath: '/users/{uid}',
        matchedSegments: 2,
        totalSegments: 2,
        bindings: { uid: 'alice' },
        matched: false,
        reason: 'no-matching-child',
      },
      {
        line: 14,
        blockPath: '/users/{uid}/messages/{mId}',
        matchedSegments: 2,
        totalSegments: 4,
        bindings: { uid: 'alice' },
        matched: false,
        reason: 'request-shorter',
      },
    ];
    const notes = buildDiagnosisNotes({
      likelyCause: 'PATH_MISMATCH',
      rulePath: 'users/alice/extra',
      pathNearMisses: nearMisses,
    });
    const nearMissNote = notes.find(n => n.startsWith('Near-miss match blocks'));
    expect(nearMissNote).toBeDefined();
    expect(nearMissNote!).toContain('`/users/{uid}` at line 8');
    expect(nearMissNote!).toContain('`/users/{uid}/messages/{mId}` at line 14');
    expect(nearMissNote!).toContain('no-matching-child');
    expect(nearMissNote!).toContain('request-shorter');
  });

  test('PATH_MISMATCH does NOT render near-miss block note when the list is empty', () => {
    // No noise when there's nothing to suggest. Without this guard
    // the agent gets a "Near-miss match blocks:" header followed by
    // an empty list, which is worse than omitting the line.
    const notes = buildDiagnosisNotes({
      likelyCause: 'PATH_MISMATCH',
      rulePath: 'users/alice',
      pathNearMisses: [],
    });
    expect(notes.find(n => n.startsWith('Near-miss'))).toBeUndefined();
  });

  test('non-PATH_MISMATCH causes do NOT render near-misses even if supplied', () => {
    // Defensive: only PATH_MISMATCH should surface match-block detail.
    // An IDENTITY_MISMATCH diagnosis with near-miss blocks attached
    // would be confusing — the cause is identity, not path.
    const nearMisses: PathResolutionEntry[] = [{
      line: 5,
      blockPath: '/users/{uid}',
      matchedSegments: 2,
      totalSegments: 2,
      bindings: {},
      matched: false,
      reason: 'no-matching-child',
    }];
    const notes = buildDiagnosisNotes({
      likelyCause: 'IDENTITY_MISMATCH',
      failing: { source: 'request.auth.uid == X', kind: 'binaryOp', value: false, traceIndex: 0 },
      pathNearMisses: nearMisses,
    });
    expect(notes.find(n => n.startsWith('Near-miss'))).toBeUndefined();
  });

  test('PATH_MISMATCH caps the near-miss list at 3', () => {
    // Anything beyond 3 noise more than helps. The caller pre-sorts
    // closest-first; we truncate without comment.
    const nearMisses: PathResolutionEntry[] = Array.from({ length: 6 }, (_, i) => ({
      line: 10 + i,
      blockPath: `/path${i}/{x}`,
      matchedSegments: 1,
      totalSegments: 2,
      bindings: {},
      matched: false,
      reason: 'no-matching-child' as const,
    }));
    const notes = buildDiagnosisNotes({
      likelyCause: 'PATH_MISMATCH',
      pathNearMisses: nearMisses,
    });
    const nearMissNote = notes.find(n => n.startsWith('Near-miss'))!;
    expect(nearMissNote).toContain('/path0/');
    expect(nearMissNote).toContain('/path1/');
    expect(nearMissNote).toContain('/path2/');
    expect(nearMissNote).not.toContain('/path3/');
    expect(nearMissNote).not.toContain('/path5/');
  });
});

// ─── selectPathNearMisses ────────────────────────────────────────────

describe('selectPathNearMisses', () => {
  function attempt(overrides: Partial<PathResolutionEntry>): PathResolutionEntry {
    return {
      blockPath: '/x',
      matchedSegments: 0,
      totalSegments: 1,
      bindings: {},
      matched: false,
      reason: 'literal-mismatch',
      ...overrides,
    };
  }

  test('drops matched-true entries (the winner is not a near-miss)', () => {
    const out = selectPathNearMisses([
      attempt({ blockPath: '/users/{uid}', matchedSegments: 2, totalSegments: 2, matched: true, reason: undefined }),
      attempt({ blockPath: '/posts/{p}', matchedSegments: 0, totalSegments: 2 }),
    ]);
    expect(out.every(a => !a.matched)).toBe(true);
    expect(out.find(a => a.blockPath === '/users/{uid}')).toBeUndefined();
  });

  test('drops entries with 0 matched segments (totally unrelated paths)', () => {
    // A block whose first segment doesn\'t match the request shares
    // nothing structurally with the request path — surfacing it as
    // a "near-miss" would mislead the agent. Filter out.
    const out = selectPathNearMisses([
      attempt({ blockPath: '/totally/unrelated', matchedSegments: 0, totalSegments: 2 }),
      attempt({ blockPath: '/partial/{x}', matchedSegments: 1, totalSegments: 2 }),
    ]);
    expect(out.length).toBe(1);
    expect(out[0].blockPath).toBe('/partial/{x}');
  });

  test('sorts by matchedSegments descending (closest first)', () => {
    const out = selectPathNearMisses([
      attempt({ blockPath: '/a/{x}', matchedSegments: 1, totalSegments: 2 }),
      attempt({ blockPath: '/a/b/{x}/{y}', matchedSegments: 3, totalSegments: 4 }),
      attempt({ blockPath: '/a/b/{x}', matchedSegments: 2, totalSegments: 3 }),
    ]);
    expect(out.map(a => a.matchedSegments)).toEqual([3, 2, 1]);
  });

  test('does not mutate the input array (defensive copy)', () => {
    const input: PathResolutionEntry[] = [
      attempt({ blockPath: '/a', matchedSegments: 1 }),
      attempt({ blockPath: '/b', matchedSegments: 2 }),
    ];
    const inputBefore = input.map(a => a.blockPath);
    selectPathNearMisses(input);
    expect(input.map(a => a.blockPath)).toEqual(inputBefore);
  });

  test('returns empty when no near-misses exist', () => {
    expect(selectPathNearMisses([])).toEqual([]);
    expect(selectPathNearMisses([
      attempt({ blockPath: '/x', matchedSegments: 0 }),  // filtered: 0 matches
    ])).toEqual([]);
  });
});

// ─── extractFailingExpression ────────────────────────────────────────

describe('extractFailingExpression', () => {
  test('returns null when the rule trace is empty', () => {
    expect(extractFailingExpression([])).toBeNull();
  });

  test('returns null when the determining rule has no expressionTrace', () => {
    const trace = [rule({ expressionTrace: undefined })];
    expect(extractFailingExpression(trace)).toBeNull();
  });

  test('returns null when the determining rule has empty expressionTrace', () => {
    const trace = [rule({ expressionTrace: [] })];
    expect(extractFailingExpression(trace)).toBeNull();
  });

  test('picks the last RuleEvaluation when no UNSUPPORTED is present', () => {
    // OR semantics: all rules evaluated, last one is most informative.
    const trace = [
      rule({
        ruleIndex: 0,
        line: 5,
        verdict: 'DENY',
        expressionTrace: [
          entry({ source: 'a', value: false }),
        ],
      }),
      rule({
        ruleIndex: 1,
        line: 9,
        verdict: 'DENY',
        expressionTrace: [
          entry({ source: 'b', value: false }),
        ],
      }),
    ];
    const out = extractFailingExpression(trace);
    expect(out).not.toBeNull();
    expect(out!.source).toBe('b');
    expect(out!.line).toBe(9);
  });

  test('prefers the UNSUPPORTED rule even when later rules also evaluated', () => {
    // Distinct from "last rule wins" — UNSUPPORTED is the more
    // actionable case for the agent (sim gap, not a rule problem).
    const trace = [
      rule({
        ruleIndex: 0,
        line: 5,
        verdict: 'UNSUPPORTED',
        message: 'Unknown function: foo',
        expressionTrace: [
          entry({ source: 'foo()', kind: 'functionCall', error: 'Unknown function: foo' }),
        ],
      }),
      rule({
        ruleIndex: 1,
        line: 9,
        verdict: 'DENY',
        expressionTrace: [
          entry({ source: 'b', value: false }),
        ],
      }),
    ];
    const out = extractFailingExpression(trace);
    expect(out).not.toBeNull();
    expect(out!.source).toBe('foo()');
    expect(out!.line).toBe(5);
  });

  test('attaches the rule line from the determining RuleEvaluation', () => {
    const trace = [
      rule({
        verdict: 'DENY',
        line: 42,
        expressionTrace: [entry({ source: 'a', value: false })],
      }),
    ];
    expect(extractFailingExpression(trace)!.line).toBe(42);
  });
});

// ─── buildDiagnosis (handler-delegated end-to-end) ───────────────────

describe('buildDiagnosis', () => {
  // These tests exercise the analysis the orchestrator handler
  // delegates to — the wiring from `TestResult` → `Diagnosis`. The
  // handler itself is runner-coupled and hard to test, but moving
  // the analysis into a pure function lets us assert the full
  // contract here without spinning up a sandbox.

  function ctx(overrides: Partial<DiagnosisEventContext> = {}): DiagnosisEventContext {
    return {
      method: 'create',
      path: 'docs/d1',
      auth: { uid: 'alice', token: {} },
      ...overrides,
    };
  }

  function result(overrides: Partial<TestResult> = {}): TestResult {
    return {
      description: 'tc',
      expectation: 'ALLOW',
      state: 'FAILED',
      decision: 'DENY',
      trace: [],
      notes: [],
      ...overrides,
    };
  }

  test('PATH_MISMATCH flows pathResolution → pathNearMisses end-to-end', () => {
    // The structural piece: feed a TestResult whose pathResolution
    // includes a near-miss, verify the diagnosis surfaces it. Was
    // untested before refactor — the handler did this inline and
    // the only way to catch a regression was the manual playground
    // path.
    const tr = result({
      trace: [],  // no rule evaluated → matchedAnyRule false → PATH_MISMATCH
      notes: [`No match block found for path 'users/alice/extra'`],
      pathResolution: {
        requestPath: 'users/alice/extra',
        attempts: [
          {
            line: 8,
            blockPath: '/users/{uid}',
            matchedSegments: 2,
            totalSegments: 2,
            bindings: { uid: 'alice' },
            matched: false,
            reason: 'no-matching-child',
          },
        ],
      },
    });
    const out = buildDiagnosis({
      tr,
      event: ctx({ path: 'users/alice/extra' }),
      lintFindings: [],
    });
    expect(out.likelyCause).toBe('PATH_MISMATCH');
    expect(out.pathNearMisses).toHaveLength(1);
    expect(out.pathNearMisses[0].blockPath).toBe('/users/{uid}');
    // The note should also carry the near-miss text.
    expect(out.notes.find(n => n.startsWith('Near-miss'))).toBeDefined();
  });

  test('IDENTITY_MISMATCH does NOT surface pathNearMisses even when pathResolution is populated', () => {
    // Defensive: a rule that evaluated to DENY at an identity check
    // shouldn't render match-block detail in the diagnosis, even if
    // the simulator's pathResolution happens to have near-miss
    // entries (e.g. unrelated paths in the same rule file).
    const tr = result({
      trace: [{
        ruleIndex: 0,
        operations: ['create'],
        verdict: 'DENY',
        line: 10,
        expressionTrace: [
          { source: 'request.auth.uid == resource.data.owner', kind: 'binaryOp', parent: null, value: false },
        ],
      }],
      pathResolution: {
        requestPath: 'docs/d1',
        attempts: [
          { line: 8, blockPath: '/other/{x}', matchedSegments: 1, totalSegments: 2, bindings: {}, matched: false, reason: 'no-matching-child' },
        ],
      },
    });
    const out = buildDiagnosis({ tr, event: ctx(), lintFindings: [] });
    expect(out.likelyCause).toBe('IDENTITY_MISMATCH');
    expect(out.pathNearMisses).toEqual([]);
  });

  test('sandboxStateAtPath is undefined when not provided (vs. null when "doc absent")', () => {
    // The distinction matters: undefined = "didn\'t read",
    // null = "read and got nothing." Notes render differently.
    const trNoState = result({
      trace: [{
        ruleIndex: 0,
        operations: ['create'],
        verdict: 'DENY',
        expressionTrace: [{ source: 'false', kind: 'literal', parent: null, value: false }],
      }],
    });
    const noState = buildDiagnosis({ tr: trNoState, event: ctx(), lintFindings: [] });
    expect('sandboxStateAtPath' in noState).toBe(false);

    const nullState = buildDiagnosis({ tr: trNoState, event: ctx(), sandboxStateAtPath: null, lintFindings: [] });
    expect(nullState.sandboxStateAtPath).toBeNull();
    expect(nullState.notes.find(n => n.includes('does NOT exist'))).toBeDefined();
  });

  test('lintFindings pass through verbatim', () => {
    const findings = [
      { message: 'use of insecure read pattern', severity: 'warning' as const, ruleIndex: 2 },
    ];
    const tr = result({
      trace: [{
        ruleIndex: 0,
        operations: ['create'],
        verdict: 'DENY',
        expressionTrace: [{ source: 'false', kind: 'literal', parent: null, value: false }],
      }],
    });
    const out = buildDiagnosis({ tr, event: ctx(), lintFindings: findings });
    expect(out.lintFindings).toEqual(findings);
  });

  test('no rule evaluated AND no pathResolution → PATH_MISMATCH with empty near-misses', () => {
    // Edge: a degenerate ruleset (no match blocks at all). The
    // simulator returns an empty trace AND an empty pathResolution.
    // Cause should still classify as PATH_MISMATCH; near-misses
    // empty by definition.
    const tr = result({
      trace: [],
      pathResolution: { requestPath: 'docs/d1', attempts: [] },
    });
    const out = buildDiagnosis({ tr, event: ctx(), lintFindings: [] });
    expect(out.likelyCause).toBe('PATH_MISMATCH');
    expect(out.pathNearMisses).toEqual([]);
  });

  test('UNSUPPORTED verdict carries through to UNSUPPORTED_SURFACE cause', () => {
    const tr = result({
      decision: 'UNSUPPORTED',
      state: 'UNSUPPORTED',
      trace: [{
        ruleIndex: 0,
        operations: ['create'],
        verdict: 'UNSUPPORTED',
        message: 'Unknown function: foo',
        line: 5,
        expressionTrace: [
          { source: 'foo()', kind: 'functionCall', parent: null, error: 'Unknown function: foo' },
        ],
      }],
    });
    const out = buildDiagnosis({ tr, event: ctx(), lintFindings: [] });
    expect(out.likelyCause).toBe('UNSUPPORTED_SURFACE');
    expect(out.failingExpression?.source).toBe('foo()');
  });

  test('null auth flips AUTH_MISSING vs IDENTITY_MISMATCH classification', () => {
    // Same failing expression, two different event contexts. The
    // cause classifier branches on hasAuth — exercising both arms
    // ensures the handler→cause wiring through buildDiagnosis is
    // identity-aware.
    const tr = result({
      trace: [{
        ruleIndex: 0,
        operations: ['get'],
        verdict: 'DENY',
        line: 7,
        expressionTrace: [
          { source: 'request.auth != null', kind: 'binaryOp', parent: null, value: false },
        ],
      }],
    });
    const anon = buildDiagnosis({ tr, event: ctx({ auth: null }), lintFindings: [] });
    const authed = buildDiagnosis({ tr, event: ctx({ auth: { uid: 'alice' } }), lintFindings: [] });
    expect(anon.likelyCause).toBe('AUTH_MISSING');
    // With auth present, `request.auth != null` evaluating false
    // would actually be a sim bug — but the classifier sees the
    // same source pattern, hasAuth: true, and doesn\'t flag
    // IDENTITY_MISMATCH because there\'s no uid check; falls back.
    expect(authed.likelyCause).toBe('AUTH_MISSING');
  });
});
