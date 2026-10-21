import { describe, expect, it } from 'bun:test';
import { handleStudioOp } from '../../../src/serve/worker/host/studio.js';
import { initializeSandbox } from 'pyric/sandbox';
import type { HostCtx } from '../../../src/serve/worker/host/core.js';
import { getInternalEnv } from 'pyric/sandbox/internal';
import { getDatabase, ref, onValue, set } from 'pyric/database';
import { sandbox as rtdbSandbox } from 'pyric/database';

describe('worker studio resetAll rules behavior', () => {
  it('enforces permissive rules with lint errors and keeps RTDB listener', async () => {
    const sandbox = initializeSandbox();
    const db = getDatabase(sandbox);
    
    const ctx: HostCtx = {
      sandbox,
      rtdbInstances: new Map(),
      rtdbDefaultPolicy: 'deny',
      activeRules: {
        firestore: {
          status: 'error',
          source: `rules_version = '2'; service cloud.firestore { match /databases/{database}/documents { match /{document=**} { allow read, write: if true; } } }`,
          lastKnownGood: `rules_version = '2'; service cloud.firestore { match /databases/{database}/documents { match /{document=**} { allow read, write: if false; } } }`,
          messages: [],
          updatedAt: Date.now()
        }
      },
      env: {}
    };

    const instance = {
      name: 'default',
      live: db,
      rules: {
        status: 'active' as const,
        source: '{ "rules": { ".read": true, ".write": true } }',
        messages: [],
        updatedAt: Date.now()
      },
      sessions: new Map()
    };
    ctx.rtdbInstances?.set('default', instance);
    rtdbSandbox.setRules(db, { rules: { '.read': true, '.write': true } });

    await set(ref(db, 'a'), 1);

    const events: unknown[] = [];
    let cancels = 0;
    const unsub = onValue(ref(db, 'a'), 
      (snap) => { events.push(snap.val()); },
      () => { cancels++; }
    );

    // wait for initial event
    await new Promise((resolve) => setTimeout(resolve, 10));

    let postedMsg: any = null;
    try {
      await handleStudioOp(ctx, { postMessage: (m: any) => { postedMsg = m; } } as any, { 
        method: 'resetAll', id: '1' 
      } as any);
    } catch(e) {}
    
    expect(postedMsg?.value?.errors).toEqual([]);

    // Listener not cancelled, got null
    expect(cancels).toBe(0);
    expect(events).toEqual([1, null]);

    // Firestore permissive rules are enforced
    const fsRules = getInternalEnv(sandbox).getRules();
    expect(fsRules).toBe(`rules_version = '2'; service cloud.firestore { match /databases/{database}/documents { match /{document=**} { allow read, write: if true; } } }`);
  });
});
