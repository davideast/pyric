import { describe, it, expect } from 'bun:test';
import { useSessionReplay } from '../../../src/events/hooks/useSessionReplay.js';
import { useDivergenceInspector } from '../../../src/events/hooks/useDivergenceInspector.js';
import { divergencesToFieldChanges } from '../../../src/events/divergenceAdapter.js';
import { renderHook, act } from '../../helpers/render-hook.js';
import type { SandboxEvent, WriteSandboxEvent } from 'pyric/sandbox';
import type { ReplayDivergence } from '../../../src/events/replayTypes.js';

const RULES = `
rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /{document=**} {
      allow read, write: if true;
    }
  }
}
`;

function makeWriteEvent(overrides: Partial<WriteSandboxEvent> = {}): WriteSandboxEvent {
  return {
    kind: 'write',
    id: 'w1',
    at: 1000,
    requestTime: { seconds: 1000, nanoseconds: 0 },
    method: 'set',
    path: 'users/alice',
    auth: null,
    data: { name: 'Alice' },
    priorState: null,
    nextState: { name: 'Alice' },
    ...overrides,
  };
}

describe('useSessionReplay', () => {
  it('initializes with default settings and empty results', () => {
    const { result } = renderHook(() =>
      useSessionReplay({
        events: [],
        rules: RULES,
      }),
    );

    expect(result.current.isReplaying).toBe(false);
    expect(result.current.error).toBeNull();
    expect(result.current.result).toBeNull();
    expect(result.current.divergences).toEqual([]);
    expect(result.current.pinRequestTime).toBe(true);
    expect(result.current.rules).toBe(RULES);
  });

  it('runs replay and re-issues writes against a fresh sandbox', () => {
    const event = makeWriteEvent();
    const { result } = renderHook(() =>
      useSessionReplay({
        events: [event],
        rules: RULES,
      }),
    );

    act(() => {
      result.current.replay();
    });

    expect(result.current.result).not.toBeNull();
    expect(result.current.replayedSandbox).not.toBeNull();
    expect(result.current.error).toBeNull();
    expect(result.current.isReplaying).toBe(false);
  });

  it('detects divergences against original state snapshot', () => {
    const event = makeWriteEvent({ data: { name: 'Alice', role: 'admin' } });
    const originalState = {
      'users/alice': { name: 'Alice', role: 'user' },
    };

    const { result } = renderHook(() =>
      useSessionReplay({
        events: [event],
        rules: RULES,
        originalState,
      }),
    );

    act(() => {
      result.current.replay();
    });

    expect(result.current.divergences.length).toBeGreaterThan(0);
    const div = result.current.divergences[0]!;
    expect(div.kind).toBe('real-divergence');
  });

  it('toggles pinRequestTime', () => {
    const { result } = renderHook(() =>
      useSessionReplay({
        events: [],
        rules: RULES,
      }),
    );

    act(() => {
      result.current.setPinRequestTime(false);
    });

    expect(result.current.pinRequestTime).toBe(false);
  });

  it('supports autoReplay: true on mount', () => {
    const event = makeWriteEvent();
    const { result } = renderHook(() =>
      useSessionReplay({
        events: [event],
        rules: RULES,
        autoReplay: true,
      }),
    );

    expect(result.current.result).not.toBeNull();
    expect(result.current.replayedSandbox).not.toBeNull();
  });
});

describe('useDivergenceInspector', () => {
  const sampleDivergences: ReplayDivergence[] = [
    {
      kind: 'real-divergence',
      path: 'posts/p1',
      field: 'title',
      before: 'old title',
      after: 'new title',
    },
    {
      kind: 'sentinel-drift',
      path: 'posts/p1',
      field: 'count',
      sentinelKind: 'increment',
      before: 1,
      after: 2,
    },
    {
      kind: 'time-drift',
      path: 'posts/p1',
      field: 'createdAt',
      before: 100,
      after: 200,
    },
    {
      kind: 'autoid-alias',
      originalPath: 'users/auto1',
      replayedPath: 'users/auto2',
    },
    {
      kind: 'now-denied',
      path: 'secret/s1',
      method: 'delete',
      reason: 'denied by rules',
    },
  ];

  it('summarizes counts across all divergence kinds', () => {
    const { result } = renderHook(() =>
      useDivergenceInspector({
        divergences: sampleDivergences,
      }),
    );

    expect(result.current.summary.total).toBe(5);
    expect(result.current.summary.realCount).toBe(1);
    expect(result.current.summary.sentinelDriftCount).toBe(1);
    expect(result.current.summary.timeDriftCount).toBe(1);
    expect(result.current.summary.autoidAliasCount).toBe(1);
    expect(result.current.summary.nowDeniedCount).toBe(1);
  });

  it('filters divergences by kind and selects item', () => {
    const { result } = renderHook(() =>
      useDivergenceInspector({
        divergences: sampleDivergences,
      }),
    );

    act(() => {
      result.current.setFilter('sentinel-drift');
    });

    expect(result.current.filteredDivergences.length).toBe(1);
    expect(result.current.filteredDivergences[0]!.kind).toBe('sentinel-drift');

    act(() => {
      result.current.selectDivergence(result.current.filteredDivergences[0]!);
    });

    expect(result.current.selectedDivergence?.kind).toBe('sentinel-drift');
  });
});

describe('divergencesToFieldChanges', () => {
  it('converts divergences into FieldChange items for ProposedChangeDiff', () => {
    const divergences: ReplayDivergence[] = [
      {
        kind: 'real-divergence',
        path: 'users/alice',
        field: 'role',
        before: undefined,
        after: 'admin',
      },
      {
        kind: 'sentinel-drift',
        path: 'users/alice',
        field: 'tags',
        sentinelKind: 'arrayUnion',
        before: ['a'],
        after: ['a', 'b'],
      },
      {
        kind: 'now-denied',
        path: 'users/alice',
        method: 'update',
        reason: 'insufficient permissions',
      },
    ];

    const changes = divergencesToFieldChanges(divergences);
    expect(changes.length).toBe(3);
    expect(changes[0]!.docPath).toBe('users/alice');
    expect(changes[0]!.kind).toBe('added');
    expect(changes[1]!.docPath).toBe('users/alice');
    expect(changes[1]!.kind).toBe('changed');
    expect(changes[2]!.docPath).toBe('users/alice');
    expect(changes[2]!.after).toContain('insufficient permissions');
  });
});
