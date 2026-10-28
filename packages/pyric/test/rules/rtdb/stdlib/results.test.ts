import { describe, expect, test } from 'bun:test';
import { all, any, authenticated, rtdbStdlib } from 'pyric/rules';
import { runScenario, type StdlibScenario } from './harness.js';

const { results, turns } = rtdbStdlib;

const scenario: StdlibScenario = {
  paths: {
    '/matches/$matchId': {
      read: authenticated(),
      write: any(
        results.resignedBy(),
        all(
          turns.isMyTurn(),
          any(results.finishedWithWinner('host', 'won'), results.finishedWithWinner('guest', 'won'), results.finishedWithWinner('', 'draw')),
        ),
        all(turns.isMyTurn(), turns.turnFlipped(), results.resultUnchanged()),
      ),
    },
  },
  cases: [],
};

const match = (extra: Record<string, unknown> = {}) => ({
  matches: { m1: { host: 'alice', guest: 'bob', status: 'playing', currentTurn: 'host', winner: '', moveCount: 4, ...extra } },
});

scenario.cases.push(
  { description: 'the host resigns and the guest wins', expectation: 'ALLOW', operation: 'update', path: '/matches/m1', auth: 'alice', data: match(), newData: { status: 'resigned', winner: 'guest' } },
  { description: 'the guest resigns off turn and the host wins', expectation: 'ALLOW', operation: 'update', path: '/matches/m1', auth: 'bob', data: match(), newData: { status: 'resigned', winner: 'host' } },
  { description: 'the host resigns naming themself the winner', expectation: 'DENY', operation: 'update', path: '/matches/m1', auth: 'alice', data: match(), newData: { status: 'resigned', winner: 'host' } },
  { description: 'a user who is not seated resigns', expectation: 'DENY', operation: 'update', path: '/matches/m1', auth: 'carol', data: match(), newData: { status: 'resigned', winner: 'guest' } },
  { description: 'a resignation after the match ended', expectation: 'DENY', operation: 'update', path: '/matches/m1', auth: 'alice', data: match({ status: 'won', winner: 'host' }), newData: { status: 'resigned', winner: 'guest' } },
  { description: 'a resignation that also changes the move count', expectation: 'DENY', operation: 'update', path: '/matches/m1', auth: 'alice', data: match(), newData: { status: 'resigned', winner: 'guest', moveCount: 5 } },
  { description: 'the player on turn records a win for the host', expectation: 'ALLOW', operation: 'update', path: '/matches/m1', auth: 'alice', data: match(), newData: { status: 'won', winner: 'host' } },
  { description: 'the player on turn records a draw', expectation: 'ALLOW', operation: 'update', path: '/matches/m1', auth: 'alice', data: match(), newData: { status: 'draw', winner: '' } },
  { description: 'a draw that names a winner', expectation: 'DENY', operation: 'update', path: '/matches/m1', auth: 'alice', data: match(), newData: { status: 'draw', winner: 'host' } },
  { description: 'a win recorded off turn', expectation: 'DENY', operation: 'update', path: '/matches/m1', auth: 'bob', data: match(), newData: { status: 'won', winner: 'guest' } },
  { description: 'a move that keeps the result', expectation: 'ALLOW', operation: 'update', path: '/matches/m1', auth: 'alice', data: match(), newData: { currentTurn: 'guest' } },
  { description: 'a move that rewrites the winner', expectation: 'DENY', operation: 'update', path: '/matches/m1', auth: 'alice', data: match(), newData: { currentTurn: 'guest', winner: 'host' } },
);

describe('rtdbStdlib.results', () => {
  test('resultUnchanged pins status and winner', () => {
    expect(results.resultUnchanged()).toBe(
      "newData.child('status').val() == data.child('status').val() && newData.child('winner').val() == data.child('winner').val()",
    );
  });

  test('finishedWithWinner refuses a winner that does not fit the reason', () => {
    expect(() => results.finishedWithWinner('', 'won')).toThrow();
    expect(() => results.finishedWithWinner('host', 'draw')).toThrow();
    expect(() => results.finishedWithWinner('nobody' as never, 'won')).toThrow();
    expect(() => results.finishedWithWinner('host', 'resigned' as never)).toThrow();
  });

  runScenario(scenario);
});
