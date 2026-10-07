import { describe, expect, test } from 'bun:test';
import { all, rtdbStdlib } from 'pyric/rules';
import { runScenario, type StdlibScenario } from './harness.js';

const { membership, lifecycle } = rtdbStdlib;

const scenario: StdlibScenario = {
  paths: {
    // Messages in a room: only its members read and post.
    '/rooms/$roomId/messages/$msgId': {
      read: membership.memberOf(['members', { $: 'auth.uid' }], { levelsUp: 2 }),
      write: all(membership.memberOf(['members', { $: 'auth.uid' }], { levelsUp: 2 }), lifecycle.createOnly()),
      validate: 'newData.isString()',
    },
    // The member list: a user adds or removes only themself.
    '/rooms/$roomId/members/$uid': {
      write: membership.selfMembership('$uid'),
      validate: membership.memberFlag(),
    },
  },
  cases: [],
};

const room = { rooms: { r1: { members: { alice: true, bob: false } } } };

scenario.cases.push(
  { description: 'a member posts', expectation: 'ALLOW', operation: 'write', path: '/rooms/r1/messages/m1', auth: 'alice', data: room, newData: 'hi' },
  { description: 'a user stored as false posts', expectation: 'DENY', operation: 'write', path: '/rooms/r1/messages/m1', auth: 'bob', data: room, newData: 'hi' },
  { description: 'a user not in the list posts', expectation: 'DENY', operation: 'write', path: '/rooms/r1/messages/m1', auth: 'carol', data: room, newData: 'hi' },
  { description: 'a signed-out user posts', expectation: 'DENY', operation: 'write', path: '/rooms/r1/messages/m1', auth: null, data: room, newData: 'hi' },
  { description: 'a member reads the messages', expectation: 'ALLOW', operation: 'read', path: '/rooms/r1/messages/m1', auth: 'alice', data: room },
  { description: 'a user not in the list reads the messages', expectation: 'DENY', operation: 'read', path: '/rooms/r1/messages/m1', auth: 'carol', data: room },
  { description: 'a user joins and posts in one write', expectation: 'DENY', operation: 'update', path: '/rooms/r1', auth: 'carol', data: room, newData: { 'members/carol': true, 'messages/m2': 'hi' } },
  { description: 'a user adds themself', expectation: 'ALLOW', operation: 'write', path: '/rooms/r1/members/carol', auth: 'carol', data: room, newData: true },
  { description: 'a user removes themself', expectation: 'ALLOW', operation: 'write', path: '/rooms/r1/members/alice', auth: 'alice', data: room, newData: null },
  { description: 'a user adds someone else', expectation: 'DENY', operation: 'write', path: '/rooms/r1/members/dave', auth: 'carol', data: room, newData: true },
  { description: 'a user adds themself with a string', expectation: 'DENY', operation: 'write', path: '/rooms/r1/members/carol', auth: 'carol', data: room, newData: 'yes' },
);

describe('rtdbStdlib.membership', () => {
  test('memberOf reads the list through data, not root', () => {
    expect(membership.memberOf(['members', { $: 'auth.uid' }], { levelsUp: 2 })).toBe(
      "auth != null && data.parent().parent().child('members').child(auth.uid).val() == true",
    );
    expect(membership.memberOf(['rooms', { $: '$roomId' }, 'members', { $: 'auth.uid' }])).toBe(
      "auth != null && root.child('rooms').child($roomId).child('members').child(auth.uid).val() == true",
    );
  });

  test('builders refuse input they cannot compile', () => {
    expect(() => membership.memberOf([])).toThrow();
    expect(() => membership.selfMembership('uid')).toThrow();
  });

  runScenario(scenario);
});
