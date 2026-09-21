import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';
import { createServer, type ViteDevServer } from 'vite';
import { pyric } from '../../dist/vite.js';

const app = `
import { initializeApp } from 'firebase/app';
import { getFirestore, collection, collectionGroup, doc, setDoc, getDoc, getDocs,
  addDoc, query, where, onSnapshot } from 'firebase/firestore';

const db = getFirestore(initializeApp({ projectId: 'served-converters' }));

const itemConverter = {
  toFirestore: (item) => ({ label: item.label.toUpperCase() }),
  fromFirestore: (snapshot) => ({ id: snapshot.id, label: String(snapshot.data().label ?? ''), converted: true }),
};

function firstDelivery(target) {
  let stop;
  const delivered = new Promise((resolve, reject) => {
    stop = onSnapshot(target, resolve, reject);
  });
  return delivered.finally(() => stop());
}

window.runConverterFlows = async () => {
  const items = collection(db, 'items').withConverter(itemConverter);
  const itemRef = doc(items, 'one');
  await setDoc(itemRef, { id: 'one', label: 'hello', converted: true });
  const single = (await getDoc(itemRef)).data();

  const q = query(items, where('label', '==', 'HELLO'));
  const snapshot = await getDocs(q);
  const queried = snapshot.docs[0].data();
  const queriedRefKeepsConverter = snapshot.docs[0].ref.converter === itemConverter;

  const documentDelivery = (await firstDelivery(itemRef)).data();
  const queryDelivery = (await firstDelivery(q)).docs.map((item) => item.data());

  const added = await addDoc(items, { id: 'ignored', label: 'added', converted: true });
  const addedLabel = (await getDoc(added)).data().label;

  await setDoc(doc(db, 'rooms/r1/items/nested'), { label: 'NESTED' });
  const group = collectionGroup(db, 'items').withConverter(itemConverter);
  const groupLabels = (await getDocs(group)).docs.map((item) => item.data().label).sort();

  const untyped = items.withConverter(null);
  const rawStored = (await getDoc(doc(untyped, 'one'))).data();

  const notes = collection(doc(items, 'one'), 'notes');
  const subcollectionConverter = notes.converter ?? null;

  return { single, queried, queriedRefKeepsConverter, documentDelivery, queryDelivery,
    addedLabel, groupLabels, rawStored, subcollectionConverter };
};
document.querySelector('#status').textContent = 'Ready';
`;

const rules = `rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /items/{id} { allow read, write: if true; }
    match /rooms/{room}/items/{id} { allow read, write: if true; }
    match /{document=**} { allow read: if request.auth == null; }
  }
}`;

for (const hosted of [false, true]) {
  test(`served collections and queries carry converters (${hosted ? 'Node' : 'SharedWorker'})`, async ({ page }) => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'pyric-converters-')));
    let server: ViteDevServer | undefined;
    try {
      writeFileSync(join(root, 'index.html'), '<output id="status">Starting</output><script type="module" src="/main.js"></script>');
      writeFileSync(join(root, 'main.js'), app);
      writeFileSync(join(root, 'firestore.rules'), rules);
      server = await createServer({ root, configFile: false, logLevel: 'silent',
        plugins: [pyric({ hosted, capture: false, ui: false })],
        server: { host: '127.0.0.1', port: 0 },
      });
      await server.listen();
      const url = server.resolvedUrls?.local[0];
      const missingUrl = url === undefined;
      if (missingUrl) throw new Error('Vite did not expose a URL');
      await page.goto(url);
      await expect(page.locator('#status')).toHaveText('Ready');
      const result = await page.evaluate(() => Reflect.get(window, 'runConverterFlows')());
      const converted = { id: 'one', label: 'HELLO', converted: true };
      expect(result).toEqual({
        single: converted,
        queried: converted,
        queriedRefKeepsConverter: true,
        documentDelivery: converted,
        queryDelivery: [converted],
        addedLabel: 'ADDED',
        groupLabels: ['ADDED', 'HELLO', 'NESTED'],
        rawStored: { label: 'HELLO' },
        subcollectionConverter: null,
      });
    } finally {
      await page.close();
      await server?.close();
      rmSync(root, { recursive: true, force: true });
    }
  });
}
