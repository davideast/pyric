import { test, expect } from '@playwright/test';
import { startSoakServe } from '../soak/harness.js';

const examples = [
  { name: 'coordinates', value: 'new GeoPoint(10.25, -20.75)', expected: '{"isGeoPoint":true,"latitude":10.25,"longitude":-20.75,"equal":true}' },
  { name: 'zero coordinates', value: 'new GeoPoint(0, 0)', expected: '{"isGeoPoint":true,"latitude":0,"longitude":0,"equal":true}' },
  { name: 'minimum coordinates', value: 'new GeoPoint(-90, -180)', expected: '{"isGeoPoint":true,"latitude":-90,"longitude":-180,"equal":true}' },
  { name: 'maximum coordinates', value: 'new GeoPoint(90, 180)', expected: '{"isGeoPoint":true,"latitude":90,"longitude":180,"equal":true}' },
  { name: 'JSON coordinates', value: "GeoPoint.fromJSON({ type: 'firestore/geoPoint/1.0', latitude: -45.5, longitude: 120.25 })", expected: '{"isGeoPoint":true,"latitude":-45.5,"longitude":120.25,"equal":true}' },
];

for (const transport of [
  { name: 'hosted', flags: ['--hosted', '--no-capture'] },
  { name: 'SharedWorker', flags: ['--no-capture'] },
]) {
  for (const example of examples) {
    test(`${transport.name} GeoPoint values retain SDK identity and ${example.name}`, async ({ browser }) => {
      const serve = await startSoakServe({
        flags: transport.flags,
        extraFiles: {
          'firestore.rules': "rules_version = '2'; service cloud.firestore { match /databases/{database}/documents { match /places/first { allow read: if true; allow write: if request.resource.data.location is latlng; } } }",
          'index.html': '<button id="write" disabled>Save location</button><output id="result">Starting</output><script type="module" src="/main.js"></script>',
          'main.js': `
            import { initializeApp } from 'firebase/app';
            import { GeoPoint, doc, getDoc, getFirestore, setDoc } from 'firebase/firestore';
            const db = getFirestore(initializeApp({ apiKey: 'demo', projectId: 'demo-hosted' }));
            const result = document.querySelector('#result');
            const writeButton = document.querySelector('#write');
            writeButton.addEventListener('click', async () => {
              try {
                const original = ${example.value};
                const place = doc(db, 'places', 'first');
                await setDoc(place, { location: original });
                const snapshot = await getDoc(place);
                const restored = snapshot.data().location;
                result.textContent = JSON.stringify({
                  isGeoPoint: restored instanceof GeoPoint,
                  latitude: restored.latitude,
                  longitude: restored.longitude,
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
        await page.getByRole('button', { name: 'Save location', exact: true }).click();
        await expect(page.locator('#result')).toHaveText(example.expected);
        expect(errors).toEqual([]);
      } finally {
        await context.close();
        await serve.stop();
      }
    });
  }
}
