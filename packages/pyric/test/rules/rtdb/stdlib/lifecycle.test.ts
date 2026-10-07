import { describe, expect, test } from 'bun:test';
import { all, any, authenticated, isNew, ownPath, rtdbStdlib } from 'pyric/rules';
import { runScenario, type StdlibScenario } from './harness.js';

const { lifecycle, validation } = rtdbStdlib;

const scenario: StdlibScenario = {
  paths: {
    '/notes/$noteId': {
      read: authenticated(),
      write: lifecycle.ownedBy('owner'),
      validate: lifecycle.immutableFields('createdAt'),
    },
    '/receipts/$id': { write: all(authenticated(), lifecycle.createOnly()), ...validation.shape({ amount: 'number' }) },
    '/ledger/$id': { write: all(authenticated(), lifecycle.noDelete()), validate: validation.isNumber() },
    '/profiles/$uid': {
      write: all(ownPath('$uid'), any(isNew(), lifecycle.onlyFieldsChanged(['name', 'bio'], ['name', 'bio', 'role']))),
    },
    '/drafts/$id': {
      write: all(authenticated(), lifecycle.exactlyChanged(['body', 'rev'], ['body', 'rev', 'title'])),
    },
  },
  cases: [],
};

const note = { notes: { n1: { owner: 'alice', createdAt: 1, title: 'a' } } };
const profile = { profiles: { alice: { name: 'Al', bio: 'hi', role: 'member' } } };
const draft = { drafts: { d1: { body: 'x', rev: 1, title: 't' } } };

scenario.cases.push(
  { description: 'a user creates a note they own', expectation: 'ALLOW', operation: 'write', path: '/notes/n1', auth: 'alice', newData: { owner: 'alice', createdAt: 1, title: 'a' } },
  { description: 'a user creates a note owned by someone else', expectation: 'DENY', operation: 'write', path: '/notes/n1', auth: 'alice', newData: { owner: 'bob', createdAt: 1, title: 'a' } },
  { description: 'the owner edits the title', expectation: 'ALLOW', operation: 'update', path: '/notes/n1', auth: 'alice', data: note, newData: { title: 'b' } },
  { description: 'another user edits the title', expectation: 'DENY', operation: 'update', path: '/notes/n1', auth: 'bob', data: note, newData: { title: 'b' } },
  { description: 'the owner hands the note to another user', expectation: 'DENY', operation: 'update', path: '/notes/n1', auth: 'alice', data: note, newData: { owner: 'bob' } },
  { description: 'the owner deletes the note', expectation: 'ALLOW', operation: 'write', path: '/notes/n1', auth: 'alice', data: note, newData: null },
  { description: 'another user deletes the note', expectation: 'DENY', operation: 'write', path: '/notes/n1', auth: 'bob', data: note, newData: null },
  { description: 'the owner changes the immutable createdAt', expectation: 'DENY', operation: 'update', path: '/notes/n1', auth: 'alice', data: note, newData: { createdAt: 2 } },
  { description: 'a receipt is written once', expectation: 'ALLOW', operation: 'write', path: '/receipts/r1', auth: 'alice', newData: { amount: 3 } },
  { description: 'a receipt is overwritten', expectation: 'DENY', operation: 'write', path: '/receipts/r1', auth: 'alice', data: { receipts: { r1: { amount: 3 } } }, newData: { amount: 4 } },
  { description: 'a receipt is deleted', expectation: 'DENY', operation: 'write', path: '/receipts/r1', auth: 'alice', data: { receipts: { r1: { amount: 3 } } }, newData: null },
  { description: 'a ledger entry is updated', expectation: 'ALLOW', operation: 'write', path: '/ledger/l1', auth: 'alice', data: { ledger: { l1: 1 } }, newData: 2 },
  { description: 'a ledger entry is deleted', expectation: 'DENY', operation: 'write', path: '/ledger/l1', auth: 'alice', data: { ledger: { l1: 1 } }, newData: null },
  { description: 'a profile edit changes the allowed fields', expectation: 'ALLOW', operation: 'update', path: '/profiles/alice', auth: 'alice', data: profile, newData: { name: 'Alice', bio: 'hello' } },
  { description: 'a profile edit changes one allowed field', expectation: 'ALLOW', operation: 'update', path: '/profiles/alice', auth: 'alice', data: profile, newData: { bio: 'hello' } },
  { description: 'a profile edit changes the role', expectation: 'DENY', operation: 'update', path: '/profiles/alice', auth: 'alice', data: profile, newData: { role: 'admin' } },
  { description: 'a draft edit changes body and rev', expectation: 'ALLOW', operation: 'update', path: '/drafts/d1', auth: 'alice', data: draft, newData: { body: 'y', rev: 2 } },
  { description: 'a draft edit changes body without rev', expectation: 'DENY', operation: 'update', path: '/drafts/d1', auth: 'alice', data: draft, newData: { body: 'y' } },
  { description: 'a draft edit also changes the title', expectation: 'DENY', operation: 'update', path: '/drafts/d1', auth: 'alice', data: draft, newData: { body: 'y', rev: 2, title: 'u' } },
);

describe('rtdbStdlib.lifecycle', () => {
  test('unchanged compares each field before and after', () => {
    expect(lifecycle.unchanged('a', 'b')).toBe(
      "newData.child('a').val() == data.child('a').val() && newData.child('b').val() == data.child('b').val()",
    );
  });

  test('immutableFields allows the create', () => {
    expect(lifecycle.immutableFields('createdAt')).toBe(
      "!data.exists() || newData.child('createdAt').val() == data.child('createdAt').val()",
    );
  });

  test('onlyFieldsChanged and exactlyChanged refuse a changed field outside the field list', () => {
    expect(() => lifecycle.onlyFieldsChanged(['x'], ['a', 'b'])).toThrow();
    expect(() => lifecycle.exactlyChanged(['x'], ['a'])).toThrow();
  });

  test('createOnly and noDelete', () => {
    expect(lifecycle.createOnly()).toBe('!data.exists() && newData.exists()');
    expect(lifecycle.noDelete()).toBe('newData.exists()');
  });

  runScenario(scenario);
});
