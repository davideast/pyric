import { describe, expect, test } from 'bun:test';
import { all, any, authenticated, rtdbStdlib } from 'pyric/rules';
import { runScenario, type StdlibScenario } from './harness.js';

const { turns, lifecycle, counters, lobby } = rtdbStdlib;

const scenario: StdlibScenario = {
  paths: {
    '/matches/$matchId': {
      read: authenticated(),
      write: all(
        turns.isMyTurn(),
        turns.turnFlipped(),
        lifecycle.onlyFieldsChanged(['currentTurn', 'moveCount'], lobby.MATCH_FIELDS),
      ),
      children: { '/moveCount': { validate: counters.incrementedBy(1) } },
    },
    '/tables/$tableId': {
      read: authenticated(),
      write: all(turns.isSeatTurn(3), turns.turnAdvanced(3)),
    },
    // turnAdvanced runs first here, on a board with no stored turn.
    '/boards/$boardId': {
      write: any(all(turns.turnAdvanced(3), turns.isSeatTurn(3)), all(authenticated(), lifecycle.createOnly())),
    },
  },
  cases: [],
};

const match = (currentTurn: string, extra: Record<string, unknown> = {}) => ({
  matches: { m1: { host: 'alice', guest: 'bob', status: 'playing', currentTurn, winner: '', moveCount: 4, ...extra } },
});
const table = (turn: number) => ({ tables: { t1: { players: { 0: 'ann', 1: 'ben', 2: 'cat' }, turn } } });

scenario.cases.push(
  { description: 'the host moves on the host turn', expectation: 'ALLOW', operation: 'update', path: '/matches/m1', auth: 'alice', data: match('host'), newData: { currentTurn: 'guest', moveCount: 5 } },
  { description: 'the guest moves on the guest turn', expectation: 'ALLOW', operation: 'update', path: '/matches/m1', auth: 'bob', data: match('guest'), newData: { currentTurn: 'host', moveCount: 5 } },
  { description: 'the guest moves on the host turn', expectation: 'DENY', operation: 'update', path: '/matches/m1', auth: 'bob', data: match('host'), newData: { currentTurn: 'guest', moveCount: 5 } },
  { description: 'a user who is not seated moves', expectation: 'DENY', operation: 'update', path: '/matches/m1', auth: 'carol', data: match('host'), newData: { currentTurn: 'guest', moveCount: 5 } },
  { description: 'a move that keeps the turn', expectation: 'DENY', operation: 'update', path: '/matches/m1', auth: 'alice', data: match('host'), newData: { moveCount: 5 } },
  { description: 'a move that counts two moves', expectation: 'DENY', operation: 'update', path: '/matches/m1', auth: 'alice', data: match('host'), newData: { currentTurn: 'guest', moveCount: 6 } },
  { description: 'a move that also sets the winner', expectation: 'DENY', operation: 'update', path: '/matches/m1', auth: 'alice', data: match('host'), newData: { currentTurn: 'guest', moveCount: 5, winner: 'host' } },
  { description: 'a signed-out move', expectation: 'DENY', operation: 'update', path: '/matches/m1', auth: null, data: match('host'), newData: { currentTurn: 'guest', moveCount: 5 } },
  { description: 'the last seat moves and the turn wraps to seat 0', expectation: 'ALLOW', operation: 'update', path: '/tables/t1', auth: 'cat', data: table(2), newData: { turn: 0 } },
  { description: 'seat 0 moves and the turn passes to seat 1', expectation: 'ALLOW', operation: 'update', path: '/tables/t1', auth: 'ann', data: table(0), newData: { turn: 1 } },
  { description: 'a seat moves out of turn', expectation: 'DENY', operation: 'update', path: '/tables/t1', auth: 'ann', data: table(2), newData: { turn: 0 } },
  { description: 'a move that skips a seat', expectation: 'DENY', operation: 'update', path: '/tables/t1', auth: 'cat', data: table(2), newData: { turn: 1 } },
  { description: 'a move that also replaces a seat', expectation: 'DENY', operation: 'update', path: '/tables/t1', auth: 'cat', data: table(2), newData: { turn: 0, 'players/0': 'cat' } },
  { description: 'a board created with no stored turn', expectation: 'ALLOW', operation: 'write', path: '/boards/b1', auth: 'ann', newData: { players: { 0: 'ann', 1: 'ben', 2: 'cat' }, turn: 0 } },
);

describe('rtdbStdlib.turns', () => {
  test('isMyTurn reads the stored turn and seats, never the written ones', () => {
    expect(turns.isMyTurn()).toBe(
      "auth != null && ((data.child('currentTurn').val() == 'host' && data.child('host').val() == auth.uid) || (data.child('currentTurn').val() == 'guest' && data.child('guest').val() == auth.uid))",
    );
  });

  test('turnFlipped compiles to the two transitions', () => {
    expect(turns.turnFlipped()).toBe(
      "(data.child('currentTurn').val() == 'host' && newData.child('currentTurn').val() == 'guest') || (data.child('currentTurn').val() == 'guest' && newData.child('currentTurn').val() == 'host')",
    );
  });

  test('isSeatTurn and turnAdvanced unroll the seats and reject a count below 1', () => {
    expect(turns.isSeatTurn(2)).toBe(
      "auth != null && ((data.child('turn').val() == 0 && data.child('players/0').val() == auth.uid) || (data.child('turn').val() == 1 && data.child('players/1').val() == auth.uid))",
    );
    expect(turns.turnAdvanced(2)).toBe(
      "data.child('turn').isNumber() && newData.child('turn').val() == (data.child('turn').val() + 1) % 2 && newData.child('players/0').val() == data.child('players/0').val() && newData.child('players/1').val() == data.child('players/1').val()",
    );
    expect(() => turns.isSeatTurn(0)).toThrow();
    expect(() => turns.turnAdvanced(1.5)).toThrow();
  });

  runScenario(scenario);
});
