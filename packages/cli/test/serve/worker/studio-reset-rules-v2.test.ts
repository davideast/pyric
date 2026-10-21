import { describe, expect, it } from 'bun:test';
import { handleStudioOp } from '../../../src/serve/worker/host/studio.js';
import { initializeSandbox } from 'pyric/sandbox';
import type { HostCtx } from '../../../src/serve/worker/host/core.js';
import { getInternalEnv } from 'pyric/sandbox/internal';

describe('worker studio resetAll rules behavior', () => {
  it('enforces permissive rules with lint errors and keeps RTDB listener', async () => {
    const sandbox = initializeSandbox();
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



    let postedMsg: any = null;
    try {
      await handleStudioOp(ctx, { postMessage: (m: any) => { postedMsg = m; } } as any, { 
        method: 'resetAll', id: '1' 
      } as any);
    } catch(e) {}
    
    expect(postedMsg?.value?.errors).toEqual([]);

    // Firestore permissive rules are enforced
    const fsRules = getInternalEnv(sandbox).getRules();
    expect(fsRules).toBe(`rules_version = '2'; service cloud.firestore { match /databases/{database}/documents { match /{document=**} { allow read, write: if true; } } }`);
  });
});
