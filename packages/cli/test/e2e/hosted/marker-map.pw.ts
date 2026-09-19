import { test, expect } from '@playwright/test';
import { startSoakServe } from '../soak/harness.js';

const examples = [
  { name: 'an SDK-shaped map with extra fields', value: "{ type: 'firestore/geoPoint/1.0', latitude: 10.25, longitude: -20.75, label: 'literal' }", expected: '{"type":"firestore/geoPoint/1.0","latitude":10.25,"longitude":-20.75,"label":"literal"}' },
  { name: 'an exact SDK marker map', value: "{ type: 'firestore/geoPoint/1.0', latitude: 10.25, longitude: -20.75 }", expected: '{"type":"firestore/geoPoint/1.0","latitude":10.25,"longitude":-20.75}' },
  { name: 'a rules marker map', value: "{ __type: 'bytes', base64: 'AP8', label: 'literal' }", expected: '{"__type":"bytes","base64":"AP8","label":"literal"}' },
  { name: 'a vector marker map', value: "{ __type__: '__vector__', value: [1, 2] }", expected: '{"__type__":"__vector__","value":[1,2]}' },
  { name: 'an escaped-map-shaped user map', value: "{ type: 'pyric/map/1.0', fields: { type: 'firestore/bytes/1.0', bytes: 'AP8=', label: 'nested' } }", expected: '{"type":"pyric/map/1.0","fields":{"type":"firestore/bytes/1.0","bytes":"AP8=","label":"nested"}}' },
  { name: 'unknown markers and nested array maps', value: "{ type: 'future/scalar/9', values: [{ __type: 'timestamp', seconds: 12, nanos: 34, label: 'nested' }] }", expected: '{"type":"future/scalar/9","values":[{"__type":"timestamp","seconds":12,"nanos":34,"label":"nested"}]}' },
];

for (const transport of [
  { name: 'hosted', flags: ['--hosted', '--no-capture'] },
  { name: 'SharedWorker', flags: ['--no-capture'] },
]) {
  for (const example of examples) {
    test(`${transport.name} preserves ${example.name} beside a real SDK value`, async ({ browser }) => {
      const serve = await startSoakServe({
        flags: transport.flags,
        extraFiles: {
          'firestore.rules': "rules_version = '2'; service cloud.firestore { match /databases/{database}/documents { match /places/first { allow read: if true; allow write: if request.resource.data.payload is map && request.resource.data.location is latlng; } } }",
          'index.html': '<button id="write" disabled>Save map</button><output id="result">Starting</output><script type="module" src="/main.js"></script>',
          'main.js': `
            import { initializeApp } from 'firebase/app';
            import { GeoPoint, doc, getDoc, getFirestore, setDoc } from 'firebase/firestore';
            const db = getFirestore(initializeApp({ apiKey: 'demo', projectId: 'demo-hosted' }));
            const result = document.querySelector('#result');
            const writeButton = document.querySelector('#write');
            writeButton.addEventListener('click', async () => {
              try {
                const place = doc(db, 'places', 'first');
                await setDoc(place, {
                  payload: ${example.value},
                  location: new GeoPoint(1, 2),
                });
                const snapshot = await getDoc(place);
                const restored = snapshot.data();
                result.textContent = JSON.stringify({
                  payloadIsPlainMap: Object.getPrototypeOf(restored.payload) === Object.prototype,
                  payload: restored.payload,
                  locationIsGeoPoint: restored.location instanceof GeoPoint,
                  latitude: restored.location.latitude,
                  longitude: restored.location.longitude,
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
        await page.getByRole('button', { name: 'Save map', exact: true }).click();
        await expect(page.locator('#result')).toHaveText('{"payloadIsPlainMap":true,"payload":' + example.expected + ',"locationIsGeoPoint":true,"latitude":1,"longitude":2}');
        expect(errors).toEqual([]);
      } finally {
        await context.close();
        await serve.stop();
      }
    });
  }
}
