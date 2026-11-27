/**
 * Candidate scenario (#1815): h1-lookup-float-interpolation
 *
 * Records production's Storage Rules Test API verdict when $(expr) inside a
 * firestore.get() or firestore.exists() document path evaluates to:
 *   (a) a float custom auth claim (request.auth.token.v = 1.5), and
 *   (b) a float Firestore document field (firestore.get(.../cfg/main).data.v = 1.5),
 * paired with an integer control (v = 7) on the exact same match block and
 * allow expression for each arm so a float refusal is distinguishable from a
 * malformed rule, auth claim, mock shape, or cross-service lookup budget cap.
 *
 * Both items/1.5 and items/7 are mocked to allow, so ALLOW records stringified
 * path interpolation while DENY records float interpolation refusal.
 */
import type { StorageScenarioRecord } from './types.ts';

const itemFloatGet = { function: 'get' as const, path: 'items/1.5', result: { ok: true } };
const itemIntGet = { function: 'get' as const, path: 'items/7', result: { ok: true } };
const itemFloatExists = { function: 'exists' as const, path: 'items/1.5', result: true };
const itemIntExists = { function: 'exists' as const, path: 'items/7', result: true };
const cfgFloat = { function: 'get' as const, path: 'cfg/main', result: { v: 1.5 } };
const cfgInt = { function: 'get' as const, path: 'cfg/main', result: { v: 7 } };

export const scenario: StorageScenarioRecord = {
  fm: 'STORAGE-H1-LOOKUP-FLOAT',
  rationale:
    'Whether $(expr) inside a Storage firestore.get() or firestore.exists() path accepts or refuses a float custom auth claim and a float Firestore document field (#1815).',
  pendingRowLink: true,
  rules: `rules_version = '2';
service firebase.storage {
  match /b/{bucket}/o {
    match /claim/get.bin {
      allow create: if firestore.get(/databases/(default)/documents/items/$(request.auth.token.v)).data.ok == true;
    }
    match /claim/exists.bin {
      allow create: if firestore.exists(/databases/(default)/documents/items/$(request.auth.token.v));
    }
    match /field/get.bin {
      allow create: if firestore.get(/databases/(default)/documents/items/$(firestore.get(/databases/(default)/documents/cfg/main).data.v)).data.ok == true;
    }
    match /field/exists.bin {
      allow create: if firestore.exists(/databases/(default)/documents/items/$(firestore.get(/databases/(default)/documents/cfg/main).data.v));
    }
  }
}`,
  cases: [
    {
      description: 'claim get: float auth claim 1.5 in firestore.get path',
      expectation: 'ALLOW',
      method: 'create',
      path: 'claim/get.bin',
      auth: { uid: 'alice', token: { v: 1.5 } },
      resource: { size: 1 },
      functionMocks: [itemFloatGet],
    },
    {
      description: 'claim get control: int auth claim 7 in firestore.get path',
      expectation: 'ALLOW',
      method: 'create',
      path: 'claim/get.bin',
      auth: { uid: 'alice', token: { v: 7 } },
      resource: { size: 1 },
      functionMocks: [itemIntGet],
    },
    {
      description: 'claim exists: float auth claim 1.5 in firestore.exists path',
      expectation: 'ALLOW',
      method: 'create',
      path: 'claim/exists.bin',
      auth: { uid: 'alice', token: { v: 1.5 } },
      resource: { size: 1 },
      functionMocks: [itemFloatExists],
    },
    {
      description: 'claim exists control: int auth claim 7 in firestore.exists path',
      expectation: 'ALLOW',
      method: 'create',
      path: 'claim/exists.bin',
      auth: { uid: 'alice', token: { v: 7 } },
      resource: { size: 1 },
      functionMocks: [itemIntExists],
    },
    {
      description: 'field get: float document field 1.5 in firestore.get path',
      expectation: 'ALLOW',
      method: 'create',
      path: 'field/get.bin',
      auth: { uid: 'alice' },
      resource: { size: 1 },
      functionMocks: [cfgFloat, itemFloatGet],
    },
    {
      description: 'field get control: int document field 7 in firestore.get path',
      expectation: 'ALLOW',
      method: 'create',
      path: 'field/get.bin',
      auth: { uid: 'alice' },
      resource: { size: 1 },
      functionMocks: [cfgInt, itemIntGet],
    },
    {
      description: 'field exists: float document field 1.5 in firestore.exists path',
      expectation: 'ALLOW',
      method: 'create',
      path: 'field/exists.bin',
      auth: { uid: 'alice' },
      resource: { size: 1 },
      functionMocks: [cfgFloat, itemFloatExists],
    },
    {
      description: 'field exists control: int document field 7 in firestore.exists path',
      expectation: 'ALLOW',
      method: 'create',
      path: 'field/exists.bin',
      auth: { uid: 'alice' },
      resource: { size: 1 },
      functionMocks: [cfgInt, itemIntExists],
    },
  ],
};
