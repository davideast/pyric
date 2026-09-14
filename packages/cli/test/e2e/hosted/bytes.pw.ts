import { test, expect } from '@playwright/test';
import { startSoakServe } from '../soak/harness.js';

const examples = [
  {
    name: 'binary content',
    value: 'Bytes.fromUint8Array(new Uint8Array([0, 127, 128, 254, 255]))',
    expected: '{"isBytes":true,"content":[0,127,128,254,255],"base64":"AH+A/v8=","equal":true}',
  },
  {
    name: 'empty content',
    value: 'Bytes.fromUint8Array(new Uint8Array([]))',
    expected: '{"isBytes":true,"content":[],"base64":"","equal":true}',
  },
  {
    name: 'one-byte content with two padding characters',
    value: "Bytes.fromBase64String('AA==')",
    expected: '{"isBytes":true,"content":[0],"base64":"AA==","equal":true}',
  },
  {
    name: 'two-byte content with one padding character',
    value: "Bytes.fromBase64String('AP8=')",
    expected: '{"isBytes":true,"content":[0,255],"base64":"AP8=","equal":true}',
  },
  {
    name: 'three-byte JSON content without padding',
    value: "Bytes.fromJSON({ type: 'firestore/bytes/1.0', bytes: 'AID/' })",
    expected: '{"isBytes":true,"content":[0,128,255],"base64":"AID/","equal":true}',
  },
];

for (const transport of [
  { name: 'hosted', flags: ['--hosted', '--no-capture'] },
  { name: 'SharedWorker', flags: ['--no-capture'] },
]) {
  for (const example of examples) {
    test(`${transport.name} bytes retain SDK identity and ${example.name}`, async ({ browser }) => {
      const serve = await startSoakServe({
        flags: transport.flags,
        extraFiles: {
          'firestore.rules': "rules_version = '2'; service cloud.firestore { match /databases/{database}/documents { match /files/first { allow read: if true; allow write: if request.resource.data.payload is bytes; } } }",
          'index.html': '<button id="write" disabled>Save bytes</button><output id="result">Starting</output><script type="module" src="/main.js"></script>',
          'main.js': `
            import { initializeApp } from 'firebase/app';
            import { Bytes, doc, getDoc, getFirestore, setDoc } from 'firebase/firestore';
            const db = getFirestore(initializeApp({ apiKey: 'demo', projectId: 'demo-hosted' }));
            const result = document.querySelector('#result');
            const writeButton = document.querySelector('#write');
            writeButton.addEventListener('click', async () => {
              try {
                const original = ${example.value};
                const file = doc(db, 'files', 'first');
                await setDoc(file, { payload: original });
                const snapshot = await getDoc(file);
                const restored = snapshot.data().payload;
                result.textContent = JSON.stringify({
                  isBytes: restored instanceof Bytes,
                  content: Array.from(restored.toUint8Array()),
                  base64: restored.toBase64(),
                  equal: restored.isEqual(original),
                });
              } catch (error) {
                result.textContent = error.code + ': ' + error.message;
              }
            });
            writeButton.disabled = false;
            result.textContent = 'Ready';
          `,
        },
      });
      const context = await browser.newContext();
      try {
        const page = await context.newPage();
        const errors: string[] = [];
        page.on('pageerror', (error) => errors.push(error.message));
        await page.goto(serve.info.url);
        await expect(page.locator('#result')).toHaveText('Ready');
        await page.getByRole('button', { name: 'Save bytes', exact: true }).click();
        await expect(page.locator('#result')).toHaveText(example.expected);
        expect(errors).toEqual([]);
      } finally {
        await context.close();
        await serve.stop();
      }
    });
  }
}
