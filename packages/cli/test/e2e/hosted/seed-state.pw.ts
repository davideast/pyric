import { expect, test, type Page } from '@playwright/test';
import { startSoakServe } from '../soak/harness.js';
import type { PyricRuntimeMode } from '../../../src/serve/runtime/status.js';

async function seedStartupOutcome(fixture: unknown): Promise<string> {
  try {
    const serve = await startSoakServe({
      flags: ['--hosted', '--no-capture', '--seed', 'fixture.json'],
      extraFiles: { 'fixture.json': JSON.stringify(fixture) },
    });
    await serve.stop();
    return 'CLI became ready';
  } catch (error) {
    const isError = error instanceof Error;
    if (isError) return error.message;
    throw error;
  }
}

test('hosted CLI refuses a state fixture whose auth users are not an array', async () => {
  const outcome = await seedStartupOutcome({ version: 1, firestore: null, auth: { users: {} } });

  expect(outcome).toContain('auth.users: Expected array, received object');
});

test('hosted CLI refuses an unsupported fixture version instead of treating it as document data', async () => {
  const outcome = await seedStartupOutcome({ version: 99, firestore: null, auth: null });

  expect(outcome).toContain('has version 99; this @pyric/cli expects 1');
});

async function verifySeededAccount(page: Page, runtimeFlags: string[], expectedMode: PyricRuntimeMode): Promise<void> {
  page.on('pageerror', (error) => console.error(`Seeded SDK fixture: ${error.message}`));
  const fixture = {
    version: 1,
    firestore: null,
    auth: { users: [{
      uid: 'seeded-reader',
      email: 'reader@example.test',
      password: 'fixture-password',
      displayName: 'Seeded Reader',
      photoUrl: 'https://example.test/avatar.svg',
      emailVerified: true,
      providerId: 'password',
      tenantId: 'tenant-blue',
      customClaims: { role: 'editor' },
    }] },
  };
  const serve = await startSoakServe({
    flags: [...runtimeFlags, '--no-capture', '--seed', 'fixture.json'],
    extraFiles: {
      'fixture.json': JSON.stringify(fixture),
      'index.html': '<!doctype html><html><head></head><body><pre id="identity">Loading</pre><script type="module" src="/main.js"></script></body></html>',
      'firestore.rules': `rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /proof/{id} {
      allow read, write: if request.auth.uid == 'seeded-reader'
        && request.auth.token.role == 'editor'
        && request.auth.token.firebase.tenant == 'tenant-blue';
    }
  }
}`,
      'main.js': `
import { initializeApp } from 'firebase/app';
import { getAuth, signInWithEmailAndPassword, getIdTokenResult } from 'firebase/auth';
import { getFirestore, doc, getDoc, setDoc } from 'firebase/firestore';
const output = document.querySelector('#identity');
try {
  const app = initializeApp({ apiKey: 'demo', projectId: 'demo-hosted' });
  const auth = getAuth(app);
  auth.tenantId = 'tenant-blue';
  const { user } = await signInWithEmailAndPassword(auth, 'reader@example.test', 'fixture-password');
  const token = await getIdTokenResult(user);
  const reference = doc(getFirestore(app), 'proof', 'seeded-account');
  await setDoc(reference, { message: 'Authorized' });
  const snapshot = await getDoc(reference);
  output.textContent = JSON.stringify({
    uid: user.uid, displayName: user.displayName, photoURL: user.photoURL,
    emailVerified: user.emailVerified, tenantId: user.tenantId,
    role: token.claims.role, message: snapshot.data().message,
  });
} catch (error) {
  output.textContent = 'Failed: ' + error.message;
}
`,
    },
  });
  try {
    await page.goto(serve.info.url);
    await expect.poll(() => page.evaluate(() => globalThis.__pyricRuntime?.getSnapshot().mode)).toBe(expectedMode);
    await expect(page.locator('#identity')).toHaveText(JSON.stringify({
      uid: 'seeded-reader',
      displayName: 'Seeded Reader',
      photoURL: 'https://example.test/avatar.svg',
      emailVerified: true,
      tenantId: 'tenant-blue',
      role: 'editor',
      message: 'Authorized',
    }));
  } finally {
    await serve.stop();
  }
}

test('a seeded account keeps its profile and authorizes SDK work with its tenant and claims', async ({ page }) => {
  await verifySeededAccount(page, ['--hosted'], 'hosted');
});

test('SharedWorker accounts expose seeded identity and claims through normal SDK imports', async ({ page }) => {
  await verifySeededAccount(page, [], 'shared-worker');
});

test('in-page accounts expose seeded identity and claims through normal SDK imports', async ({ page }) => {
  await page.addInitScript(() => {
    Object.assign(globalThis, { __PYRIC_FORCE_INPAGE__: true });
  });
  await verifySeededAccount(page, [], 'in-page');
});
