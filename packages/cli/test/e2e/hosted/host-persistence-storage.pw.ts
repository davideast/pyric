import { once } from 'node:events';
import { chmodSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';
import { startSoakServe } from '../soak/harness.js';
import { startHost } from './host-process.js';

function startStorageFixture(flags = ['--hosted', '--no-capture']) {
  return startSoakServe({
    flags,
    extraFiles: {
      'firebase.json': '{"storage":{"rules":"storage.rules"}}',
      'storage.rules': "rules_version = '2'; service firebase.storage { match /b/{bucket}/o { match /{path=**} { allow read, write: if true; } } }",
      'index.html': '<output id="ready">Starting</output><button id="upload">Upload</button><output id="upload-result"></output><output id="uploaded-metadata"></output><button id="overwrite">Overwrite</button><output id="overwrite-result"></output><button id="delete">Delete</button><output id="delete-result"></output><button id="list">List files</button><output id="files"></output><button id="read">Read bytes</button><output id="bytes"></output><output id="metadata"></output><output id="full-metadata"></output><script type="module" src="/main.js"></script>',
      'main.js': `
        import { initializeApp } from 'firebase/app';
        import { deleteObject, getBytes, getMetadata, getStorage, listAll, ref, uploadBytes } from 'firebase/storage';
        const app = initializeApp({ apiKey: 'demo', projectId: 'demo-hosted', storageBucket: 'demo-hosted.appspot.com' });
        const storage = getStorage(app);
        const reference = ref(storage, 'files/greeting.txt');
        await listAll(ref(storage, 'files'));
        document.querySelector('#ready').textContent = 'Ready';
        document.querySelector('#upload').onclick = async () => {
          try {
            const uploaded = await uploadBytes(reference, new TextEncoder().encode('Stored in memory'), { contentType: 'text/plain', customMetadata: { purpose: 'restart-proof' } });
            document.querySelector('#uploaded-metadata').textContent = JSON.stringify(uploaded.metadata);
            document.querySelector('#upload-result').textContent = 'Uploaded';
          } catch (error) {
            document.querySelector('#upload-result').textContent = error.code;
          }
        };
        document.querySelector('#overwrite').onclick = async () => {
          try {
            await uploadBytes(reference, new TextEncoder().encode('Must not execute'));
            document.querySelector('#overwrite-result').textContent = 'Uploaded';
          } catch (error) {
            document.querySelector('#overwrite-result').textContent = error.code;
          }
        };
        document.querySelector('#delete').onclick = async () => {
          try {
            await deleteObject(reference);
            document.querySelector('#delete-result').textContent = 'Deleted';
          } catch (error) {
            document.querySelector('#delete-result').textContent = error.code;
          }
        };
        document.querySelector('#list').onclick = async () => {
          const listing = await listAll(ref(storage, 'files'));
          document.querySelector('#files').textContent = JSON.stringify(listing.items.map(item => item.fullPath));
        };
        document.querySelector('#read').onclick = async () => {
          const bytes = await getBytes(reference);
          document.querySelector('#bytes').textContent = new TextDecoder().decode(bytes);
          const metadata = await getMetadata(reference);
          document.querySelector('#full-metadata').textContent = JSON.stringify(metadata);
          document.querySelector('#metadata').textContent = JSON.stringify({ contentType: metadata.contentType, size: metadata.size, purpose: metadata.customMetadata?.purpose });
        };
      `,
    },
  });
}

test('a hosted Storage SDK upload reports its committed state when persistence fails', async ({ page }) => {
  const serve = await startStorageFixture();
  const stateDirectory = join(serve.dir, '.pyric', 'state');
  try {
    await page.goto(serve.info.url);
    await expect(page.locator('#ready')).toHaveText('Ready');
    mkdirSync(stateDirectory, { recursive: true });
    chmodSync(stateDirectory, 0o500);
    await page.getByRole('button', { name: 'Upload', exact: true }).click();
    await expect(page.locator('#upload-result')).toHaveText('committed-but-not-durable');
    await page.getByRole('button', { name: 'Read bytes', exact: true }).click();
    await expect(page.locator('#bytes')).toHaveText('Stored in memory');
  } finally {
    chmodSync(stateDirectory, 0o700);
    await serve.stop();
  }
});

test('an unhealthy host refuses a Storage SDK overwrite before changing its bytes', async ({ page }) => {
  const serve = await startStorageFixture();
  const stateDirectory = join(serve.dir, '.pyric', 'state');
  try {
    await page.goto(serve.info.url);
    await expect(page.locator('#ready')).toHaveText('Ready');
    mkdirSync(stateDirectory, { recursive: true });
    chmodSync(stateDirectory, 0o500);
    await page.getByRole('button', { name: 'Upload', exact: true }).click();
    await expect(page.locator('#upload-result')).toHaveText('committed-but-not-durable');
    await page.getByRole('button', { name: 'Overwrite', exact: true }).click();
    await expect(page.locator('#overwrite-result')).toHaveText('persistence-unhealthy');
    await page.getByRole('button', { name: 'Read bytes', exact: true }).click();
    await expect(page.locator('#bytes')).toHaveText('Stored in memory');
  } finally {
    chmodSync(stateDirectory, 0o700);
    await serve.stop();
  }
});

test('a hosted Storage SDK deletion reports its committed state when persistence fails', async ({ page }) => {
  const serve = await startStorageFixture();
  const stateDirectory = join(serve.dir, '.pyric', 'state');
  try {
    await page.goto(serve.info.url);
    await expect(page.locator('#ready')).toHaveText('Ready');
    await page.getByRole('button', { name: 'Upload', exact: true }).click();
    await expect(page.locator('#upload-result')).toHaveText('Uploaded');
    chmodSync(stateDirectory, 0o500);
    await page.getByRole('button', { name: 'Delete', exact: true }).click();
    await expect(page.locator('#delete-result')).toHaveText('committed-but-not-durable');
    await page.getByRole('button', { name: 'List files', exact: true }).click();
    await expect(page.locator('#files')).toHaveText('[]');
  } finally {
    chmodSync(stateDirectory, 0o700);
    await serve.stop();
  }
});

test('an unhealthy host refuses a Storage SDK deletion before removing its bytes', async ({ page }) => {
  const serve = await startStorageFixture();
  const stateDirectory = join(serve.dir, '.pyric', 'state');
  try {
    await page.goto(serve.info.url);
    await expect(page.locator('#ready')).toHaveText('Ready');
    mkdirSync(stateDirectory, { recursive: true });
    chmodSync(stateDirectory, 0o500);
    await page.getByRole('button', { name: 'Upload', exact: true }).click();
    await expect(page.locator('#upload-result')).toHaveText('committed-but-not-durable');
    await page.getByRole('button', { name: 'Delete', exact: true }).click();
    await expect(page.locator('#delete-result')).toHaveText('persistence-unhealthy');
    await page.getByRole('button', { name: 'Read bytes', exact: true }).click();
    await expect(page.locator('#bytes')).toHaveText('Stored in memory');
  } finally {
    chmodSync(stateDirectory, 0o700);
    await serve.stop();
  }
});

test('acknowledged Storage SDK upload and deletion survive immediate host termination', async ({ browser }) => {
  const first = await startStorageFixture();
  const context = await browser.newContext();
  try {
    const writer = await context.newPage();
    await writer.goto(first.info.url);
    await expect(writer.locator('#ready')).toHaveText('Ready');
    await writer.getByRole('button', { name: 'Upload', exact: true }).click();
    await expect(writer.locator('#upload-result')).toHaveText('Uploaded');
    const originalMetadata = await writer.locator('#uploaded-metadata').innerText();
    const firstExit = once(first.child, 'exit');
    first.child.kill('SIGKILL');
    await firstExit;
    await writer.close();

    const replacement = startHost(first.dir, first.info.port);
    try {
      expect(await replacement.startup, replacement.stderr()).toEqual({ kind: 'ready' });
      const reader = await context.newPage();
      await reader.goto(first.info.url);
      await expect(reader.locator('#ready')).toHaveText('Ready');
      await reader.getByRole('button', { name: 'Read bytes', exact: true }).click();
      await expect(reader.locator('#bytes')).toHaveText('Stored in memory');
      await expect(reader.locator('#full-metadata')).toHaveText(originalMetadata);
      await expect(reader.locator('#metadata')).toHaveText('{"contentType":"text/plain","size":16,"purpose":"restart-proof"}');
      await reader.getByRole('button', { name: 'Delete', exact: true }).click();
      await expect(reader.locator('#delete-result')).toHaveText('Deleted');
      const secondExit = once(replacement.child, 'exit');
      replacement.child.kill('SIGKILL');
      await secondExit;
      await reader.close();

      const finalHost = startHost(first.dir, first.info.port);
      try {
        expect(await finalHost.startup, finalHost.stderr()).toEqual({ kind: 'ready' });
        const observer = await context.newPage();
        await observer.goto(first.info.url);
        await expect(observer.locator('#ready')).toHaveText('Ready');
        await observer.getByRole('button', { name: 'List files', exact: true }).click();
        await expect(observer.locator('#files')).toHaveText('[]');
      } finally {
        await finalHost.stop();
      }
    } finally {
      await replacement.stop();
    }
  } finally {
    await context.close().finally(() => first.stop());
  }
});

test('the default SharedWorker keeps Storage SDK upload, reads and deletion working', async ({ page }) => {
  const serve = await startStorageFixture(['--no-capture']);
  try {
    await page.goto(serve.info.url);
    await expect(page.locator('#ready')).toHaveText('Ready');
    await page.getByRole('button', { name: 'Upload', exact: true }).click();
    await expect(page.locator('#upload-result')).toHaveText('Uploaded');
    await page.getByRole('button', { name: 'Read bytes', exact: true }).click();
    await expect(page.locator('#bytes')).toHaveText('Stored in memory');
    await expect(page.locator('#metadata')).toHaveText('{"contentType":"text/plain","size":16,"purpose":"restart-proof"}');
    await page.getByRole('button', { name: 'Delete', exact: true }).click();
    await expect(page.locator('#delete-result')).toHaveText('Deleted');
    await page.getByRole('button', { name: 'List files', exact: true }).click();
    await expect(page.locator('#files')).toHaveText('[]');
  } finally {
    await serve.stop();
  }
});
