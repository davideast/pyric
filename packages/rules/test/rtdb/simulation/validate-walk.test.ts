import { describe, expect, it } from 'bun:test';
import { DataSnapshot, evaluateRtdbRule } from '../../../src/rtdb/grammar/simulator.js';
import { compileRtdbRules, simulateRtdbRules } from '../../../src/rtdb/compiled-rules.js';
import type { RtdbRuleEvaluation } from '../../../src/rtdb/simulation/spec.js';
import {
  childFor,
  findFailingValidate,
  toValidateFailureResult,
  traceEntry,
  wildcardChildOf,
} from '../../../src/rtdb/simulation/validate-walk.js';

describe('validate-walk', () => {
  it('resolves literal children before wildcards and walks only written branches', () => {
    const compiled = compileRtdbRules({
      rules: {
        rooms: {
          meta: { '.validate': 'newData.isString()' },
          $roomId: {
            title: { '.validate': 'newData.isString()' },
            brokenSibling: { '.validate': 'false' },
          },
        },
      },
    });
    const roomsNode = childFor(compiled, 'rooms')!.child;
    expect(childFor(roomsNode, 'meta')?.variable).toBeUndefined();
    expect(childFor(roomsNode, 'r-1')?.variable).toBe('$roomId');
    expect(wildcardChildOf(roomsNode)?.variable).toBe('$roomId');

    const trace: RtdbRuleEvaluation[] = [];
    const rootData = new DataSnapshot({ rooms: { 'r-1': { brokenSibling: 123 } } }, '/');
    const mergedRootData = new DataSnapshot({ rooms: { 'r-1': { title: 'Lobby', brokenSibling: 123 } } }, '/');
    const failure = findFailingValidate({
      rootNode: compiled,
      rootData,
      mergedRootData,
      buildContext: (data, newData, bindings) => ({
        auth: null,
        data,
        newData,
        root: rootData,
        now: 1_000,
        pathVariableBindings: { ...bindings },
        query: {
          orderByChild: null,
          orderByKey: false,
          orderByValue: false,
          orderByPriority: false,
          equalTo: null,
          limitToFirst: null,
          limitToLast: null,
          startAt: null,
          endAt: null,
        },
      }),
      evaluateTracedRule(node, kind, rule, bindings, ctx) {
        const holds = evaluateRtdbRule(rule, ctx) === true;
        const outcome = { holds };
        trace.push(traceEntry(node, kind, rule, bindings, outcome));
        return outcome;
      },
      trace,
      pathToWrite: ['rooms', 'r-1', 'title'],
    });
    expect(failure).toBeNull();
    expect(trace.map((entry) => entry.path)).toEqual(['/rooms/$roomId/title']);

    const badMerged = new DataSnapshot({ rooms: { 'r-1': { title: 42, brokenSibling: 123 } } }, '/');
    const denied = findFailingValidate({
      rootNode: compiled,
      rootData,
      mergedRootData: badMerged,
      buildContext: (data, newData, bindings) => ({
        auth: null,
        data,
        newData,
        root: rootData,
        now: 1_000,
        pathVariableBindings: { ...bindings },
        query: {
          orderByChild: null,
          orderByKey: false,
          orderByValue: false,
          orderByPriority: false,
          equalTo: null,
          limitToFirst: null,
          limitToLast: null,
          startAt: null,
          endAt: null,
        },
      }),
      evaluateTracedRule(node, kind, rule, bindings, ctx) {
        const holds = evaluateRtdbRule(rule, ctx) === true;
        const outcome = { holds };
        trace.push(traceEntry(node, kind, rule, bindings, outcome));
        return outcome;
      },
      trace,
      pathToWrite: ['rooms', 'r-1', 'title'],
    });
    expect(denied?.node.path).toBe('/rooms/$roomId/title');
    const result = toValidateFailureResult(denied!, trace);
    expect(result.success && !result.data.allowed ? result.data.matchedPath : '').toBe('/rooms/$roomId/title');

    let archiveReads = 0;
    const rawWithArchive: Record<string, unknown> = {
      rooms: { 'r-1': { title: 'Fast' } },
    };
    Object.defineProperty(rawWithArchive, 'archive', {
      enumerable: true,
      get() {
        archiveReads += 1;
        return { large: 'untouched' };
      },
    });
    const walkFast = findFailingValidate({
      rootNode: compiled,
      rootData: new DataSnapshot(rawWithArchive, '/'),
      mergedRootData: new DataSnapshot(rawWithArchive, '/'),
      buildContext: (data, newData, bindings) => ({
        auth: null,
        data,
        newData,
        root: new DataSnapshot(rawWithArchive, '/'),
        now: 1_000,
        pathVariableBindings: { ...bindings },
        query: {
          orderByChild: null,
          orderByKey: false,
          orderByValue: false,
          orderByPriority: false,
          equalTo: null,
          limitToFirst: null,
          limitToLast: null,
          startAt: null,
          endAt: null,
        },
      }),
      evaluateTracedRule(node, kind, rule, bindings, ctx) {
        const holds = evaluateRtdbRule(rule, ctx) === true;
        const outcome = { holds };
        trace.push(traceEntry(node, kind, rule, bindings, outcome));
        return outcome;
      },
      trace,
      pathToWrite: ['rooms', 'r-1', 'title'],
    });
    expect(walkFast).toBeNull();
    expect(archiveReads).toBe(0);
  });

  it('produces identical read-observer paths and rule trace/evidence as pre-change val()-based traversal with and without .validate', () => {
    // Reference pre-change walk: calls `exists()` (via `val() !== null`) on every
    // visited node regardless of `node.validate` and `val()` for child keys.
    function legacyWalkObserverPaths(
      rootNode: ReturnType<typeof compileRtdbRules>,
      rawMerged: Record<string, unknown>,
      rawStored: Record<string, unknown>,
      pathToWrite: string[],
    ): { storedReads: string[]; postWriteReads: string[]; trace: RtdbRuleEvaluation[] } {
      const storedReads: string[] = [];
      const postWriteReads: string[] = [];
      const trace: RtdbRuleEvaluation[] = [];

      const legacyVal = (snap: DataSnapshot, list: string[], path: string): unknown => {
        list.push(path);
        // Call `val()` without double-counting observer by reading plain snapshot.
        return new DataSnapshot((snap as unknown as { _value: unknown })._value, path).val();
      };

      const walkRef = (
        node: ReturnType<typeof compileRtdbRules>,
        dataSnap: DataSnapshot,
        newSnap: DataSnapshot,
        bindings: Record<string, string>,
        segs: string[],
      ): boolean => {
        const curPath = segs.length === 0 ? '/' : `/${segs.join('/')}`;
        const exists = legacyVal(newSnap, postWriteReads, curPath) !== null;
        if (exists && node.validate) {
          const holds =
            evaluateRtdbRule(node.validate, {
              auth: { uid: 'u-1', token: {} },
              data: dataSnap,
              newData: newSnap,
              root: new DataSnapshot(rawStored, '/', undefined, (p) => storedReads.push(p)),
              now: 1_000,
              pathVariableBindings: { ...bindings },
              query: {
                orderByChild: null,
                orderByKey: false,
                orderByValue: false,
                orderByPriority: false,
                equalTo: null,
                limitToFirst: null,
                limitToLast: null,
                startAt: null,
                endAt: null,
              },
            }) === true;
          trace.push(traceEntry(node, 'validate', node.validate, bindings, { holds }));
          if (!holds) return false;
        }
        const atOrBelow = pathToWrite.length <= segs.length && pathToWrite.every((s, i) => s === segs[i]);
        let keys: Iterable<string>;
        if (atOrBelow) {
          const v = legacyVal(newSnap, postWriteReads, curPath);
          keys = v !== null && typeof v === 'object' ? Object.keys(v as object) : [];
        } else {
          const set = new Set<string>();
          if (pathToWrite.length > segs.length && segs.every((s, i) => s === pathToWrite[i])) {
            set.add(pathToWrite[segs.length]!);
          }
          keys = set;
        }
        for (const k of keys) {
          const matched = childFor(node, k);
          if (!matched) continue;
          const nextB = matched.variable ? { ...bindings, [matched.variable]: k } : bindings;
          if (!walkRef(matched.child, dataSnap.child(k), newSnap.child(k), nextB, [...segs, k])) {
            return false;
          }
        }
        return true;
      };

      walkRef(
        rootNode,
        new DataSnapshot(rawStored, '/', undefined, (p) => storedReads.push(p)),
        new DataSnapshot(rawMerged, '/', undefined, (p) => postWriteReads.push(p)),
        {},
        [],
      );
      return { storedReads, postWriteReads, trace };
    }

    const rulesWithValidate = compileRtdbRules({
      rules: {
        workspaces: {
          $wsId: {
            '.write': "auth != null && root.child('members/' + auth.uid).val() === true",
            items: {
              $itemId: {
                '.validate': "newData.hasChildren(['title']) && !root.child('workspaces/' + $wsId + '/locked').exists()",
                title: { '.validate': 'newData.isString()' },
              },
            },
          },
        },
      },
    });
    const rulesWithoutValidate = compileRtdbRules({
      rules: {
        workspaces: {
          $wsId: {
            '.write': "auth != null && root.child('members/' + auth.uid).val() === true",
            items: {
              $itemId: {
                '.read': 'auth != null',
              },
            },
          },
        },
      },
    });

    const stored = { members: { 'u-1': true }, workspaces: { 'ws-1': {} } };
    const merged = { members: { 'u-1': true }, workspaces: { 'ws-1': { items: { 'i-1': { title: 'Doc', extra: 1 } } } } };

    for (const compiled of [rulesWithValidate, rulesWithoutValidate]) {
      const expected = legacyWalkObserverPaths(compiled, merged, stored, ['workspaces', 'ws-1', 'items', 'i-1']);

      const actualStoredReads: string[] = [];
      const actualPostWriteReads: string[] = [];
      const actualTrace: RtdbRuleEvaluation[] = [];
      const rootData = new DataSnapshot(stored, '/', undefined, (p) => actualStoredReads.push(p));
      const mergedRootData = new DataSnapshot(merged, '/', undefined, (p) => actualPostWriteReads.push(p));

      findFailingValidate({
        rootNode: compiled,
        rootData,
        mergedRootData,
        buildContext: (data, newData, bindings) => ({
          auth: { uid: 'u-1', token: {} },
          data,
          newData,
          root: rootData,
          now: 1_000,
          pathVariableBindings: { ...bindings },
          query: {
            orderByChild: null,
            orderByKey: false,
            orderByValue: false,
            orderByPriority: false,
            equalTo: null,
            limitToFirst: null,
            limitToLast: null,
            startAt: null,
            endAt: null,
          },
        }),
        evaluateTracedRule(node, kind, rule, bindings, ctx) {
          const holds = evaluateRtdbRule(rule, ctx) === true;
          const outcome = { holds };
          actualTrace.push(traceEntry(node, kind, rule, bindings, outcome));
          return outcome;
        },
        trace: actualTrace,
        pathToWrite: ['workspaces', 'ws-1', 'items', 'i-1'],
      });

      expect(actualStoredReads).toEqual(expected.storedReads);
      expect(actualPostWriteReads).toEqual(expected.postWriteReads);
      expect(actualTrace).toEqual(expected.trace);
    }

    // Also verify SimulateHandler `onRuleRead` attribution with and without `.validate`.
    const readsWithValidate: Array<{ traceIndex: number; source: string; path: string }> = [];
    const resWith = simulateRtdbRules(
      rulesWithValidate,
      {
        operation: 'write',
        path: '/workspaces/ws-1/items/i-1',
        auth: { uid: 'u-1' },
        mockData: stored,
        newData: { title: 'Doc', extra: 1 },
      },
      { onRuleRead: (traceIndex, source, path) => readsWithValidate.push({ traceIndex, source, path }) },
    );
    expect(resWith.success && resWith.data.allowed).toBe(true);
    expect(readsWithValidate).toEqual([
      { traceIndex: 0, source: 'stored', path: '/members/u-1' },
      { traceIndex: 1, source: 'postWrite', path: '/workspaces/ws-1/items/i-1/title' },
      { traceIndex: 1, source: 'stored', path: '/workspaces/ws-1/locked' },
      { traceIndex: 2, source: 'postWrite', path: '/workspaces/ws-1/items/i-1/title' },
    ]);

    const readsWithoutValidate: Array<{ traceIndex: number; source: string; path: string }> = [];
    const resWithout = simulateRtdbRules(
      rulesWithoutValidate,
      {
        operation: 'write',
        path: '/workspaces/ws-1/items/i-1',
        auth: { uid: 'u-1' },
        mockData: stored,
        newData: { title: 'Doc', extra: 1 },
      },
      { onRuleRead: (traceIndex, source, path) => readsWithoutValidate.push({ traceIndex, source, path }) },
    );
    expect(resWithout.success && resWithout.data.allowed).toBe(true);
    expect(readsWithoutValidate).toEqual([
      { traceIndex: 0, source: 'stored', path: '/members/u-1' },
    ]);
  });
});
