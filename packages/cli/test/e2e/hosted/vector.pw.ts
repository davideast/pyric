import { test, expect } from '@playwright/test';
import { startSoakServe } from '../soak/harness.js';

const examples = [
  { name: 'components', value: 'vector([1, -2.5, 3.75])', expected: '{"isVector":true,"values":[1,-2.5,3.75],"equal":true}' },
  { name: 'default empty components', value: 'vector()', expected: '{"isVector":true,"values":[],"equal":true}' },
  { name: 'JSON components', value: "VectorValue.fromJSON({ type: 'firestore/vectorValue/1.0', vectorValues: [0, -1, 2.5] })", expected: '{"isVector":true,"values":[0,-1,2.5],"equal":true}' },
];

for (const transport of [
  { name: 'hosted', flags: ['--hosted', '--no-capture'] },
  { name: 'SharedWorker', flags: ['--no-capture'] },
]) {
  for (const example of examples) {
    test(`${transport.name} vector values retain SDK identity and ${example.name}`, async ({ browser }) => {
      const serve = await startSoakServe({
        flags: transport.flags,
        extraFiles: {
          'firestore.rules': "rules_version = '2'; service cloud.firestore { match /databases/{database}/documents { match /embeddings/first { allow read, write: if true; } } }",
          'index.html': '<button id="write" disabled>Save vector</button><output id="result">Starting</output><script type="module" src="/main.js"></script>',
          'main.js': `
            import { initializeApp } from 'firebase/app';
            import { VectorValue, doc, getDoc, getFirestore, setDoc, vector } from 'firebase/firestore';
            const db = getFirestore(initializeApp({ apiKey: 'demo', projectId: 'demo-hosted' }));
            const result = document.querySelector('#result');
            const writeButton = document.querySelector('#write');
            writeButton.addEventListener('click', async () => {
              try {
                const original = ${example.value};
                const embedding = doc(db, 'embeddings', 'first');
                await setDoc(embedding, { value: original });
                const snapshot = await getDoc(embedding);
                const restored = snapshot.data().value;
                result.textContent = JSON.stringify({
                  isVector: restored instanceof VectorValue,
                  values: restored.toArray(),
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
        await page.getByRole('button', { name: 'Save vector', exact: true }).click();
        await expect(page.locator('#result')).toHaveText(example.expected);
        expect(errors).toEqual([]);
      } finally {
        await context.close();
        await serve.stop();
      }
    });
  }
}
