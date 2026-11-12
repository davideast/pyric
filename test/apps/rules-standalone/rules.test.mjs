import { readFileSync } from 'node:fs';
import { describe, test } from 'node:test';
import { assertCase, firestoreRules, rtdbRules, storageRules } from '@pyric/rules';

const read = (file) => readFileSync(new URL(file, import.meta.url), 'utf8');

describe('firestore.rules', () => {
  const rules = firestoreRules(read('./firestore.rules'));
  const cases = [
    {
      description: 'an owner reads their note',
      expectation: 'ALLOW',
      method: 'get',
      path: 'notes/n1',
      auth: { uid: 'alice' },
      resource: { owner: 'alice', text: 'hi' },
    },
    {
      description: 'another user cannot read it',
      expectation: 'DENY',
      method: 'get',
      path: 'notes/n1',
      auth: { uid: 'bob' },
      resource: { owner: 'alice', text: 'hi' },
    },
    {
      description: 'a signed-in user creates a note they own',
      expectation: 'ALLOW',
      method: 'create',
      path: 'notes/n2',
      auth: { uid: 'alice' },
      data: { owner: 'alice', text: 'new' },
    },
    {
      description: 'nobody creates a note for someone else',
      expectation: 'DENY',
      method: 'create',
      path: 'notes/n3',
      auth: { uid: 'bob' },
      data: { owner: 'alice', text: 'forged' },
    },
  ];
  for (const c of cases) test(c.description, () => assertCase(rules, c));
});

describe('storage.rules', () => {
  const rules = storageRules(read('./storage.rules'), { bucket: 'demo-app.appspot.com' });
  const cases = [
    {
      description: 'a user uploads a small image as their avatar',
      expectation: 'ALLOW',
      method: 'create',
      path: 'avatars/alice/me.png',
      auth: { uid: 'alice' },
      requestResource: { size: 2048, contentType: 'image/png' },
    },
    {
      description: 'an avatar upload that is not an image is denied',
      expectation: 'DENY',
      method: 'create',
      path: 'avatars/alice/notes.txt',
      auth: { uid: 'alice' },
      requestResource: { size: 2048, contentType: 'text/plain' },
    },
    {
      description: 'nobody uploads into another user\'s folder',
      expectation: 'DENY',
      method: 'create',
      path: 'avatars/alice/me.png',
      auth: { uid: 'bob' },
      requestResource: { size: 2048, contentType: 'image/png' },
    },
    {
      description: 'a signed-out visitor cannot read an avatar',
      expectation: 'DENY',
      method: 'get',
      path: 'avatars/alice/me.png',
      resource: { size: 2048, contentType: 'image/png' },
    },
  ];
  for (const c of cases) test(c.description, () => assertCase(rules, c));
});

describe('database.rules.json', () => {
  const rules = rtdbRules(read('./database.rules.json'));
  const cases = [
    {
      description: 'a user writes their own profile',
      expectation: 'ALLOW',
      operation: 'write',
      path: '/profiles/alice',
      auth: 'alice',
      newData: { name: 'Alice' },
    },
    {
      description: 'a profile without a name fails validation',
      expectation: 'DENY',
      operation: 'write',
      path: '/profiles/alice',
      auth: 'alice',
      newData: { bio: 'no name' },
    },
    {
      description: 'nobody writes another user\'s profile',
      expectation: 'DENY',
      operation: 'write',
      path: '/profiles/alice',
      auth: 'bob',
      newData: { name: 'Mallory' },
    },
    {
      description: 'a signed-out visitor cannot read profiles',
      expectation: 'DENY',
      operation: 'read',
      path: '/profiles/alice',
      auth: null,
    },
  ];
  for (const c of cases) test(c.description, () => assertCase(rules, c));
});
