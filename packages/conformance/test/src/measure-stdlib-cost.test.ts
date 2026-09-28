import { describe, expect, test } from 'bun:test';
import { mergeCapture, type CostCapture, type CostRun } from '../../src/measure-stdlib-cost.ts';

const row = (module: string, fn: string, min: number) => ({ module, function: fn, cost: { min, max: min + 1 }, reads: 0 });
const probe = (module: string, fn: string, perCall: number) => ({ module, function: fn, case: `${fn} case`, measured: { perCall } });

/** A full run of three modules: 60 requests, 2303 test cases. */
const full: CostCapture = {
  schema: 'pyric.stdlib-cost.v1',
  capturedAt: '2026-09-27T21:50:19.916Z',
  projects: { firestore: 'digame-mas', storage: 'digame-mas' },
  method: 'padding',
  calibration: { firestore: { d: 986 }, storage: { d: 986 } },
  requests: 60,
  testCases: 2303,
  functions: [row('auth', 'isSignedIn', 5), row('lobby', 'validCreate', 8), row('lobby', 'validJoin', 10), row('state', 'isPlaying', 6)],
  probes: [probe('auth', 'isSignedIn', 5), probe('lobby', 'validCreate', 8), probe('lobby', 'validJoin', 10), probe('state', 'isPlaying', 6)],
};

/** A partial run of lobby that measures one function more than the full run did. */
const lobbyRun: CostRun = {
  capturedAt: '2026-09-28T12:00:00.000Z',
  modules: ['lobby'],
  projects: { firestore: 'digame-mas' },
  calibration: { firestore: { d: 986 } },
  requests: 8,
  testCases: 463,
  functions: [row('lobby', 'validCreate', 9), row('lobby', 'validJoin', 11), row('lobby', 'validRematch', 20)],
  probes: [probe('lobby', 'validCreate', 9), probe('lobby', 'validJoin', 11), probe('lobby', 'validRematch', 20)],
};

describe('mergeCapture', () => {
  test('a partial run keeps the full run totals, date and calibration', () => {
    const merged = mergeCapture(full, lobbyRun);
    expect(merged.requests).toBe(60);
    expect(merged.testCases).toBe(2303);
    expect(merged.capturedAt).toBe(full.capturedAt);
    expect(merged.calibration).toEqual(full.calibration);
  });

  test('a partial run records its own totals under each module it measured', () => {
    const merged = mergeCapture(full, lobbyRun);
    expect(merged.runs).toEqual({
      lobby: { requests: 8, testCases: 463, date: '2026-09-28T12:00:00.000Z', modules: ['lobby'], calibration: { firestore: { d: 986 } } },
    });
  });

  test('a partial run updates rows in place and adds a new function after its module rows', () => {
    const merged = mergeCapture(full, lobbyRun);
    expect(merged.functions.map((f) => `${f.module}.${f.function}:${f.cost.min}`)).toEqual([
      'auth.isSignedIn:5', 'lobby.validCreate:9', 'lobby.validJoin:11', 'lobby.validRematch:20', 'state.isPlaying:6',
    ]);
    expect(merged.probes.map((p) => `${p.module}.${p.function}:${p.measured.perCall}`)).toEqual([
      'auth.isSignedIn:5', 'lobby.validCreate:9', 'lobby.validJoin:11', 'lobby.validRematch:20', 'state.isPlaying:6',
    ]);
  });

  test('a module the capture has never measured goes at the end', () => {
    const merged = mergeCapture(full, { ...lobbyRun, modules: ['fairness'], functions: [row('fairness', 'f', 3)], probes: [probe('fairness', 'f', 3)] });
    expect(merged.functions.map((f) => f.module)).toEqual(['auth', 'lobby', 'lobby', 'state', 'fairness']);
    expect(merged.probes.map((p) => p.module)).toEqual(['auth', 'lobby', 'lobby', 'state', 'fairness']);
  });

  test('a later partial run of the same module replaces its run record and keeps the others', () => {
    const once = mergeCapture(full, { ...lobbyRun, modules: ['state'], functions: [row('state', 'isPlaying', 7)], probes: [] });
    const twice = mergeCapture(once, { ...lobbyRun, requests: 3, testCases: 90 });
    expect(Object.keys(twice.runs!)).toEqual(['state', 'lobby']);
    expect(twice.runs!.lobby!.requests).toBe(3);
    expect(twice.requests).toBe(60);
  });

  test('a full run replaces the capture and drops the partial run records', () => {
    const partial = mergeCapture(full, lobbyRun);
    const rerun = mergeCapture(partial, { ...lobbyRun, modules: null, requests: 70, testCases: 2500 });
    expect(rerun.requests).toBe(70);
    expect(rerun.testCases).toBe(2500);
    expect(rerun.capturedAt).toBe(lobbyRun.capturedAt);
    expect(rerun.runs).toBeUndefined();
    expect(rerun.functions).toEqual(lobbyRun.functions);
  });

  test('a partial run with no capture to merge into is recorded as a partial run', () => {
    const first = mergeCapture(null, lobbyRun);
    expect([first.requests, first.testCases]).toEqual([null, null]);
    expect(first.runs!.lobby!.requests).toBe(8);
    expect(first.functions).toEqual(lobbyRun.functions);
  });
});
