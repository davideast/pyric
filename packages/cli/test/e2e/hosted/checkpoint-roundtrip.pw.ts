import { once } from 'node:events';
import { connectRemoteSandbox } from '@pyric/cli/remote';
import { expect, test, type Page } from '@playwright/test';
import { startSoakServe } from '../soak/harness.js';
import { startHost } from './host-process.js';

function startCheckpointFixture() {
  return startSoakServe({
    flags: ['--hosted', '--no-capture'],
    extraFiles: {
      'firebase.json': JSON.stringify({ firestore: { rules: 'firestore.rules' },
        database: { rules: 'database.rules.json' }, storage: { rules: 'storage.rules' } }),
      'firestore.rules': `rules_version = '2'; service cloud.firestore {
        match /databases/{database}/documents {
          match /profiles/{uid} { allow read, write: if request.auth.uid == uid
            && request.auth.token.firebase.tenant == 'tenant-blue'
            && request.auth.token.role == 'editor'; }
        }
      }`,
      'database.rules.json': '{"rules":{".read":true,".write":true}}',
      'storage.rules': "rules_version = '2'; service firebase.storage { match /b/{bucket}/o { match /{path=**} { allow read, write: if true; } } }",
      'index.html': '<output id="ready"></output><script type="module" src="/main.js"></script>',
      'main.js': `
        import { initializeApp } from 'firebase/app';
        import { getAuth } from 'firebase/auth';
        const app = initializeApp({ apiKey: 'demo', projectId: 'demo-hosted', storageBucket: 'demo-hosted.appspot.com' });
        getAuth(app).tenantId = 'tenant-blue';
        document.querySelector('#ready').textContent = 'Ready';
      `,
    },
  });
}

async function writeServices(page: Page, uid: string, version: 'saved' | 'changed'): Promise<void> {
  await page.evaluate(async ({ uid, version }) => {
    const { getAuth, updateProfile } = await import('firebase/auth');
    const firestore = await import('firebase/firestore');
    const database = await import('firebase/database');
    const storage = await import('firebase/storage');
    const user = getAuth().currentUser;
    const isSignedOut = user === null;
    if (isSignedOut) throw new Error('Expected the checkpoint owner');
    await user.getIdTokenResult(true);
    await updateProfile(user, { displayName: version });
    await firestore.setDoc(firestore.doc(firestore.getFirestore(), 'profiles', uid), { message: version });
    const isSaved = version === 'saved';
    await database.setWithPriority(database.ref(database.getDatabase(), 'checkpoint/value'), version, isSaved ? 7 : 19);
    const bytes = Uint8Array.of(0, 1, 128, 255, isSaved ? 3 : 8);
    await storage.uploadBytes(storage.ref(storage.getStorage(), 'checkpoint/value.bin'), bytes,
      { contentType: 'application/octet-stream', customMetadata: { version } });
  }, { uid, version });
}

async function readServices(page: Page, uid: string) {
  return page.evaluate(async uid => {
    const { getAuth, reload } = await import('firebase/auth');
    const firestore = await import('firebase/firestore');
    const database = await import('firebase/database');
    const storage = await import('firebase/storage');
    const auth = getAuth();
    const user = auth.currentUser;
    const isSignedOut = user === null;
    if (isSignedOut) throw new Error('Expected the restored checkpoint owner');
    await reload(user);
    const token = await user.getIdTokenResult(true);
    const document = await firestore.getDoc(firestore.doc(firestore.getFirestore(), 'profiles', uid));
    const realtime = await database.get(database.ref(database.getDatabase(), 'checkpoint/value'));
    const object = storage.ref(storage.getStorage(), 'checkpoint/value.bin');
    return {
      firestore: document.data(),
      rtdb: { value: realtime.val(), priority: realtime.priority },
      storage: { bytes: Array.from(new Uint8Array(await storage.getBytes(object))), metadata: await storage.getMetadata(object) },
      auth: { uid: auth.currentUser?.uid, tenant: auth.currentUser?.tenantId,
        displayName: auth.currentUser?.displayName, role: token.claims.role, version: token.claims.checkpointVersion },
    };
  }, uid);
}

test('a restored hosted checkpoint durably preserves Firestore, Auth, RTDB and Storage SDK state', async ({ page }) => {
  const fixture = await startCheckpointFixture();
  try {
    await page.goto(fixture.info.url);
    await expect(page.locator('#ready')).toHaveText('Ready');
    const uid = await page.evaluate(async () => {
      const { createUserWithEmailAndPassword, getAuth } = await import('firebase/auth');
      const { user } = await createUserWithEmailAndPassword(getAuth(), 'checkpoint@example.test', 'fixture-password');
      return user.uid;
    });
    const control = await connectRemoteSandbox({ url: fixture.info.url });
    let saved;
    try {
      await control.auth.updateUser(uid, { customClaims: { role: 'editor', checkpointVersion: 'saved' } });
      await writeServices(page, uid, 'saved');
      saved = await readServices(page, uid);
      expect(saved).toMatchObject({ firestore: { message: 'saved' }, rtdb: { value: 'saved', priority: 7 },
        storage: { bytes: [0, 1, 128, 255, 3] },
        auth: { uid, tenant: 'tenant-blue', displayName: 'saved', role: 'editor', version: 'saved' } });
      const savedAccounts = await control.auth.listUsers();
      await control.channel.op({ method: 'checkpoint', name: 'all-services' });
      await control.auth.updateUser(uid, { customClaims: { role: 'editor', checkpointVersion: 'changed' } });
      await writeServices(page, uid, 'changed');
      expect(await readServices(page, uid)).not.toEqual(saved);
      await control.channel.op({ method: 'restore', name: 'all-services' });
      expect(await control.auth.listUsers()).toEqual(savedAccounts);
      expect(await readServices(page, uid)).toEqual(saved);
    } finally {
      control.close();
    }
    await page.goto('about:blank');
    const exited = once(fixture.child, 'exit');
    fixture.child.kill('SIGKILL');
    await exited;
    const replacement = startHost(fixture.dir, fixture.info.port);
    try {
      expect(await replacement.startup, replacement.stderr()).toEqual({ kind: 'ready' });
      await page.goto(fixture.info.url);
      await expect(page.locator('#ready')).toHaveText('Ready');
      await page.evaluate(async () => {
        const { getAuth, signInWithEmailAndPassword } = await import('firebase/auth');
        await signInWithEmailAndPassword(getAuth(), 'checkpoint@example.test', 'fixture-password');
      });
      expect(await readServices(page, uid)).toEqual(saved);
    } finally {
      await replacement.stop();
    }
  } finally {
    await page.close();
    await fixture.stop();
  }
});
