import { describe, expect, it } from 'bun:test';
import type { InboundMessage } from '../../../../src/serve/worker/protocol.js';
import { opProvenance } from '../../../../src/serve/worker/host/core.js';

describe('opProvenance', () => {
  const cases: Array<{
    name: string;
    message: InboundMessage;
    journeyId?: string;
    expected: unknown;
  }> = [
    {
      name: 'normal app operation without an activity journey',
      message: { t: 'op', id: 'read', method: 'getDoc', path: 'items/one' },
      expected: undefined,
    },
    {
      name: 'normal app operation with an activity journey',
      message: { t: 'op', id: 'read', method: 'getDoc', path: 'items/one' },
      journeyId: 'page-4',
      expected: {
        actor: { kind: 'app', journeyId: 'page-4' },
        authLens: { mode: 'app-session' },
      },
    },
    {
      name: 'Studio issuer',
      message: {
        t: 'op', id: 'studio-read', method: 'getDoc', path: 'items/one', issuer: 'studio',
      },
      expected: { actor: { kind: 'studio' }, authLens: { mode: 'app-session' } },
    },
    {
      name: 'explicit auth lens',
      message: {
        t: 'op', id: 'admin-read', method: 'getDoc', path: 'items/one',
        actAs: { mode: 'admin' },
      },
      expected: { actor: { kind: 'app' }, authLens: { mode: 'admin' } },
    },
    {
      name: 'remote relay remains unattributed even with an app-like auth lens',
      message: {
        t: 'op', id: 'remote-read', method: 'getDoc', path: 'items/one',
        actAs: { mode: 'as', uid: 'alice' }, relaySource: 'remote',
      },
      journeyId: 'page-9',
      expected: { actor: { kind: 'unattributed' }, authLens: { mode: 'as', uid: 'alice' } },
    },
    {
      name: 'remote subscription has no app listener identity',
      message: {
        t: 'sub', subId: 'remote-listener', target: { __ref: 'doc', path: 'items/one' },
        actAs: { mode: 'anon' }, relaySource: 'remote',
      },
      expected: { actor: { kind: 'unattributed' }, authLens: { mode: 'anon' } },
    },
    {
      name: 'Firestore subscription listener id',
      message: {
        t: 'sub', subId: 'listener-7', target: { __ref: 'doc', path: 'items/one' },
      },
      journeyId: 'page-2',
      expected: {
        actor: { kind: 'app', journeyId: 'page-2' },
        authLens: { mode: 'app-session' },
        activityListenerId: 'listener-7',
      },
    },
    {
      name: 'transaction read activity group',
      message: {
        t: 'op', id: 'txn-read', method: 'getDoc', path: 'items/one',
        activityGroupKind: 'transaction',
      },
      journeyId: 'page-2',
      expected: {
        actor: { kind: 'app', journeyId: 'page-2' },
        authLens: { mode: 'app-session' },
        activityGroupKind: 'transaction',
      },
    },
  ];

  for (const testCase of cases) {
    it(testCase.name, () => {
      expect(opProvenance(testCase.message, testCase.journeyId)).toEqual(testCase.expected);
    });
  }
});
