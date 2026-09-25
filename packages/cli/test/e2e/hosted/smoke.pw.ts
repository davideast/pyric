import { expect, test } from '@playwright/test';
import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { cliPath, createHostedProject, startHost, type HostedProject } from './harness.js';

const appHtml = `<!doctype html>
<html>
  <head><title>Hosted Smoke Fixture</title></head>
  <body>
    <output id="status">Loading</output>
    <script type="module" src="/main.js"></script>
  </body>
</html>`;

const appJs = `
import { initializeApp } from 'firebase/app';
import { getAuth, signInAnonymously, createUserWithEmailAndPassword, signInWithEmailAndPassword } from 'firebase/auth';
import { getFirestore, doc, getDoc, setDoc } from 'firebase/firestore';
import { getStorage, ref, uploadBytes, getBytes, getDownloadURL, getMetadata, deleteObject } from 'firebase/storage';

const app = initializeApp({ projectId: 'hosted-smoke' });
const auth = getAuth(app);
const db = getFirestore(app);
const storage = getStorage(app);

window.__smoke = {
  auth,
  db,
  storage,
  signInAnonymously: () => signInAnonymously(auth),
  createUser: (email, password) => createUserWithEmailAndPassword(auth, email, password),
  signInUser: (email, password) => signInWithEmailAndPassword(auth, email, password),
  getFirestoreDoc: async (path) => {
    const snap = await getDoc(doc(db, path));
    return snap.exists() ? snap.data() : null;
  },
  setFirestoreDoc: (path, data) => setDoc(doc(db, path), data),
  uploadStorageBytes: async (path, text) => {
    const bytes = new TextEncoder().encode(text);
    return uploadBytes(ref(storage, path), bytes);
  },
  // A WAV of silence: 44.1 kHz, 16-bit stereo, long enough that a seek near its end needs a range request.
  uploadWav: async (path, seconds) => {
    const rate = 44100, channels = 2, bytesPerSample = 2;
    const dataSize = seconds * rate * channels * bytesPerSample;
    const wav = new Uint8Array(44 + dataSize);
    const view = new DataView(wav.buffer);
    const ascii = (offset, text) => { for (let i = 0; i < text.length; i++) wav[offset + i] = text.charCodeAt(i); };
    ascii(0, 'RIFF'); view.setUint32(4, 36 + dataSize, true); ascii(8, 'WAVE');
    ascii(12, 'fmt '); view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, channels, true);
    view.setUint32(24, rate, true); view.setUint32(28, rate * channels * bytesPerSample, true);
    view.setUint16(32, channels * bytesPerSample, true); view.setUint16(34, 16, true);
    ascii(36, 'data'); view.setUint32(40, dataSize, true);
    await uploadBytes(ref(storage, path), wav, { contentType: 'audio/wav' });
    return getDownloadURL(ref(storage, path));
  },
  storageDownloadURL: (path) => getDownloadURL(ref(storage, path)),
  // An app keeps a download URL, then deletes the object by a reference to it.
  deleteByUrl: async (url) => {
    const kept = ref(storage, url);
    await deleteObject(kept);
    return kept.fullPath;
  },
  storageObjectExists: async (path) => {
    try {
      await getMetadata(ref(storage, path));
      return true;
    } catch (error) {
      if (error.code === 'storage/object-not-found') return false;
      throw error;
    }
  },
  downloadStorageText: async (path) => {
    try {
      const bytes = await getBytes(ref(storage, path));
      return new TextDecoder().decode(bytes);
    } catch {
      return null;
    }
  },
};

document.getElementById('status').textContent = 'Ready';
`;

test.describe('Node host smoke set (#688)', () => {
  let project: HostedProject;

  test.beforeEach(() => {
    project = createHostedProject({
      'index.html': appHtml,
      'main.js': appJs,
    });
  });

  test.afterEach(() => {
    project.cleanup();
  });

  test('1. pyric sandbox --hosted -- <child> starts and /__pyric/health reports sandboxConnected: true with no page open', async () => {
    const host = startHost(project.dir, {
      passthrough: ['node', '-e', 'setInterval(() => {}, 1000)'],
    });

    try {
      const ready = await host.startup;
      if (ready.kind === 'exit') {
        throw new Error(`Host exited with code ${ready.code}. Stderr: ${ready.stderr}\nStdout: ${ready.stdout}`);
      }
      expect(ready.kind).toBe('ready');
      if (ready.kind !== 'ready') return;

      const healthRes = await fetch(`${ready.url}/__pyric/health`);
      expect(healthRes.ok).toBe(true);
      const health = (await healthRes.json()) as { sandboxConnected?: boolean; mode?: string };
      expect(health.sandboxConnected).toBe(true);
      expect(health.mode).toBe('sandbox');
    } finally {
      await host.stop();
    }
  });

  test('2. a page and a firebase-admin child read each other\'s Firestore writes', async ({ page }) => {
    const childScript = `
import { initializeApp } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';

initializeApp();
const db = getFirestore();

// 1. Admin writes a doc:
await db.collection('smoke').doc('from-admin').set({ message: 'Hello from admin Firestore' });

// 2. Admin polls for browser's write:
const deadline = Date.now() + 25000;
while (Date.now() < deadline) {
  const snap = await db.collection('smoke').doc('from-browser').get();
  if (snap.exists && snap.data()?.message === 'Hello from browser Firestore') {
    await db.collection('smoke').doc('admin-saw-browser').set({ confirmed: true });
    break;
  }
  await new Promise((r) => setTimeout(r, 100));
}

setInterval(() => {}, 1000);
`;
    project = createHostedProject({
      'index.html': appHtml,
      'main.js': appJs,
      'child.mjs': childScript,
    });

    const host = startHost(project.dir, {
      passthrough: ['node', 'child.mjs'],
    });

    try {
      const ready = await host.startup;
      expect(ready.kind).toBe('ready');
      if (ready.kind !== 'ready') return;

      await page.goto(ready.url);
      await expect(page.locator('#status')).toHaveText('Ready');
      await page.evaluate(() => window.__smoke.signInAnonymously());

      // 1. Browser reads admin's write
      await expect.poll(async () => {
        return page.evaluate(() => window.__smoke.getFirestoreDoc('smoke/from-admin'));
      }).toEqual({ message: 'Hello from admin Firestore' });

      // 2. Browser writes doc for admin to observe
      await page.evaluate(() => window.__smoke.setFirestoreDoc('smoke/from-browser', {
        message: 'Hello from browser Firestore',
      }));

      // 3. Admin confirms observing browser's write
      await expect.poll(async () => {
        return page.evaluate(() => window.__smoke.getFirestoreDoc('smoke/admin-saw-browser'));
      }).toEqual({ confirmed: true });
    } finally {
      await page.close();
      await host.stop();
    }
  });

  test('3. Storage upload from one, download from the other', async ({ page }) => {
    const childScript = `
import { initializeApp } from 'firebase-admin/app';
import { getStorage } from 'firebase-admin/storage';
import { getFirestore } from 'firebase-admin/firestore';

initializeApp();
const bucket = getStorage().bucket();
const db = getFirestore();

// 1. Admin uploads to Storage:
await bucket.file('admin-file.txt').save(Buffer.from('hello-storage-from-admin'));

// 2. Admin waits for browser to upload 'browser-file.txt':
const deadline = Date.now() + 25000;
while (Date.now() < deadline) {
  try {
    const [downloaded] = await bucket.file('browser-file.txt').download();
    if (downloaded.toString() === 'hello-storage-from-browser') {
      await db.collection('smoke').doc('storage-confirmed').set({ confirmed: true });
      break;
    }
  } catch {
    // wait for upload
  }
  await new Promise((r) => setTimeout(r, 100));
}

setInterval(() => {}, 1000);
`;
    project = createHostedProject({
      'index.html': appHtml,
      'main.js': appJs,
      'child.mjs': childScript,
    });

    const host = startHost(project.dir, {
      passthrough: ['node', 'child.mjs'],
    });

    try {
      const ready = await host.startup;
      expect(ready.kind).toBe('ready');
      if (ready.kind !== 'ready') return;

      await page.goto(ready.url);
      await expect(page.locator('#status')).toHaveText('Ready');
      await page.evaluate(() => window.__smoke.signInAnonymously());

      // 1. Browser downloads admin's uploaded file
      await expect.poll(async () => {
        return page.evaluate(() => window.__smoke.downloadStorageText('admin-file.txt'));
      }).toBe('hello-storage-from-admin');

      // 2. Browser uploads file for admin to download
      await page.evaluate(() => window.__smoke.uploadStorageBytes('browser-file.txt', 'hello-storage-from-browser'));

      // 3. Admin confirms successful download via Firestore
      await expect.poll(async () => {
        return page.evaluate(() => window.__smoke.getFirestoreDoc('smoke/storage-confirmed'));
      }).toEqual({ confirmed: true });
    } finally {
      await page.close();
      await host.stop();
    }
  });

  test('4. stop the host, start it again: Firestore, Auth users, and Storage objects are restored', async ({ page }) => {
    // --- Run 1: Write state ---
    const host1 = startHost(project.dir);
    try {
      const ready1 = await host1.startup;
      expect(ready1.kind).toBe('ready');
      if (ready1.kind !== 'ready') return;

      await page.goto(ready1.url);
      await expect(page.locator('#status')).toHaveText('Ready');

      // Create Auth user
      await page.evaluate(() => window.__smoke.createUser('durable-user@example.com', 'DurablePass123!'));

      // Write Firestore document
      await page.evaluate(() => window.__smoke.setFirestoreDoc('durable-collection/doc-1', {
        title: 'Durable Post',
        count: 42,
      }));

      // Upload Storage object
      await page.evaluate(() => window.__smoke.uploadStorageBytes('durable.txt', 'Durable storage text content'));
    } finally {
      await page.close();
      await host1.stop();
    }

    // --- Run 2: Restart host on SAME project directory ---
    const host2 = startHost(project.dir);
    const newPage = await page.context().newPage();
    try {
      const ready2 = await host2.startup;
      expect(ready2.kind).toBe('ready');
      if (ready2.kind !== 'ready') return;

      await newPage.goto(ready2.url);
      await expect(newPage.locator('#status')).toHaveText('Ready');

      // 1. Auth user persists across restart
      const userCredential = await newPage.evaluate(async () => {
        const res = await window.__smoke.signInUser('durable-user@example.com', 'DurablePass123!');
        return { email: res.user.email, uid: res.user.uid };
      });
      expect(userCredential.email).toBe('durable-user@example.com');
      expect(userCredential.uid).toBeTruthy();

      // 2. Firestore doc persists across restart
      const docData = await newPage.evaluate(() => window.__smoke.getFirestoreDoc('durable-collection/doc-1'));
      expect(docData).toEqual({
        title: 'Durable Post',
        count: 42,
      });

      // 3. Storage object persists across restart
      const storageContent = await newPage.evaluate(() => window.__smoke.downloadStorageText('durable.txt'));
      expect(storageContent).toBe('Durable storage text content');
    } finally {
      await newPage.close();
      await host2.stop();
    }
  });

  test('5. a second host in the same project is refused; an in-process pyric mcp is not', async () => {
    const host1 = startHost(project.dir);
    try {
      const ready1 = await host1.startup;
      expect(ready1.kind).toBe('ready');
      if (ready1.kind !== 'ready') return;

      // 1. Second host in the same project directory is refused
      const host2 = startHost(project.dir);
      const exit2 = await host2.startup;
      expect(exit2.kind).toBe('exit');
      if (exit2.kind === 'exit') {
        expect(exit2.code).not.toBe(0);
      }
      expect(host2.stderr()).toContain('already owns');

      // 2. An in-process pyric mcp is NOT refused
      const mcpChild = spawn(process.execPath, [cliPath, 'mcp', '--in-process'], {
        cwd: project.dir,
        env: { ...process.env, CI: '1' },
        stdio: ['pipe', 'pipe', 'pipe'],
      });

      try {
        const mcpStartup = Promise.withResolvers<{ jsonrpc: string; id: number; result?: unknown }>();
        let mcpOut = '';
        mcpChild.stdout.setEncoding('utf8').on('data', (chunk: string) => {
          mcpOut += chunk;
          const lines = mcpOut.split('\n');
          for (const line of lines) {
            const trimmed = line.trim();
            if (trimmed.startsWith('{')) {
              try {
                const parsed = JSON.parse(trimmed);
                if (parsed.id === 1) mcpStartup.resolve(parsed);
              } catch {
                // partial line
              }
            }
          }
        });

        // Send MCP initialize
        mcpChild.stdin.write(
          JSON.stringify({
            jsonrpc: '2.0',
            id: 1,
            method: 'initialize',
            params: {
              protocolVersion: '2024-11-05',
              capabilities: {},
              clientInfo: { name: 'smoke-test', version: '1.0' },
            },
          }) + '\n',
        );

        const initResponse = await Promise.race([
          mcpStartup.promise,
          new Promise((_, reject) => setTimeout(() => reject(new Error('MCP init timed out')), 5000)),
        ]);
        expect(initResponse).toMatchObject({ jsonrpc: '2.0', id: 1 });
      } finally {
        mcpChild.kill('SIGTERM');
      }
    } finally {
      await host1.stop();
    }
  });

  test('6. Studio at /__pyric/ui/studio connects and makes no failed request', async ({ page }) => {
    const host = startHost(project.dir);
    try {
      const ready = await host.startup;
      expect(ready.kind).toBe('ready');
      if (ready.kind !== 'ready') return;

      const failedRequests: Array<{ url: string; status: number }> = [];
      page.on('response', (response) => {
        if (response.status() >= 400) {
          failedRequests.push({ url: response.url(), status: response.status() });
        }
      });

      const studioUrl = ready.uiUrl ?? `${ready.url}/__pyric/ui/studio/`;
      const response = await page.goto(studioUrl);
      expect(response?.status()).toBe(200);

      await expect(page.getByRole('link', { name: 'Firestore', exact: true }).first()).toBeVisible();
      await expect(page.getByRole('link', { name: 'Auth', exact: true }).first()).toBeVisible();
      await expect(page.getByRole('heading', { name: 'Studio is unavailable' })).toHaveCount(0);

      expect(failedRequests).toEqual([]);
    } finally {
      await page.close();
      await host.stop();
    }
  });

  test('7. --fresh archives the old state and starts empty', async ({ page }) => {
    // --- Run 1: Write initial state ---
    const host1 = startHost(project.dir);
    try {
      const ready1 = await host1.startup;
      expect(ready1.kind).toBe('ready');
      if (ready1.kind !== 'ready') return;

      await page.goto(ready1.url);
      await expect(page.locator('#status')).toHaveText('Ready');
      await page.evaluate(() => window.__smoke.signInAnonymously());
      await page.evaluate(() => window.__smoke.setFirestoreDoc('fresh-test/doc-1', { value: 'initial-doc' }));
    } finally {
      await page.close();
      await host1.stop();
    }

    const stateDir = join(project.dir, '.pyric', 'state');
    const hostedDbPath = join(stateDir, 'hosted', 'state.sqlite');
    expect(existsSync(hostedDbPath)).toBe(true);

    // --- Run 2: Start with --fresh ---
    const host2 = startHost(project.dir, { flags: ['--hosted', '--fresh'] });
    const newPage = await page.context().newPage();
    try {
      const ready2 = await host2.startup;
      expect(ready2.kind).toBe('ready');
      if (ready2.kind !== 'ready') return;

      // Check that an archive was created in .pyric/state
      const stateEntries = readdirSync(stateDir);
      const archiveFound = stateEntries.some((entry) => entry.startsWith('hosted.archive-'));
      expect(archiveFound).toBe(true);

      // Check that the new database starts empty
      await newPage.goto(ready2.url);
      await expect(newPage.locator('#status')).toHaveText('Ready');
      await newPage.evaluate(() => window.__smoke.signInAnonymously());
      const docData = await newPage.evaluate(() => window.__smoke.getFirestoreDoc('fresh-test/doc-1'));
      expect(docData).toBeNull();
    } finally {
      await newPage.close();
      await host2.stop();
    }
  });

  test('8. an <audio> element streams and seeks a hosted object by its download URL', async ({ page }) => {
    const host = startHost(project.dir, { passthrough: ['node', '-e', 'setInterval(() => {}, 1000)'] });
    try {
      const ready = await host.startup;
      expect(ready.kind).toBe('ready');
      if (ready.kind !== 'ready') return;
      const objectResponses: Array<{ status: number; contentRange: string | null }> = [];
      page.on('response', response => {
        const onRoute = response.url().includes('/__pyric/storage/v0/b/') && response.request().method() === 'GET';
        if (onRoute) objectResponses.push({ status: response.status(), contentRange: response.headers()['content-range'] ?? null });
      });
      await page.goto(ready.url);
      await expect(page.locator('#status')).toHaveText('Ready');
      await page.evaluate(() => window.__smoke.signInAnonymously());
      const url = await page.evaluate(() => window.__smoke.uploadWav('media/take.wav', 60));
      expect(new URL(url).pathname).toBe('/__pyric/storage/v0/b/pyric-default/o/media%2Ftake.wav');
      expect(new URL(url).searchParams.get('token')).toMatch(/^[0-9a-f-]{36}$/);

      // The element loads the object by URL alone, then seeks near its end.
      const played = await page.evaluate(async (source) => {
        const audio = document.createElement('audio');
        audio.preload = 'metadata';
        audio.src = source;
        document.body.append(audio);
        await new Promise((resolve, reject) => {
          audio.addEventListener('loadedmetadata', resolve, { once: true });
          audio.addEventListener('error', () => reject(new Error(`audio error ${audio.error?.code}`)), { once: true });
        });
        const duration = audio.duration;
        await new Promise(resolve => { audio.addEventListener('seeked', resolve, { once: true }); audio.currentTime = 55; });
        return { duration, currentTime: audio.currentTime };
      }, url);
      expect(played.duration).toBeCloseTo(60, 0);
      expect(played.currentTime).toBeCloseTo(55, 0);
      // The seek was served as a range from well into the object.
      const partial = objectResponses.filter(entry => entry.status === 206);
      expect(partial.length).toBeGreaterThan(0);
      const lateStart = partial.some(entry => Number(/^bytes (\d+)-/.exec(entry.contentRange ?? '')?.[1] ?? 0) > 1_000_000);
      expect(lateStart, JSON.stringify(objectResponses)).toBe(true);
    } finally {
      await host.stop();
    }
  });

  test('9. deleteObject(ref(storage, downloadURL)) deletes the hosted object', async ({ page }) => {
    const host = startHost(project.dir, { passthrough: ['node', '-e', 'setInterval(() => {}, 1000)'] });
    try {
      const ready = await host.startup;
      expect(ready.kind).toBe('ready');
      if (ready.kind !== 'ready') return;
      await page.goto(ready.url);
      await expect(page.locator('#status')).toHaveText('Ready');
      await page.evaluate(() => window.__smoke.signInAnonymously());
      await page.evaluate(() => window.__smoke.uploadStorageBytes('media/kept.txt', 'kept by its URL'));
      const url = await page.evaluate(() => window.__smoke.storageDownloadURL('media/kept.txt'));
      expect(new URL(url).pathname).toBe('/__pyric/storage/v0/b/pyric-default/o/media%2Fkept.txt');
      expect((await page.request.get(url)).status()).toBe(200);

      const deletedPath = await page.evaluate((kept) => window.__smoke.deleteByUrl(kept), url);
      expect(deletedPath).toBe('media/kept.txt');
      expect(await page.evaluate(() => window.__smoke.storageObjectExists('media/kept.txt'))).toBe(false);
      expect((await page.request.get(url)).status()).toBe(404);
    } finally {
      await host.stop();
    }
  });
});
