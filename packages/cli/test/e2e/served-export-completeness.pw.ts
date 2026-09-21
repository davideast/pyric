import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';
import { createServer, type ViteDevServer } from 'vite';
import { pyric } from '../../dist/vite.js';

const app = `
import { initializeApp, initializeServerApp } from 'firebase/app';
import { linkWithPopup, RecaptchaVerifier } from 'firebase/auth';
import { doc, collection, getFirestore, refEqual, queryEqual, snapshotEqual, loadBundle, FieldPath, documentId, getDocs, query, where } from 'firebase/firestore';
import { getDatabase } from 'firebase/database';
import { getStream, StringFormat } from 'firebase/storage';
import { getMessaging } from 'firebase/messaging';
import { getLiveGenerativeModel, LiveSession } from 'firebase/ai';
const db = getFirestore(initializeApp({ projectId: 'export-test' }));
const other = getFirestore(initializeApp({ projectId: 'export-test' }, 'other'));
const converter = { toFirestore: value => value, fromFirestore: snapshot => snapshot.data() };
const a = doc(db, 'users/one');
const converted = a.withConverter(converter);
const queryResults = await Promise.all([
  getDocs(query(collection(db, 'users'), where(documentId(), '==', 'one'))),
  getDocs(query(collection(db, 'users'), where(new FieldPath('score'), '==', 7))),
]);
window.exportProbe = {
  queryResults: queryResults.map(snapshot => snapshot.docs.map(item => item.id)),
  imported: [initializeServerApp, linkWithPopup, loadBundle, getDatabase, getStream, getMessaging, getLiveGenerativeModel].every(value => typeof value === 'function'),
  instanceChecks: [{} instanceof RecaptchaVerifier, {} instanceof LiveSession],
  format: StringFormat.BASE64,
  equality: [
    refEqual(a, doc(db, 'users/one')),
    refEqual(a, doc(db, 'users/two')),
    refEqual(a, doc(other, 'users/one')),
    refEqual(converted, a.withConverter(converter)),
    refEqual(converted, a),
    refEqual(converted, a.withConverter({ ...converter })),
    refEqual(collection(db, 'users'), collection(db, 'users')),
    refEqual(collection(db, 'users'), collection(other, 'users')),
  ],
  unavailable: [queryEqual, snapshotEqual].map(fn => {
    try { fn(a, a); } catch (error) { return { code: error.code, message: error.message }; }
  }),
};
document.getElementById('app').textContent = 'Imports ready';
`;

for (const hosted of [false, true]) {
  test(`served exports load and reference equality preserves identity (${hosted ? 'Node' : 'SharedWorker'})`, async ({ page }) => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'pyric-exports-')));
    let server: ViteDevServer | undefined;
    try {
      writeFileSync(join(root, 'index.html'), '<div id="app"></div><script type="module" src="/main.js"></script>');
      writeFileSync(join(root, 'main.js'), app);
      writeFileSync(join(root, 'firestore.rules'), 'service cloud.firestore { match /databases/{database}/documents { match /users/{id} { allow read: if true; } } }');
      writeFileSync(join(root, 'seed.json'), JSON.stringify({ version: 1, firestore: { version: 1, savedAt: 1, firestore: { 'users/one': { score: 7 } } } }));
      server = await createServer({ root, configFile: false, logLevel: 'silent',
        plugins: [pyric({ hosted, capture: false, ui: false, seed: 'seed.json' })],
        server: { host: '127.0.0.1', port: 0 },
      });
      await server.listen();
      const url = server.resolvedUrls?.local[0];
      const missingUrl = url === undefined;
      if (missingUrl) throw new Error('Vite did not expose a URL');
      await page.goto(url);
      await expect(page.locator('#app')).toHaveText('Imports ready');
      const actual = await page.evaluate(() => Reflect.get(window, 'exportProbe'));
      expect(actual.imported).toBe(true);
      expect(actual.queryResults).toEqual([['one'], ['one']]);
      expect(actual.instanceChecks).toEqual([false, false]);
      expect(actual.format).toBe('base64');
      expect(actual.equality).toEqual([true, false, false, true, false, false, true, false]);
      for (const [index, name] of ['queryEqual', 'snapshotEqual'].entries()) {
        expect(actual.unavailable[index].code).toBe('firestore/unsupported-in-served-mode');
        expect(actual.unavailable[index].message).toContain(name);
      }
    } finally {
      await page.close();
      await server?.close();
      rmSync(root, { recursive: true, force: true });
    }
  });
}
