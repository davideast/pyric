import { describe, expect, it } from 'bun:test';
import { EventEmitter } from 'node:events';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ViteDevServer } from 'vite';
import { initializeSandbox } from 'pyric/sandbox';
import { setRules as setFirestoreRules } from 'pyric/sandbox/firestore';
import { getAdminFirestore } from 'pyric/sandbox/admin-firestore';
import {
  collection,
  getDocs,
  getFirestore,
  query,
  where,
} from 'pyric/firestore';
import { buildVerifyFixture } from '../../src/verify/index.js';
import { createSandboxSession } from '../../src/serve/sandbox-session.js';
import { watchViteGenerationRules } from '../../src/serve/vite-generation-rules-watch.js';

function createTempProject(): string {
  const root = mkdtempSync(join(tmpdir(), 'pyric-fixture-watch-'));
  mkdirSync(join(root, 'sdk'), { recursive: true });
  return root;
}

const PUBLIC_POSTS_RULES = `rules_version = '2';
service cloud.firestore {
  match /databases/{db}/documents {
    match /posts/{id} {
      allow read: if resource.data.visibility == 'public';
    }
  }
}`;

const TIGHTENED_POSTS_RULES = `rules_version = '2';
service cloud.firestore {
  match /databases/{db}/documents {
    match /posts/{id} {
      allow read: if resource.data.visibility == 'public' && resource.data.owner == request.auth.uid;
    }
  }
}`;

describe('pyric dev rules watcher fixture re-runs (#371)', () => {
  it('re-runs captured session and test-case fixtures on Firestore rules reload and prints terminal results', async () => {
    const root = createTempProject();
    const rulesPath = join(root, 'firestore.rules');
    writeFileSync(rulesPath, PUBLIC_POSTS_RULES);

    // 1. Write a captured session (.pyric/last-session.json) with a seen query shape
    const sandbox = initializeSandbox();
    setFirestoreRules(sandbox, PUBLIC_POSTS_RULES);
    await getAdminFirestore(sandbox).doc('posts/p1').set({ visibility: 'public', owner: 'alice' });
    const db = getFirestore(sandbox.withAuth({ uid: 'alice' }));
    await getDocs(query(collection(db, 'posts'), where('visibility', '==', 'public')));
    const sessionFixture = buildVerifyFixture({
      sandbox,
      firestoreRules: PUBLIC_POSTS_RULES,
    });
    mkdirSync(join(root, '.pyric'), { recursive: true });
    writeFileSync(join(root, '.pyric', 'last-session.json'), JSON.stringify(sessionFixture, null, 2));

    // 2. Also write a rules test-case fixture (fixtures/posts-list.json)
    mkdirSync(join(root, 'fixtures'), { recursive: true });
    writeFileSync(
      join(root, 'fixtures', 'posts-list.json'),
      JSON.stringify(
        [
          {
            description: 'list public posts',
            expectation: 'ALLOW',
            method: 'list',
            path: 'posts',
            auth: { uid: 'alice' },
            query: {
              where: [{ field: 'visibility', op: '==', value: 'public' }],
            },
          },
        ],
        null,
        2,
      ),
    );

    const session = await createSandboxSession({
      projectDir: root,
      firebaseConfig: { firestore: { rules: 'firestore.rules' } },
      sdk: { dir: join(root, 'sdk') },
    });

    const watcher = Object.assign(new EventEmitter(), {
      add() {
        return watcher;
      },
    });
    const logs: string[] = [];
    const server = {
      watcher,
      config: {
        logger: {
          info: (m: string) => logs.push(m),
          warn: (m: string) => logs.push(m),
        },
      },
    } as unknown as ViteDevServer;

    const stop = watchViteGenerationRules({ server, session });

    // Edit 1: rules still prove both fixtures -> green summary in terminal
    writeFileSync(rulesPath, `${PUBLIC_POSTS_RULES}\n// comment edit`);
    watcher.emit('change', rulesPath);
    await new Promise((resolve) => setTimeout(resolve, 300));

    expect(logs.some((l) => l.includes('rules reloaded'))).toBe(true);
    expect(logs.some((l) => l.includes('fixtures:') && l.includes('passed'))).toBe(true);

    // Edit 2: tighten rules so `where('visibility', '==', 'public')` is UNPROVABLE -> warning in terminal
    logs.length = 0;
    writeFileSync(rulesPath, TIGHTENED_POSTS_RULES);
    watcher.emit('change', rulesPath);
    await new Promise((resolve) => setTimeout(resolve, 300));

    expect(logs.some((l) => l.includes('rules reloaded'))).toBe(true);
    expect(logs.some((l) => l.includes('fixtures:') && l.includes('regressed'))).toBe(true);
    expect(logs.some((l) => l.includes('posts') && l.includes('owner'))).toBe(true);

    stop();
    await session.close();
  });
});
