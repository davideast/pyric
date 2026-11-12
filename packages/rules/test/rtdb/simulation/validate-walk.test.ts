import { describe, expect, it } from 'bun:test';
import { DataSnapshot, evaluateRtdbRule } from '../../../src/rtdb/grammar/simulator.js';
import { compileRtdbRules } from '../../../src/rtdb/compiled-rules.js';
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
  });
});
