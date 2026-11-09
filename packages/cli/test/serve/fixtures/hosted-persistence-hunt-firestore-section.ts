import assert from 'node:assert/strict';
import { join } from 'node:path';
import { bundleRecords, serializeToBuckets } from 'pyric/sandbox';
import { decodeImportBundle } from 'pyric/sandbox/internal';
import { createHostedPersistence } from '../../../src/serve/hosted/persistence.js';

const root = process.argv[2];

const alice = {
  uid: 'u1',
  email: 'alice@example.com',
  emailVerified: false,
  isAnonymous: false,
  providerData: [],
};

// 1. Clearing Firestore via writeSection('firestore', null) preserves Auth & non-Firestore services.
{
  const project = join(root, 'preserve-auth-on-clear');
  const persistence = await createHostedPersistence(project);
  try {
    await persistence.state.writeSection('auth', { users: [alice] });
    await persistence.state.writeSection(
      'firestore',
      JSON.parse(bundleRecords(serializeToBuckets({ 'posts/first': { title: 'Hello' } }, {}, 0))),
    );
    // Auth survived writing a Firestore bundle whose services map omitted auth.
    assert.deepEqual(persistence.state.readSection('auth'), { users: [alice] });
    const withDocs = decodeImportBundle(JSON.stringify(persistence.state.readSection('firestore')));
    assert.deepEqual(withDocs.firestore, { 'posts/first': { title: 'Hello' } });

    // Clearing Firestore removes all document buckets while keeping Auth intact.
    await persistence.state.writeSection('firestore', null);
    assert.deepEqual(persistence.state.readSection('auth'), { users: [alice] });
    const clearedDocs = decodeImportBundle(JSON.stringify(persistence.state.readSection('firestore')));
    assert.deepEqual(clearedDocs.firestore, {});
  } finally {
    persistence.close();
  }

  const reopened = await createHostedPersistence(project);
  try {
    assert.deepEqual(reopened.state.readSection('auth'), { users: [alice] });
  } finally {
    reopened.close();
  }
}

// 2. Clearing Auth preserves Firestore docs; clearing last remaining section leaves store empty.
{
  const project = join(root, 'clear-auth-then-firestore');
  const persistence = await createHostedPersistence(project);
  try {
    await persistence.state.writeSection('auth', { users: [alice] });
    await persistence.state.writeSection(
      'firestore',
      JSON.parse(bundleRecords(serializeToBuckets({ 'notes/one': { count: 1 } }, {}, 0))),
    );
    await persistence.state.writeSection('auth', null);
    assert.equal(persistence.state.readSection('auth'), null);
    const remainingDocs = decodeImportBundle(JSON.stringify(persistence.state.readSection('firestore')));
    assert.deepEqual(remainingDocs.firestore, { 'notes/one': { count: 1 } });

    await persistence.state.writeSection('firestore', null);
    assert.equal(persistence.state.readSection('firestore'), null);
    assert.equal(persistence.state.readSection('auth'), null);
    assert.equal(persistence.state.exists(), false);
  } finally {
    persistence.close();
  }
}

// 3. Seeding a promoted snapshot preserves services.auth.history (tokensValidAfterMs, deletedUids),
//    sessions, clockMs, and providers when writeSection('auth', ...) runs after writeSection('firestore', ...).
{
  const project = join(root, 'preserve-auth-history-on-seed');
  const persistence = await createHostedPersistence(project);
  try {
    const authServicePayload = {
      users: [alice],
      providers: { 'google.com': false },
      history: {
        tokensValidAfterMs: { u1: 1_700_000_500_000 },
        deletedUids: ['u-deleted'],
      },
      sessions: { '[DEFAULT]': { uid: 'u1', signedInAtMs: 1_700_000_000_000 } },
      clockMs: 1_700_000_500_000,
    };
    const firestoreSection = JSON.parse(
      bundleRecords(
        serializeToBuckets({ 'items/one': { status: 'active' } }, { auth: authServicePayload }, 0),
      ),
    );
    await persistence.state.seed({
      version: 1,
      firestore: firestoreSection,
      auth: { users: [alice] },
      storage: [],
    });
    const decoded = decodeImportBundle(JSON.stringify(persistence.state.readSection('firestore')));
    assert.deepEqual(decoded.services.auth, authServicePayload);
  } finally {
    persistence.close();
  }
}

console.log('Firestore section isolation passed');
