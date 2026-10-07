import { describe, expect, test } from 'bun:test';
import { rtdbStdlib } from 'pyric/rules';
import { runScenario, type StdlibScenario } from './harness.js';

const { presence } = rtdbStdlib;

const scenario: StdlibScenario = {
  paths: {
    '/status/$uid': presence.record(),
    '/online/$uid': presence.flag(),
  },
  cases: [],
};

const stored = { status: { alice: { state: 'online', lastChanged: 1 } } };

scenario.cases.push(
  { description: 'a user marks themself online with the server time', expectation: 'ALLOW', operation: 'write', path: '/status/alice', auth: 'alice', newData: { state: 'online', lastChanged: 0 }, serverTime: ['lastChanged'] },
  { description: 'a user registers an offline write for disconnect', expectation: 'ALLOW', operation: 'write', path: '/status/alice', auth: 'alice', data: stored, newData: { state: 'offline', lastChanged: 0 }, serverTime: ['lastChanged'], onDisconnect: true },
  { description: 'a user registers removal of their presence for disconnect', expectation: 'ALLOW', operation: 'write', path: '/status/alice', auth: 'alice', data: stored, newData: null, onDisconnect: true },
  { description: 'a user writes presence for someone else', expectation: 'DENY', operation: 'write', path: '/status/bob', auth: 'alice', newData: { state: 'online', lastChanged: 0 }, serverTime: ['lastChanged'] },
  { description: 'a user registers a disconnect write for someone else', expectation: 'DENY', operation: 'write', path: '/status/bob', auth: 'alice', newData: { state: 'offline', lastChanged: 0 }, serverTime: ['lastChanged'], onDisconnect: true },
  { description: 'a presence with a client clock time', expectation: 'DENY', operation: 'write', path: '/status/alice', auth: 'alice', newData: { state: 'online', lastChanged: 1000 } },
  { description: 'a presence with an unknown state', expectation: 'DENY', operation: 'write', path: '/status/alice', auth: 'alice', newData: { state: 'away', lastChanged: 0 }, serverTime: ['lastChanged'] },
  { description: 'a presence with an extra child', expectation: 'DENY', operation: 'write', path: '/status/alice', auth: 'alice', newData: { state: 'online', lastChanged: 0, device: 'x' }, serverTime: ['lastChanged'] },
  { description: 'a signed-out presence write', expectation: 'DENY', operation: 'write', path: '/status/alice', auth: null, newData: { state: 'online', lastChanged: 0 }, serverTime: ['lastChanged'] },
  { description: 'a signed-in user reads presence', expectation: 'ALLOW', operation: 'read', path: '/status/alice', auth: 'bob', data: stored },
  { description: 'a user sets their online flag', expectation: 'ALLOW', operation: 'write', path: '/online/alice', auth: 'alice', newData: true },
  { description: 'a user registers their flag off for disconnect', expectation: 'ALLOW', operation: 'write', path: '/online/alice', auth: 'alice', newData: false, onDisconnect: true },
  { description: 'a flag written as a string', expectation: 'DENY', operation: 'write', path: '/online/alice', auth: 'alice', newData: 'yes' },
);

describe('rtdbStdlib.presence', () => {
  test('ownPresence compiles to the uid check', () => {
    expect(presence.ownPresence()).toBe('auth != null && auth.uid == $uid');
    expect(() => presence.ownPresence('uid')).toThrow();
  });

  runScenario(scenario);
});
