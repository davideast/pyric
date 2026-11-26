/**
 * Served Storage permissive mode and undeployed-bucket notices (#1528) across:
 * 1. `installServedStorageRules` + `pruneStorageBucketRules`
 * 2. SharedWorker host dispatch (`handleMessage`)
 * 3. Node SQLite hosted runtime (`createHostedRuntime` on Node >=22.15)
 * 4. In-page `entries/storage-surface.ts` (`getStorage(app, bucketUrl)`)
 */
import 'fake-indexeddb/auto';
import { describe, expect, it } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { initializeSandbox } from 'pyric/sandbox';
import { createAppForSandbox } from 'pyric/app/internal';
import { getBytes, getStorage, ref, uploadBytes } from 'pyric/storage';
import {
  getStorageDefaultPolicy,
  pruneStorageBucketRules,
  undeployedBucketNotice,
} from 'pyric/storage/internal';
import { installServedStorageRules } from '../../src/serve/storage-rules-install.js';
import { handleMessage, type PortLike } from '../../src/serve/worker/host.js';
import type { InboundMessage, OutboundMessage } from '../../src/serve/worker/protocol.js';
import { resolveNodeExecutable } from './require-node-on-path.js';
import { makeHostCtx } from './worker/integration-support.js';
import { useTempDirs } from '../use-temp-dirs.js';

const DENY_ALL = `rules_version = '2';
service firebase.storage {
  match /b/{bucket}/o {
    match /{path=**} {
      allow read, write: if false;
    }
  }
}`;

const OPEN_ALL = `rules_version = '2';
service firebase.storage {
  match /b/{bucket}/o {
    match /{path=**} {
      allow read, write: if true;
    }
  }
}`;

const makeTempDir = useTempDirs('pyric-storage-permissive-');

function uniqueName(label: string): string {
  return `${label}-${Math.random().toString(36).slice(2, 10)}`;
}

async function captureStorageNotices(run: () => Promise<void>): Promise<string[]> {
  const notices: string[] = [];
  const originalWarn = console.warn;
  console.warn = (...args: unknown[]) => {
    const line = args.map(String).join(' ');
    if (line.startsWith('pyric: Storage bucket ')) {
      notices.push(line);
    } else {
      originalWarn(...args);
    }
  };
  try {
    await run();
  } finally {
    console.warn = originalWarn;
  }
  return notices;
}

describe('served Storage permissive mode and undeployed bucket notices (#1528)', () => {
  it('installServedStorageRules sets service defaultPolicy and logs undeployed bucket notice once', async () => {
    const sandbox = initializeSandbox({});
    installServedStorageRules(sandbox, {
      storageRules: null,
      storageBucketRules: { 'locked-bucket': { rules: DENY_ALL, rulesHash: 'd' } },
      projectKey: uniqueName('/project'),
      permissive: true,
    });
    expect(getStorageDefaultPolicy(sandbox)).toBe('allow');

    const app = createAppForSandbox(
      sandbox,
      { projectId: 'demo-app', storageBucket: 'demo-app.appspot.com' },
      uniqueName('served-app'),
    );
    const payload = new Uint8Array([1, 2, 3]);

    const notices = await captureStorageNotices(async () => {
      await uploadBytes(ref(getStorage(app), 'default.bin'), payload);
      const undeployed = getStorage(app, 'gs://undeployed-media');
      await uploadBytes(ref(undeployed, 'item.bin'), payload);
      expect(new Uint8Array(await getBytes(ref(undeployed, 'item.bin')))).toEqual(payload);
      await expect(
        uploadBytes(ref(getStorage(app, 'gs://locked-bucket'), 'denied.bin'), payload),
      ).rejects.toMatchObject({ code: 'storage/unauthorized' });
    });

    expect(notices).toEqual([undeployedBucketNotice('undeployed-media', 'allow')]);

    pruneStorageBucketRules(sandbox, new Set());
    await uploadBytes(ref(getStorage(app), 'after-prune.bin'), payload);
  });

  it('opens default and undeployed buckets on SharedWorker host under permissive mode and warns once per undeployed bucket', async () => {
    const permissiveCtx = await makeHostCtx();
    installServedStorageRules(permissiveCtx.sandbox, {
      storageRules: null,
      storageBucketRules: { 'locked-bucket': { rules: DENY_ALL, rulesHash: 'deny' } },
      projectKey: uniqueName('/worker-permissive'),
      permissive: true,
    });

    let seq = 0;
    const sendWorkerOp = async (
      ctx: Awaited<ReturnType<typeof makeHostCtx>>,
      op: Record<string, unknown>,
    ): Promise<OutboundMessage> => {
      const id = `worker-op-${++seq}`;
      return await new Promise<OutboundMessage>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('Worker op timed out')), 5000);
        const port: PortLike = {
          postMessage(msg: OutboundMessage) {
            if (msg.t !== 'res' || msg.id !== id) return;
            clearTimeout(timer);
            resolve(msg);
          },
        };
        void handleMessage(ctx, port, { t: 'op', id, ...op } as InboundMessage);
      });
    };

    const succeeded = (res: OutboundMessage): boolean => res.t === 'res' && res.ok;

    const permissiveNotices = await captureStorageNotices(async () => {
      expect(
        succeeded(
          await sendWorkerOp(permissiveCtx, {
            method: 'storage.putBytes',
            path: 'hello.txt',
            dataB64: Buffer.from('default-ok').toString('base64'),
          }),
        ),
      ).toBe(true);

      expect(
        succeeded(
          await sendWorkerOp(permissiveCtx, {
            method: 'storage.putBytes',
            bucket: 'other-bucket',
            path: 'hello.txt',
            dataB64: Buffer.from('other-ok').toString('base64'),
          }),
        ),
      ).toBe(true);

      expect(
        succeeded(
          await sendWorkerOp(permissiveCtx, {
            method: 'storage.getBytes',
            bucket: 'other-bucket',
            path: 'hello.txt',
          }),
        ),
      ).toBe(true);

      expect(
        succeeded(
          await sendWorkerOp(permissiveCtx, {
            method: 'storage.putBytes',
            bucket: 'locked-bucket',
            path: 'hello.txt',
            dataB64: Buffer.from('denied').toString('base64'),
          }),
        ),
      ).toBe(false);
    });
    expect(permissiveNotices).toEqual([undeployedBucketNotice('other-bucket', 'allow')]);

    const denyCtx = await makeHostCtx();
    installServedStorageRules(denyCtx.sandbox, {
      storageRules: null,
      storageBucketRules: { 'open-bucket': { rules: OPEN_ALL, rulesHash: 'open' } },
      projectKey: uniqueName('/worker-deny'),
      permissive: false,
    });

    const denyNotices = await captureStorageNotices(async () => {
      expect(
        succeeded(
          await sendWorkerOp(denyCtx, {
            method: 'storage.putBytes',
            bucket: 'open-bucket',
            path: 'ok.txt',
            dataB64: Buffer.from('allowed').toString('base64'),
          }),
        ),
      ).toBe(true);

      expect(
        succeeded(
          await sendWorkerOp(denyCtx, {
            method: 'storage.putBytes',
            bucket: 'missing-bucket',
            path: 'nope.txt',
            dataB64: Buffer.from('denied').toString('base64'),
          }),
        ),
      ).toBe(false);

      expect(
        succeeded(
          await sendWorkerOp(denyCtx, {
            method: 'storage.listAll',
            bucket: 'missing-bucket',
            path: '',
          }),
        ),
      ).toBe(false);
    });
    expect(denyNotices).toEqual([undeployedBucketNotice('missing-bucket', 'deny')]);
  });

  it('opens default and undeployed buckets on a permissive Node SQLite host and warns once naming the bucket', async () => {
    const nodeBin = resolveNodeExecutable();
    const directory = makeTempDir();
    symlinkSync(
      new URL('../../../../node_modules', import.meta.url).pathname,
      join(directory, 'node_modules'),
      'dir',
    );
    const runtimeHref = new URL('../../dist/serve/hosted/runtime.js', import.meta.url).href;
    const entry = join(directory, 'scenario.ts');
    writeFileSync(
      entry,
      `import assert from 'node:assert/strict';
import { createHostedRuntime } from ${JSON.stringify(runtimeHref)};

const directory = process.argv[2];
const payload = {
  rules: null,
  rulesHash: null,
  storageRules: null,
  storageRulesHash: null,
  storageBucketRules: {
    'locked-bucket': {
      rules: ${JSON.stringify(DENY_ALL)},
      rulesHash: 'deny',
    },
  },
  bridgeUrl: null,
  seed: null,
  capture: false,
  hosted: true,
  projectKey: directory,
  permissive: true,
};
let reply = () => {};
function receive(frame) {
  if (frame.type === 'worker-message-result') reply(frame.message);
}
const notices = [];
const warn = console.warn;
console.warn = (...args) => {
  const line = args.map(String).join(' ');
  if (line.startsWith('pyric: Storage bucket ')) notices.push(line);
  else warn(...args);
};
const runtime = await createHostedRuntime(payload, undefined, receive, directory);
let sequence = 0;
async function request(message) {
  const id = 'op-' + (++sequence);
  return await new Promise((resolve, reject) => {
    const deadline = setTimeout(() => reject(new Error('Hosted request timed out')), 5000);
    reply = (response) => {
      if (response.t !== 'res' || response.id !== id) return;
      clearTimeout(deadline);
      resolve(response);
    };
    runtime.receive({
      type: 'worker-message',
      clientSessionId: 'test',
      message: { t: 'op', id, ...message },
    });
  });
}
const succeeded = (res) => res.t === 'res' && res.ok;
try {
  assert.equal(succeeded(await request({ method: 'storage.listAll', path: '' })), true);
  assert.equal(succeeded(await request({ method: 'storage.listAll', bucket: 'other', path: '' })), true);
  assert.equal(succeeded(await request({ method: 'storage.listAll', bucket: 'other', path: '' })), true);
  assert.equal(succeeded(await request({ method: 'storage.listAll', bucket: 'locked-bucket', path: '' })), false);
  assert.deepEqual(notices, [
    'pyric: Storage bucket "other" has no rules in firebase.json; permissive mode allows every client operation. Add {"bucket": "other", "rules": "<file>"} to the storage array.',
  ]);
} finally {
  console.warn = warn;
  await runtime.close();
}
console.log('Hosted Storage permissive buckets passed');
`,
    );
    const build = await Bun.build({
      entrypoints: [entry],
      outdir: directory,
      target: 'node',
      packages: 'external',
      naming: 'scenario.mjs',
    });
    expect(build.success).toBe(true);
    const result = spawnSync(nodeBin, [join(directory, 'scenario.mjs'), directory], {
      encoding: 'utf8',
      timeout: 20_000,
    });
    if (result.status !== 0) {
      throw new Error(`Node hosted Storage fixture failed (${result.status}): ${result.stderr}`);
    }
    expect(result.stdout.trim()).toBe('Hosted Storage permissive buckets passed');
  }, 30_000);

  it('warns immediately on in-page getStorage(app, bucketUrl) and does not double-warn on subsequent uploadBytes', () => {
    const cliPackageRoot = new URL('../..', import.meta.url).pathname;
    const probeScript = `
import 'fake-indexeddb/auto';
import assert from 'node:assert/strict';
import { createAppForSandbox } from 'pyric/app/internal';
import { undeployedBucketNotice } from 'pyric/storage/internal';

globalThis.__PYRIC_FORCE_INPAGE__ = true;
const { sandbox: pageSandbox } = await import('./src/serve/entries/app-backend.ts');
const surface = await import('./src/serve/entries/storage-surface.ts');
const { installServedStorageRules } = await import('./src/serve/storage-rules-install.ts');

installServedStorageRules(pageSandbox, {
  storageRules: null,
  projectKey: '/inpage-project',
  permissive: true,
});
const app = createAppForSandbox(
  pageSandbox,
  { projectId: 'inpage-app', storageBucket: 'inpage-app.appspot.com' },
  'inpage-app',
);

const notices = [];
const originalWarn = console.warn;
console.warn = (...args) => {
  const line = args.map(String).join(' ');
  if (line.startsWith('pyric: Storage bucket ')) notices.push(line);
  else originalWarn(...args);
};

try {
  surface.getStorage(app);
  surface.getStorage(app, 'gs://inpage-app.appspot.com');
  surface.getStorage(app, 'gs://inpage-undeployed');
  assert.deepEqual(notices, [undeployedBucketNotice('inpage-undeployed', 'allow')]);

  notices.length = 0;
  const handle = surface.getStorage(app, 'gs://inpage-undeployed');
  await surface.uploadBytes(surface.ref(handle, 'doc.txt'), new Uint8Array([7, 8, 9]));
  assert.deepEqual(notices, []);
} finally {
  console.warn = originalWarn;
}
console.log('In-page Storage surface notice passed');
`;
    const result = spawnSync(process.execPath, ['-e', probeScript], {
      cwd: cliPackageRoot,
      encoding: 'utf8',
      timeout: 15_000,
    });
    if (result.status !== 0) {
      throw new Error(`In-page Storage surface probe failed (${result.status}): ${result.stderr}`);
    }
    expect(result.stdout.trim()).toBe('In-page Storage surface notice passed');
  }, 20_000);
});
