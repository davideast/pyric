import { describe, expect, test } from 'bun:test';
import { all, any, authenticated, newDataExists, not, rtdbStdlib } from 'pyric/rules';
import { runScenario, type StdlibScenario } from './harness.js';

const { lobby, validation } = rtdbStdlib;

const matchShape = validation.shape(
  {
    host: 'string',
    guest: 'string',
    status: validation.oneOf('waiting', 'playing', 'won', 'draw', 'resigned'),
    currentTurn: validation.oneOf('host', 'guest'),
    winner: validation.oneOf('', 'host', 'guest'),
    moveCount: 'number',
    rematchOf: 'string',
  },
  { required: ['host', 'guest', 'status'] },
);

const scenario: StdlibScenario = {
  paths: {
    '/matches/$matchId': {
      read: authenticated(),
      // A plain create names no previous match; a create that names one is a rematch.
      write: any(
        all(lobby.validCreate(), not(newDataExists('rematchOf'))),
        lobby.validRematch(),
        lobby.validJoin(),
        lobby.canCancel(),
      ),
      ...matchShape,
    },
  },
  cases: [],
};

const waiting = { matches: { m1: { host: 'alice', guest: '', status: 'waiting' } } };
const playing = { matches: { m1: { host: 'alice', guest: 'bob', status: 'playing' } } };
const finished = (status: string) => ({ matches: { m1: { host: 'alice', guest: 'bob', status } } });
const open = (host: string, extra: Record<string, unknown> = {}) => ({ host, guest: '', status: 'waiting', ...extra });

scenario.cases.push(
  { description: 'the host creates a waiting match', expectation: 'ALLOW', operation: 'write', path: '/matches/m1', auth: 'alice', newData: open('alice') },
  { description: 'a create naming another user as host', expectation: 'DENY', operation: 'write', path: '/matches/m1', auth: 'alice', newData: open('bob') },
  { description: 'a create with the guest seat filled', expectation: 'DENY', operation: 'write', path: '/matches/m1', auth: 'alice', newData: { host: 'alice', guest: 'bob', status: 'waiting' } },
  { description: 'a create that starts playing', expectation: 'DENY', operation: 'write', path: '/matches/m1', auth: 'alice', newData: { host: 'alice', guest: '', status: 'playing' } },
  { description: 'a signed-out create', expectation: 'DENY', operation: 'write', path: '/matches/m1', auth: null, newData: open('alice') },
  { description: 'a create over an existing match', expectation: 'DENY', operation: 'write', path: '/matches/m1', auth: 'alice', data: playing, newData: open('alice') },
  { description: 'a create with a field outside the shape', expectation: 'DENY', operation: 'write', path: '/matches/m1', auth: 'alice', newData: open('alice', { cheat: true }) },
  { description: 'a second user joins the open seat', expectation: 'ALLOW', operation: 'update', path: '/matches/m1', auth: 'bob', data: waiting, newData: { guest: 'bob', status: 'playing' } },
  { description: 'the host joins their own match', expectation: 'DENY', operation: 'update', path: '/matches/m1', auth: 'alice', data: waiting, newData: { guest: 'alice', status: 'playing' } },
  { description: 'a join of a filled seat', expectation: 'DENY', operation: 'update', path: '/matches/m1', auth: 'carol', data: playing, newData: { guest: 'carol', status: 'playing' } },
  { description: 'a join that leaves the status waiting', expectation: 'DENY', operation: 'update', path: '/matches/m1', auth: 'bob', data: waiting, newData: { guest: 'bob' } },
  { description: 'a join that also sets the turn', expectation: 'DENY', operation: 'update', path: '/matches/m1', auth: 'bob', data: waiting, newData: { guest: 'bob', status: 'playing', currentTurn: 'guest' } },
  { description: 'a join that seats someone else', expectation: 'DENY', operation: 'update', path: '/matches/m1', auth: 'bob', data: waiting, newData: { guest: 'carol', status: 'playing' } },
  { description: 'the host deletes the waiting match', expectation: 'ALLOW', operation: 'write', path: '/matches/m1', auth: 'alice', data: waiting, newData: null },
  { description: 'another user deletes the waiting match', expectation: 'DENY', operation: 'write', path: '/matches/m1', auth: 'bob', data: waiting, newData: null },
  { description: 'the host deletes a match in play', expectation: 'DENY', operation: 'write', path: '/matches/m1', auth: 'alice', data: playing, newData: null },
  { description: 'the guest of a finished match opens a rematch', expectation: 'ALLOW', operation: 'write', path: '/matches/m2', auth: 'bob', data: finished('won'), newData: open('bob', { rematchOf: 'm1' }) },
  { description: 'the host of a drawn match opens a rematch', expectation: 'ALLOW', operation: 'write', path: '/matches/m2', auth: 'alice', data: finished('draw'), newData: open('alice', { rematchOf: 'm1' }) },
  { description: 'a rematch by a user who did not play', expectation: 'DENY', operation: 'write', path: '/matches/m2', auth: 'carol', data: finished('won'), newData: open('carol', { rematchOf: 'm1' }) },
  { description: 'a rematch of a match still in play', expectation: 'DENY', operation: 'write', path: '/matches/m2', auth: 'bob', data: playing, newData: open('bob', { rematchOf: 'm1' }) },
  { description: 'a rematch of a match that does not exist', expectation: 'DENY', operation: 'write', path: '/matches/m2', auth: 'bob', data: finished('won'), newData: open('bob', { rematchOf: 'm9' }) },
  { description: 'a signed-in user reads a match', expectation: 'ALLOW', operation: 'read', path: '/matches/m1', auth: 'carol', data: playing },
  { description: 'a signed-out user reads a match', expectation: 'DENY', operation: 'read', path: '/matches/m1', auth: null, data: playing },
);

describe('rtdbStdlib.lobby', () => {
  test('validCreate compiles to the creation check', () => {
    expect(lobby.validCreate()).toBe(
      "auth != null && !data.exists() && newData.child('host').val() == auth.uid && newData.child('guest').val() == '' && newData.child('status').val() == 'waiting'",
    );
  });

  test('canCancel only deletes', () => {
    expect(lobby.canCancel()).toBe(
      "auth != null && !newData.exists() && data.child('status').val() == 'waiting' && data.child('host').val() == auth.uid",
    );
  });

  test('validJoin pins every match field it does not change', () => {
    const join = lobby.validJoin();
    for (const field of ['host', 'currentTurn', 'winner', 'moveCount']) {
      expect(join).toContain(`newData.child('${field}').val() == data.child('${field}').val()`);
    }
    expect(join).not.toContain("newData.child('status').val() == data.child('status').val()");
  });

  test('validRematch reads the previous match as a sibling, not through root', () => {
    expect(lobby.validRematch()).toContain("data.parent().child(newData.child('rematchOf').val())");
    expect(lobby.validRematch()).not.toContain('root');
  });

  runScenario(scenario);
});
