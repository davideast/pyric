/**
 * The in-process plane loads the Storage rules file the project deploys
 * (#1331): the first `firebase.json` `storage` entry with a `rules` path, else
 * `storage.rules` in the project directory, as the dev server, the worker and
 * the Node host do. A `2+modules` file resolves its imports against its own
 * directory.
 */
import { describe, it, expect } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { runInProcessMcp } from '../../src/bridge/server/in-process.js';

const DENY_ALL = `rules_version = '2';
service firebase.storage {
  match /b/{bucket}/o {
    match /{all=**} { allow read, write: if false; }
  }
}
`;

const ALLOW_ALL = `rules_version = '2';
service firebase.storage {
  match /b/{bucket}/o {
    match /{all=**} { allow read, write: if true; }
  }
}
`;

const MODULAR = `rules_version = '2+modules';
import { isOpen } from './helpers';
service firebase.storage {
  match /b/{bucket}/o {
    match /open/{f} { allow read, write: if isOpen(); }
  }
}
`;

const HELPERS = `export function isOpen() { return true; }
`;

async function openSession(cwd: string) {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const exit = runInProcessMcp(cwd, { env: {}, transport: serverTransport });
  const client = new Client({ name: 'test', version: '0' });
  await client.connect(clientTransport);
  const close = async (): Promise<number> => {
    await client.close();
    return await exit;
  };
  return { client, close };
}

/** Upload one object as an unauthenticated caller; true when the sandbox allowed it. */
async function anonymousUpload(cwd: string, path: string): Promise<{ allowed: boolean; text: string }> {
  const session = await openSession(cwd);
  try {
    const switched = await session.client.callTool({
      name: 'auth',
      arguments: { method: 'actAsAnonymous', args: {} },
    });
    expect(switched.isError).toBeFalsy();
    const upload = await session.client.callTool({
      name: 'storage',
      arguments: { method: 'uploadBytes', args: { path, contentBase64: Buffer.from('x').toString('base64') } },
    });
    return { allowed: !upload.isError, text: JSON.stringify(upload.content) };
  } finally {
    await session.close();
  }
}

function withProject(files: Record<string, string>, run: (dir: string) => Promise<void>): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), 'pyric-in-process-storage-rules-'));
  for (const [file, content] of Object.entries(files)) {
    mkdirSync(join(dir, file, '..'), { recursive: true });
    writeFileSync(join(dir, file), content);
  }
  return run(dir).finally(() => rmSync(dir, { recursive: true, force: true }));
}

describe('in-process Storage rules load path', () => {
  it('enforces the rules file firebase.json names, not a root storage.rules', async () => {
    await withProject(
      {
        'firebase.json': JSON.stringify({ storage: { rules: 'rules/storage.rules' } }),
        'rules/storage.rules': DENY_ALL,
        'storage.rules': ALLOW_ALL,
      },
      async (dir) => {
        const result = await anonymousUpload(dir, 'uploads/a.txt');
        expect(result.allowed).toBe(false);
        expect(result.text).toContain('unauthorized');
      },
    );
  });

  it('reads the first firebase.json storage array entry with a rules path', async () => {
    await withProject(
      {
        'firebase.json': JSON.stringify({ storage: [{ bucket: 'a' }, { bucket: 'b', rules: 'deny.rules' }] }),
        'deny.rules': DENY_ALL,
        'storage.rules': ALLOW_ALL,
      },
      async (dir) => {
        expect((await anonymousUpload(dir, 'uploads/a.txt')).allowed).toBe(false);
      },
    );
  });

  it('falls back to storage.rules in the project directory without firebase.json', async () => {
    await withProject({ 'storage.rules': ALLOW_ALL }, async (dir) => {
      expect((await anonymousUpload(dir, 'uploads/a.txt')).allowed).toBe(true);
    });
  });

  it('loads a 2+modules file whose relative import sits beside it', async () => {
    await withProject(
      {
        'firebase.json': JSON.stringify({ storage: { rules: 'rules/storage.rules' } }),
        'rules/storage.rules': MODULAR,
        'rules/helpers.rules': HELPERS,
      },
      async (dir) => {
        const result = await anonymousUpload(dir, 'open/a.txt');
        expect(result.allowed, result.text).toBe(true);
      },
    );
  });
});
