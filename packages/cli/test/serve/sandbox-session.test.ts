import { afterEach, describe, expect, it } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EventEmitter } from 'node:events';
import type { IncomingMessage, ServerResponse } from 'node:http';

import { createSandboxSession } from '../../src/serve/sandbox-session.js';

const projects: string[] = [];

function project(): string {
  const root = mkdtempSync(join(tmpdir(), 'pyric-sandbox-session-'));
  projects.push(root);
  mkdirSync(join(root, 'sdk'));
  return root;
}

class ResponseRecorder extends EventEmitter {
  statusCode = 200;
  body = '';
  headers: Record<string, string> = {};
  ended = false;

  writeHead(status: number, headers: Record<string, string> = {}): this {
    this.statusCode = status;
    this.headers = headers;
    return this;
  }

  end(body = ''): this {
    this.body += String(body);
    this.ended = true;
    this.emit('finish');
    return this;
  }

  write(body: string): boolean {
    this.body += String(body);
    return true;
  }
}

afterEach(() => {
  for (const root of projects.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('sandbox session', () => {
  it('stages a bare seed and shared defaults in the live payload', async () => {
    const root = project();
    writeFileSync(join(root, 'seed.json'), JSON.stringify({
      'tasks/first': { title: 'Ship the deep module', done: false },
    }));

    const session = await createSandboxSession({
      projectDir: root,
      firebaseConfig: null,
      sdk: { dir: join(root, 'sdk') },
      seedFile: 'seed.json',
    });

    expect(session.payload()).toMatchObject({
      rules: null,
      databaseRules: null,
      storageRules: null,
      projectKey: root,
      bridgeUrl: null,
      seed: {
        'tasks/first': { title: 'Ship the deep module', done: false },
      },
      persist: false,
      capture: true,
      messaging: true,
    });

    await session.close();
  });

  it('primes empty file persistence from a state fixture and exposes restored state', async () => {
    const root = project();
    writeFileSync(join(root, 'fixture.json'), JSON.stringify({
      version: 1,
      firestore: {
        version: 1,
        savedAt: 42,
        firestore: { 'tasks/lived': { title: 'Persisted' } },
      },
      auth: { users: [{ uid: 'reader', email: 'reader@example.com', password: 'secret' }] },
    }));

    const session = await createSandboxSession({
      projectDir: root,
      firebaseConfig: null,
      sdk: { dir: join(root, 'sdk') },
      seedFile: 'fixture.json',
      persistence: { fresh: false },
    });

    expect(session.payload()).toMatchObject({
      seed: null,
      persist: true,
      authUsers: [{ uid: 'reader', email: 'reader@example.com', password: 'secret' }],
    });
    expect(session.summary.persistence).toMatchObject({
      restoredDocs: 1,
      restoredUsers: 1,
    });

    await session.close();
  });

  it('replaces valid Firestore rules and retains last-good rules after a broken edit', async () => {
    const root = project();
    const sourcePath = join(root, 'firestore.rules');
    writeFileSync(sourcePath, `rules_version = '2';
service cloud.firestore {
  match /databases/{db}/documents { match /before/{id} { allow read: if true; } }
}`);

    const session = await createSandboxSession({
      projectDir: root,
      firebaseConfig: { firestore: { rules: 'firestore.rules' } },
      sdk: { dir: join(root, 'sdk') },
    });
    const beforeHash = session.payload().rulesHash;

    writeFileSync(sourcePath, `rules_version = '2';
service cloud.firestore {
  match /databases/{db}/documents { match /after/{id} { allow read: if true; } }
}`);
    const reloaded = await session.reloadFirestoreRules();
    expect(reloaded.kind).toBe('reloaded');
    expect(session.payload().rules).toContain('/after/{id}');
    expect(session.payload().rulesHash).not.toBe(beforeHash);

    const lastGoodHash = session.payload().rulesHash;
    writeFileSync(sourcePath, 'rules_version = ;;; broken');
    const rejected = await session.reloadFirestoreRules();
    expect(rejected.kind).toBe('rejected');
    expect(session.payload().rulesHash).toBe(lastGoodHash);
    expect(session.payload().rules).toContain('/after/{id}');

    await session.close();
  });

  it('replaces valid Realtime Database rules and retains last-good rules after a broken edit', async () => {
    const root = project();
    const sourcePath = join(root, 'database.rules.json');
    writeFileSync(sourcePath, JSON.stringify({
      rules: { '.read': 'false' },
    }));

    const session = await createSandboxSession({
      projectDir: root,
      firebaseConfig: { database: { rules: 'database.rules.json' } },
      sdk: { dir: join(root, 'sdk') },
    });
    const beforeHash = session.payload().databaseRulesHash;

    writeFileSync(sourcePath, JSON.stringify({
      rules: { '.read': 'true' },
    }));
    const reloaded = await (session as unknown as { reloadDatabaseRules(): Promise<{ kind: string }> }).reloadDatabaseRules();
    expect(reloaded.kind).toBe('reloaded');
    expect(session.payload().databaseRules).toEqual({ rules: { '.read': 'true' } });
    expect(session.payload().databaseRulesHash).not.toBe(beforeHash);

    const lastGoodHash = session.payload().databaseRulesHash;
    writeFileSync(sourcePath, '{ invalid json');
    const rejected = await (session as unknown as { reloadDatabaseRules(): Promise<{ kind: string }> }).reloadDatabaseRules();
    expect(rejected.kind).toBe('rejected');
    expect(session.payload().databaseRulesHash).toBe(lastGoodHash);
    expect(session.payload().databaseRules).toEqual({ rules: { '.read': 'true' } });

    await session.close();
  });

  it('dynamically discovers and reloads newly created database.rules.json when unconfigured at boot', async () => {
    const root = project();
    const session = await createSandboxSession({
      projectDir: root,
      firebaseConfig: null,
      sdk: { dir: join(root, 'sdk') },
    });

    expect(session.summary.rules.database.sourcePath).toBeNull();
    expect(session.payload().databaseRules).toBeNull();

    const rulesPath = join(root, 'database.rules.json');
    writeFileSync(rulesPath, JSON.stringify({
      rules: { '.read': true, '.write': true },
    }));

    const reloaded = await session.reloadDatabaseRules();
    expect(reloaded.kind).toBe('reloaded');
    expect(session.payload().databaseRules).toEqual({ rules: { '.read': true, '.write': true } });

    await session.close();
  });

  it('supports multi-database array configs in firebase.json', async () => {
    const root = project();
    const rulesPath = join(root, 'main-db.rules.json');
    writeFileSync(rulesPath, JSON.stringify({
      rules: { '.read': true },
    }));

    const session = await createSandboxSession({
      projectDir: root,
      firebaseConfig: {
        database: [
          { target: 'main', rules: 'main-db.rules.json', url: 'https://main-db.firebaseio.com' },
          { target: 'analytics', rules: 'analytics.rules.json' },
        ],
      },
      sdk: { dir: join(root, 'sdk') },
    });

    expect(session.summary.rules.database.sourcePath).toBe(rulesPath);
    expect(session.payload().databaseRules).toEqual({ rules: { '.read': true } });
    expect(session.payload().databaseUrl).toBe('https://main-db.firebaseio.com');

    await session.close();
  });

  it('serves one live init payload with late-bound host facts', async () => {
    const root = project();
    let bridgeUrl: string | null = null;
    const session = await createSandboxSession({
      projectDir: root,
      firebaseConfig: null,
      sdk: { dir: join(root, 'sdk'), workerVersion: 'worker-v1' },
      bridgeUrl: () => bridgeUrl,
      ai: { engine: { kind: 'scripted' } },
    });

    bridgeUrl = 'ws://localhost:5173/__pyric/sandbox';
    const response = new ResponseRecorder();
    const handled = await session.handle(
      { headers: { host: 'localhost' } } as IncomingMessage,
      response as unknown as ServerResponse,
      new URL('http://localhost/__pyric/init.json'),
    );

    expect(handled).toBe(true);
    expect(response.statusCode).toBe(200);
    expect(JSON.parse(response.body)).toMatchObject({
      projectKey: root,
      bridgeUrl,
      ai: { engine: { kind: 'scripted' } },
    });

    await session.close();
  });

  it('closes owned event streams exactly once', async () => {
    const root = project();
    const session = await createSandboxSession({
      projectDir: root,
      firebaseConfig: null,
      sdk: { dir: join(root, 'sdk') },
    });
    const request = new EventEmitter() as IncomingMessage;
    const response = new ResponseRecorder();

    expect(await session.handle(
      request,
      response as unknown as ServerResponse,
      new URL('http://localhost/__pyric/events'),
    )).toBe(true);
    expect(response.ended).toBe(false);

    await session.close();
    await session.close();
    expect(response.ended).toBe(true);
  });

  it('loads database.rules.json automatically when present in project root', async () => {
    const root = project();
    writeFileSync(join(root, 'database.rules.json'), JSON.stringify({
      rules: { '.read': 'auth != null', '.write': 'auth != null' },
    }));

    const session = await createSandboxSession({
      projectDir: root,
      firebaseConfig: null,
      sdk: { dir: join(root, 'sdk') },
    });

    expect(session.summary.rules.database.sourcePath).toBe(join(root, 'database.rules.json'));
    expect(session.payload().databaseRules).toEqual({
      rules: { '.read': 'auth != null', '.write': 'auth != null' },
    });

    await session.close();
  });

  it('exposes permissive flag in payload and logs appropriate notices', async () => {
    const root = project();
    const notes: string[] = [];
    const logger = {
      note: (msg: string) => notes.push(msg),
      error: () => {},
    };

    // Default: permissive is false, logs deny notice
    const sessionDefault = await createSandboxSession({
      projectDir: root,
      firebaseConfig: null,
      sdk: { dir: join(root, 'sdk') },
      logger,
    });
    expect(sessionDefault.payload().permissive).toBe(false);
    expect(notes.some((n) => n.includes('default to DENY'))).toBe(true);
    await sessionDefault.close();

    // Permissive: permissive is true, logs permissive notice
    notes.length = 0;
    const sessionPermissive = await createSandboxSession({
      projectDir: root,
      firebaseConfig: null,
      sdk: { dir: join(root, 'sdk') },
      permissive: true,
      logger,
    });
    expect(sessionPermissive.payload().permissive).toBe(true);
    expect(notes.some((n) => n.includes('permissive mode active'))).toBe(true);
    await sessionPermissive.close();
  });
});
