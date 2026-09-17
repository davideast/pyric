import { setPersistenceWritable } from './persistence-fault.js';
import { once } from 'node:events';
import { join } from 'node:path';
import { connectRemoteSandbox, type RemoteSandboxChannel } from '@pyric/cli/remote';
import { expect, test } from '@playwright/test';
import { startSoakServe } from '../soak/harness.js';
import { startHost } from './host-process.js';

function startAuthFixture(flags = ['--hosted', '--no-capture']) {
  return startSoakServe({
    flags,
    extraFiles: {
      'firebase.json': '{"firestore":{"rules":"firestore.rules"}}',
      'firestore.rules': `rules_version = '2'; service cloud.firestore {
        match /databases/{database}/documents {
          match /profiles/{uid} {
            allow read, write: if request.auth.uid == uid
              && request.auth.token.firebase.tenant == 'tenant-blue';
          }
        }
      }`,
      'index.html': '<output id="ready">Starting</output><label>Email<input id="email" value="reader@example.test"></label><button id="create">Create account</button><button id="signin">Sign in</button><output id="result"></output><output id="uid"></output><output id="tenant"></output><button id="save">Save profile</button><button id="read">Read profile</button><output id="profile"></output><script type="module" src="/main.js"></script>',
      'main.js': `
        import { initializeApp } from 'firebase/app';
        import { createUserWithEmailAndPassword, getAuth, inMemoryPersistence,
          setPersistence, signInWithEmailAndPassword } from 'firebase/auth';
        import { doc, getDoc, getFirestore, setDoc } from 'firebase/firestore';
        const app = initializeApp({ apiKey: 'demo', projectId: 'demo-hosted' });
        const auth = getAuth(app);
        const db = getFirestore(app);
        await setPersistence(auth, inMemoryPersistence);
        auth.tenantId = 'tenant-blue';
        document.querySelector('#ready').textContent = 'Ready';
        async function authenticate(signIn) {
          document.querySelector('#result').textContent = 'Pending';
          try {
            const email = document.querySelector('#email').value;
            const { user } = await signIn(auth, email, 'fixture-password');
            document.querySelector('#uid').textContent = user.uid;
            document.querySelector('#tenant').textContent = user.tenantId;
            document.querySelector('#result').textContent = 'Signed in';
          } catch (error) {
            document.querySelector('#result').textContent = error.code;
          }
        }
        document.querySelector('#create').onclick = () => authenticate(createUserWithEmailAndPassword);
        document.querySelector('#signin').onclick = () => authenticate(signInWithEmailAndPassword);
        document.querySelector('#save').onclick = async () => {
          try {
            await setDoc(doc(db, 'profiles', auth.currentUser.uid), { name: 'Reader' });
            document.querySelector('#profile').textContent = 'Saved';
          } catch (error) {
            document.querySelector('#profile').textContent = error.code;
          }
        };
        document.querySelector('#read').onclick = async () => {
          try {
            const snapshot = await getDoc(doc(db, 'profiles', auth.currentUser.uid));
            document.querySelector('#profile').textContent = snapshot.data()?.name ?? 'Missing';
          } catch (error) {
            document.querySelector('#profile').textContent = error.code;
          }
        };
      `,
    },
  });
}

test('an acknowledged Auth account survives host termination with its tenant and rules identity', async ({ browser }) => {
  const fixture = await startAuthFixture();
  const writer = await browser.newPage();
  try {
    await writer.goto(fixture.info.url);
    await expect(writer.locator('#ready')).toHaveText('Ready');
    await writer.getByRole('button', { name: 'Create account', exact: true }).click();
    await expect(writer.locator('#result')).toHaveText('Signed in');
    await expect(writer.locator('#uid')).toHaveText(/\S+/);
    const uid = await writer.locator('#uid').innerText();
    await expect(writer.locator('#tenant')).toHaveText('tenant-blue');

    const exit = once(fixture.child, 'exit');
    fixture.child.kill('SIGKILL');
    await exit;
    await writer.close();
    const replacement = startHost(fixture.dir, fixture.info.port);
    try {
      expect(await replacement.startup, replacement.stderr()).toEqual({ kind: 'ready' });
      const reader = await browser.newPage();
      try {
        await reader.goto(fixture.info.url);
        await expect(reader.locator('#ready')).toHaveText('Ready');
        await reader.getByRole('button', { name: 'Sign in', exact: true }).click();
        await expect(reader.locator('#result')).toHaveText('Signed in');
        await expect(reader.locator('#uid')).toHaveText(uid);
        await expect(reader.locator('#tenant')).toHaveText('tenant-blue');
        await reader.getByRole('button', { name: 'Save profile', exact: true }).click();
        await expect(reader.locator('#profile')).toHaveText('Saved');
        await reader.getByRole('button', { name: 'Read profile', exact: true }).click();
        await expect(reader.locator('#profile')).toHaveText('Reader');
      } finally {
        await reader.close();
      }
    } finally {
      await replacement.stop();
    }
  } finally {
    await writer.close();
    await fixture.stop();
  }
});

test('an unhealthy host refuses account creation before changing the Auth user pool', async ({ page }) => {
  const fixture = await startAuthFixture();
  const stateDirectory = join(fixture.dir, '.pyric', 'state');
  try {
    await page.goto(fixture.info.url);
    await expect(page.locator('#ready')).toHaveText('Ready');
    setPersistenceWritable(stateDirectory, false);
    await page.getByRole('button', { name: 'Create account', exact: true }).click();
    await expect(page.locator('#result')).toHaveText('committed-but-not-durable');

    await page.getByLabel('Email', { exact: true }).fill('refused@example.test');
    await page.getByRole('button', { name: 'Create account', exact: true }).click();
    await expect(page.locator('#result')).toHaveText('persistence-unhealthy');
    await page.getByRole('button', { name: 'Sign in', exact: true }).click();
    await expect(page.locator('#result')).toHaveText('auth/user-not-found');

    await page.getByLabel('Email', { exact: true }).fill('reader@example.test');
    await page.getByRole('button', { name: 'Sign in', exact: true }).click();
    await expect(page.locator('#result')).toHaveText('Signed in');
    await expect(page.locator('#tenant')).toHaveText('tenant-blue');
  } finally {
    setPersistenceWritable(stateDirectory, true);
    await fixture.stop();
  }
});

for (const operation of ['profile', 'email', 'password', 'deletion'] as const) {
  test(`an unhealthy host refuses account ${operation} before changing the existing identity`, async ({ page }) => {
    const fixture = await startAuthFixture();
    const stateDirectory = join(fixture.dir, '.pyric', 'state');
    try {
      await page.goto(fixture.info.url);
      await expect(page.locator('#ready')).toHaveText('Ready');
      await page.getByRole('button', { name: 'Create account', exact: true }).click();
      await expect(page.locator('#result')).toHaveText('Signed in');
      const uid = await page.locator('#uid').innerText();
      setPersistenceWritable(stateDirectory, false);
      await page.getByRole('button', { name: 'Save profile', exact: true }).click();
      await expect(page.locator('#profile')).toHaveText('committed-but-not-durable');

      const outcome = await page.evaluate(async (change) => {
        const { deleteUser, getAuth, updateEmail, updatePassword, updateProfile } = await import('firebase/auth');
        const user = getAuth().currentUser;
        const isSignedOut = user === null;
        if (isSignedOut) throw new Error('The fixture must have a signed-in account');
        try {
          switch (change) {
            case 'profile': await updateProfile(user, { displayName: 'Must not change' }); break;
            case 'email': await updateEmail(user, 'changed@example.test'); break;
            case 'password': await updatePassword(user, 'changed-password'); break;
            case 'deletion': await deleteUser(user); break;
          }
          return 'acknowledged';
        } catch (error) {
          const hasCode = error instanceof Error && 'code' in error;
          if (hasCode) return String(error.code);
          throw error;
        }
      }, operation);
      expect(outcome).toBe('persistence-unhealthy');

      const identity = await page.evaluate(async () => {
        const { getAuth, signInWithEmailAndPassword, signOut } = await import('firebase/auth');
        const auth = getAuth();
        await signOut(auth);
        const { user } = await signInWithEmailAndPassword(auth, 'reader@example.test', 'fixture-password');
        return { uid: user.uid, tenantId: user.tenantId, email: user.email, displayName: user.displayName };
      });
      expect(identity).toEqual({ uid, tenantId: 'tenant-blue', email: 'reader@example.test', displayName: null });
    } finally {
      setPersistenceWritable(stateDirectory, true);
      await fixture.stop();
    }
  });
}

const userPoolMutations = [
  { method: 'auth.signInAnonymously' },
  { method: 'auth.signInWithCredential', credential: { providerId: 'google.com', uid: 'new-provider-user', email: 'provider@example.test' } },
  { method: 'auth.acceptIdentity', identity: { uid: 'new-provider-user', email: 'provider@example.test', displayName: 'Provider', photoURL: null, customClaims: {}, providerId: 'google.com' } },
  { method: 'auth.adminCreateUser', request: { uid: 'new-admin-user', email: 'admin@example.test', password: 'fixture-password' } },
  { method: 'auth.adminUpdateUser', uid: 'existing-reader', request: { displayName: 'Must not change' } },
  { method: 'auth.adminDeleteUser', uid: 'existing-reader' },
  { method: 'auth.adminClearUsers' },
] satisfies Parameters<RemoteSandboxChannel['op']>[0][];

for (const operation of userPoolMutations) {
  test(`an unhealthy host refuses ${operation.method} before changing the shared user pool`, async () => {
    const fixture = await startAuthFixture();
    const stateDirectory = join(fixture.dir, '.pyric', 'state');
    try {
      const remote = await connectRemoteSandbox({ url: fixture.info.url });
      try {
        await remote.auth.createUser({ uid: 'existing-reader', email: 'reader@example.test', password: 'fixture-password' });
        setPersistenceWritable(stateDirectory, false);
        await expect(remote.auth.updateUser('existing-reader', { displayName: 'Committed in memory' }))
          .rejects.toMatchObject({ code: 'committed-but-not-durable' });
        const usersBefore = await remote.auth.listUsers();
        expect(usersBefore).toMatchObject([{ uid: 'existing-reader', displayName: 'Committed in memory' }]);

        await expect(remote.channel.op(operation)).rejects.toMatchObject({ code: 'persistence-unhealthy' });
        await expect(remote.auth.listUsers()).resolves.toEqual(usersBefore);
      } finally {
        remote.close();
      }
    } finally {
      setPersistenceWritable(stateDirectory, true);
      await fixture.stop();
    }
  });
}
