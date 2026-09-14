import { once } from 'node:events';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { CLI_PATH, startSoakServe, type SoakServe } from '../soak/harness.js';
import { startHost } from './host-process.js';

/** Normal SDK imports shared by Storage persistence and overlap scenarios. */
export function startStoragePersistenceFixture(flags = ['--hosted', '--no-capture']) {
  return startSoakServe({
    flags,
    extraFiles: {
      'firebase.json': '{"storage":{"rules":"storage.rules"}}',
      'storage.rules': "rules_version = '2'; service firebase.storage { match /b/{bucket}/o { match /{path=**} { allow read, write: if true; } } }",
      'index.html': '<output id="ready">Starting</output><label>Value<input id="value"></label><button id="save">Save</button><output id="saved"></output><button id="read">Read</button><output id="value-read"></output><button id="list">List files</button><output id="files"></output><script type="module" src="/main.js"></script>',
      'main.js': `
        import { initializeApp } from 'firebase/app';
        import { getBytes, getStorage, listAll, ref, uploadBytes } from 'firebase/storage';
        const app = initializeApp({ apiKey: 'demo', projectId: 'demo-hosted', storageBucket: 'demo-hosted.appspot.com' });
        const storage = getStorage(app);
        const reference = ref(storage, 'files/shared.txt');
        await listAll(ref(storage, 'files'));
        document.querySelector('#ready').textContent = 'Ready';
        document.querySelector('#save').onclick = async () => {
          try {
            const value = document.querySelector('#value').value;
            await uploadBytes(reference, new TextEncoder().encode(value), { contentType: 'text/plain' });
            document.querySelector('#saved').textContent = 'Saved';
          } catch (error) {
            document.querySelector('#saved').textContent = error.code;
          }
        };
        document.querySelector('#read').onclick = async () => {
          const bytes = await getBytes(reference);
          document.querySelector('#value-read').textContent = new TextDecoder().decode(bytes);
        };
        document.querySelector('#list').onclick = async () => {
          const listing = await listAll(ref(storage, 'files'));
          document.querySelector('#files').textContent = JSON.stringify(listing.items.map(item => item.fullPath));
        };
      `,
    },
  });
}

/** Delay one platform binary read without replacing a host collaborator. */
export async function startHostWithPausedStorageRead(fixture: SoakServe) {
  // Reboot this real CLI with a fault at the platform binary-I/O boundary.
  const firstExit = once(fixture.child, 'exit');
  fixture.child.kill('SIGTERM');
  await firstExit;
  const preload = join(fixture.dir, 'pause-blob-read.mjs');
  writeFileSync(preload, `
    import { subscribe } from 'node:diagnostics_channel';
    subscribe('http.server.request.start', ({ request }) => {
      const isPipelineEnd = request.headers['x-pyric-test-pipeline-end'] === '1';
      if (isPipelineEnd) process.stderr.write('HTTP pipeline received\\n');
    });
    const readBytes = Blob.prototype.arrayBuffer;
    const release = Promise.withResolvers();
    let paused = false;
    process.on('SIGUSR2', () => release.resolve());
    Blob.prototype.arrayBuffer = async function () {
      const bytes = await readBytes.call(this);
      const pausesThisRead = !paused && this.type === 'text/plain';
      if (pausesThisRead) {
        paused = true;
        process.stderr.write('Storage binary read paused\\n');
        await release.promise;
      }
      return bytes;
    };
  `);
  return startHost(fixture.dir, fixture.info.port, [process.execPath, '--import', preload, CLI_PATH]);
}
