import { readdir, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const assetsDirectory = join(scriptDirectory, '..', 'dist', 'assets');
const assetNames = await readdir(assetsDirectory);
const workerName = assetNames.find((name) => /^firebase-messaging-sw-[^.]+\.js$/.test(name));
const applicationBundles = assetNames.filter((name) => name.endsWith('.js') && name !== workerName);

if (applicationBundles.length === 0) {
  throw new Error('No production application bundle was found. Run `npm run build` first.');
}

const applicationSource = (await Promise.all(
  applicationBundles.map((name) => readFile(join(assetsDirectory, name), 'utf8')),
)).join('\n');

// The window SDK shares the error-code string `only-available-in-sw`, so that
// string alone is not evidence that the SW implementation was bundled. The
// push-subscription event handler is unique to the worker implementation.
if (applicationSource.includes('pushsubscriptionchange')) {
  throw new Error('The browser bundle contains Firebase Messaging service-worker-only code.');
}

if (!workerName) {
  throw new Error('The production build did not emit the Firebase Messaging service worker.');
}
const workerSource = await readFile(join(assetsDirectory, workerName), 'utf8');

if (!workerSource.includes('messagingSenderId')) {
  throw new Error('The messaging service worker is missing messagingSenderId configuration.');
}

console.log('Notification build checks passed.');
