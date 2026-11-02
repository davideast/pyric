/**
 * The Studio workspace never serves project state, env files or dependencies:
 * `.pyric/`, `.env*` and `node_modules`. The check runs on the requested path
 * and on the real path, so a symlink inside the project cannot reach them.
 */
import { beforeEach, describe, expect, it } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { Writable } from 'node:stream';

import { diskWorkspace, WorkspaceDeniedPathError } from '../../../src/serve/studio/disk-workspace.js';
import { createStudioRoutes } from '../../../src/serve/studio/routes.js';

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'pyric-workspace-state-'));
  mkdirSync(join(root, '.pyric', 'state', 'hosted'), { recursive: true });
  writeFileSync(join(root, '.pyric', 'state', 'hosted', 'state.sqlite'), 'users and data');
  writeFileSync(join(root, '.env'), 'API_KEY=secret');
  writeFileSync(join(root, '.env.local'), 'API_KEY=local');
  writeFileSync(join(root, '.envrc'), 'export API_KEY=rc');
  mkdirSync(join(root, 'node_modules', 'pkg'), { recursive: true });
  writeFileSync(join(root, 'node_modules', 'pkg', 'index.js'), 'export {}');
  mkdirSync(join(root, 'src'));
  writeFileSync(join(root, 'src', 'app.js'), 'app');
  writeFileSync(join(root, 'firestore.rules'), 'rules');
  symlinkSync(join(root, '.pyric', 'state'), join(root, 'src', 'state-link'));
  symlinkSync(join(root, '.env'), join(root, 'src', 'env-link'));
  // The name is denied, the file behind it is not.
  symlinkSync(join(root, 'src', 'app.js'), join(root, '.env.link'));
});

const deniedPaths = [
  '.pyric/state/hosted/state.sqlite',
  '/.pyric/state/hosted/state.sqlite',
  '.PYRIC/state/hosted/state.sqlite',
  'src/../.pyric/state/hosted/state.sqlite',
  '.env',
  '.env.local',
  '.envrc',
  'node_modules/pkg/index.js',
  'src/state-link/hosted/state.sqlite',
  'src/env-link',
  '.env.link',
];

describe('diskWorkspace refuses project state', () => {
  for (const path of deniedPaths) {
    it(`refuses to read ${path}`, async () => {
      const ws = diskWorkspace(root);
      await expect(ws.read(path)).rejects.toBeInstanceOf(WorkspaceDeniedPathError);
    });
  }

  it('refuses to write or remove into .pyric, .env and node_modules', async () => {
    const ws = diskWorkspace(root);
    await expect(ws.write('.pyric/state/hosted/state.sqlite', 'x')).rejects.toBeInstanceOf(WorkspaceDeniedPathError);
    await expect(ws.write('src/state-link/hosted/state.sqlite', 'x')).rejects.toBeInstanceOf(WorkspaceDeniedPathError);
    await expect(ws.write('.env', 'x')).rejects.toBeInstanceOf(WorkspaceDeniedPathError);
    await expect(ws.remove('node_modules')).rejects.toBeInstanceOf(WorkspaceDeniedPathError);
    expect(readFileSync(join(root, '.pyric', 'state', 'hosted', 'state.sqlite'), 'utf8')).toBe('users and data');
    expect(readFileSync(join(root, '.env'), 'utf8')).toBe('API_KEY=secret');
  });

  it('refuses to list a denied directory, directly or through a symlink', async () => {
    const ws = diskWorkspace(root);
    await expect(ws.list('.pyric/state')).rejects.toBeInstanceOf(WorkspaceDeniedPathError);
    await expect(ws.list('src/state-link')).rejects.toBeInstanceOf(WorkspaceDeniedPathError);
    await expect(ws.list('node_modules')).rejects.toBeInstanceOf(WorkspaceDeniedPathError);
  });

  it('leaves denied entries out of a listing', async () => {
    const ws = diskWorkspace(root);
    expect((await ws.list()).map((entry) => entry.path)).toEqual(['firestore.rules', 'src']);
    expect((await ws.list('src')).map((entry) => entry.path)).toEqual(['src/app.js']);
  });

  it('still reads and writes ordinary project files', async () => {
    const ws = diskWorkspace(root);
    writeFileSync(join(root, 'src', '.environment.js'), 'source');
    expect(await ws.read('src/.environment.js')).toBe('source');
    expect(await ws.read('src/app.js')).toBe('app');
    await ws.write('src/new.js', 'new');
    expect(await ws.read('src/new.js')).toBe('new');
  });
});

class Res extends Writable {
  statusCode = 0;
  private chunks: Buffer[] = [];
  headersSent = false;
  writeHead(status: number): this {
    this.statusCode = status;
    this.headersSent = true;
    return this;
  }
  override _write(chunk: Buffer, _encoding: unknown, done: () => void): void {
    this.chunks.push(Buffer.from(chunk));
    done();
  }
  get body(): string {
    return Buffer.concat(this.chunks).toString('utf8');
  }
}

async function get(path: string): Promise<Res> {
  const routes = createStudioRoutes({ workspace: diskWorkspace(root), sessionToken: 't' });
  const req = { method: 'GET', headers: { host: 'localhost', 'x-pyric-session-token': 't' }, socket: { localPort: 1 } };
  const res = new Res();
  await routes(req as unknown as IncomingMessage, res as unknown as ServerResponse, new URL(`http://localhost${path}`));
  return res;
}

describe('workspace routes refuse project state', () => {
  it('answers 403 for a denied path and keeps its bytes out of the body', async () => {
    const res = await get('/__pyric/workspace?path=src/state-link/hosted/state.sqlite');
    expect(res.statusCode).toBe(403);
    expect(res.body).not.toContain('users and data');
  });

  it('lists the root without .pyric, .env or node_modules', async () => {
    const res = await get('/__pyric/workspace/list');
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toEqual([
      { path: 'firestore.rules', kind: 'file' },
      { path: 'src', kind: 'dir' },
    ]);
  });
});
