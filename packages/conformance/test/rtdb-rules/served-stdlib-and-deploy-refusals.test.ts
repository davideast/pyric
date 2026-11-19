import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { deleteApp as deleteAdminApp, initializeApp as initializeAdminApp } from 'pyric-admin/app';
import { getAuth as getAdminAuth } from 'pyric-admin/auth';
import { getDatabase as getAdminDatabase, type Database as AdminDatabase } from 'pyric-admin/database';
import * as workerSurface from '../../../cli/dist/serve/worker/index.js';
import { signInWithCustomToken } from '../../../cli/dist/serve/worker/client.js';
import {
  ALL_RULES_RTDB_DEPLOY_SCENARIOS,
  ALL_RULES_RTDB_SCENARIOS,
} from '../../rules-corpus/rtdb/index.ts';
import type { RtdbCaseIdentity } from '../../rules-corpus/rtdb/types.ts';
import { RULES_DEPLOY_REFUSAL_CASES } from '../../src/capture/rtdb-climb/rules-deploy-refusals.cases.ts';
import { registerServedRtdbHooks, SERVED_RTDB_PLANES } from './served-rtdb-harness.ts';

registerServedRtdbHooks();

const OBS_ROOT = join(import.meta.dir, '..', '..', 'observations');

function readObservation(surfaceDir: string, stem: string): Record<string, unknown> {
  const raw = readFileSync(join(OBS_ROOT, surfaceDir, `${stem}.json`), 'utf8');
  const parsed = JSON.parse(raw) as { behavior: Record<string, unknown> };
  return parsed.behavior;
}

function substituteUid<T>(value: T, uid: string): T {
  let normalized: unknown = null;
  if (value !== undefined) {
    normalized = value;
  }
  const serialized = JSON.stringify(normalized).replaceAll('<UID>', uid);
  return JSON.parse(serialized) as T;
}

function buildSeedSubtree(
  seed: Record<string, unknown> | undefined,
  uid: string,
): Record<string, unknown> {
  const root: Record<string, unknown> = {};
  if (seed === undefined) {
    return root;
  }
  for (const [rawPath, rawValue] of Object.entries(seed)) {
    const cleanPath = substituteUid(rawPath, uid);
    const segments = cleanPath.split('/').filter(Boolean);
    let cursor: Record<string, unknown> = root;
    for (const segment of segments.slice(0, -1)) {
      const existing = cursor[segment];
      if (typeof existing === 'object' && existing !== null) {
        cursor = existing as Record<string, unknown>;
      } else {
        const next: Record<string, unknown> = {};
        cursor[segment] = next;
        cursor = next;
      }
    }
    const leafKey = segments[segments.length - 1];
    if (leafKey !== undefined) {
      cursor[leafKey] = substituteUid(rawValue, uid);
    }
  }
  return root;
}

const STDLIB_IDS = [
  'r27-stdlib-core-patterns',
  'r28-stdlib-presence-timing',
  'r34-stdlib-auth-membership-quota',
] as const;

let adminSeq = 0;

for (const [planeLabel, createHarness] of SERVED_RTDB_PLANES) {
  describe(`RTDB stdlib and deploy-refusal oracle captures (${planeLabel})`, () => {
    it('rtdb#89: setDatabaseRules refuses every rejected r29 and deploy-refusals ruleset while keeping active rules in force', async () => {
      const sentinelRules = {
        rules: {
          guarded: {
            $uid: {
              '.read': 'auth != null && auth.uid == $uid',
              '.write': 'auth != null && auth.uid == $uid',
            },
          },
        },
      };
      const harness = await createHarness(sentinelRules);
      const ownerClient = await harness.openClient('sentinel-owner');
      const ownerCred = await workerSurface.signInAnonymously(
        workerSurface.getAuth(ownerClient.raw),
      );
      const unauthedClient = await harness.openClient('sentinel-anon');
      await workerSurface.rtdbSet(
        workerSurface.rtdbRef(ownerClient.db, `guarded/${ownerCred.user.uid}`),
        'kept',
      );

      const r29Scenario = ALL_RULES_RTDB_DEPLOY_SCENARIOS.find(
        (entry) => entry.id === 'r29-deploy-rejections',
      );
      expect(r29Scenario).toBeDefined();
      const r29Obs = readObservation('rtdb-rules', 'rules-rtdb-r29-deploy-rejections') as Record<
        string,
        { verdict: 'ACCEPTED' | 'REJECTED'; error?: string }
      >;

      if (r29Scenario !== undefined) {
        for (const deployCase of r29Scenario.deployCases) {
          const captured = r29Obs[deployCase.description];
          expect(captured?.verdict).toBe(deployCase.expectation.verdict);
          if (captured?.verdict !== 'REJECTED') {
            continue;
          }
          const candidate = { rules: JSON.parse(deployCase.rules) as Record<string, unknown> };
          const reply = await workerSurface.setDatabaseRules(harness.mainDb, candidate);
          expect(reply.ok).toBe(false);
          const firstMsg = reply.messages[0] as { text?: string } | undefined;
          expect(firstMsg?.text ?? '').toContain(captured.error ?? '');
        }
      }

      const deployRefusalsObs = readObservation('rtdb', 'rtdb-rules-deploy-refusals');
      const refusalOutcomes = deployRefusalsObs.outcomes as Record<
        string,
        { accepted: boolean; message: string | null }
      >;
      for (const [label, subtree] of Object.entries(RULES_DEPLOY_REFUSAL_CASES)) {
        const outcome = refusalOutcomes[label];
        if (outcome === undefined || outcome.accepted) {
          continue;
        }
        const reply = await workerSurface.setDatabaseRules(harness.mainDb, {
          rules: { probe: subtree },
        });
        expect(reply.ok).toBe(false);
        const firstMsg = reply.messages[0] as { text?: string } | undefined;
        if (label !== 'matches with an unterminated character class' && outcome.message !== null) {
          expect(firstMsg?.text ?? '').toContain(outcome.message);
        }
      }

      const ownerSnap = await workerSurface.rtdbGet(
        workerSurface.rtdbRef(ownerClient.db, `guarded/${ownerCred.user.uid}`),
      );
      expect(ownerSnap.val()).toBe('kept');

      let unauthedDenied = false;
      try {
        await workerSurface.rtdbGet(
          workerSurface.rtdbRef(unauthedClient.db, `guarded/${ownerCred.user.uid}`),
        );
      } catch {
        unauthedDenied = true;
      }
      expect(unauthedDenied).toBe(true);

      for (const [label, subtree] of Object.entries(RULES_DEPLOY_REFUSAL_CASES)) {
        const outcome = refusalOutcomes[label];
        if (outcome === undefined || !outcome.accepted) {
          continue;
        }
        const reply = await workerSurface.setDatabaseRules(harness.mainDb, {
          rules: { probe: subtree },
        });
        expect(reply.ok).toBe(true);
      }
    });

    for (const id of STDLIB_IDS) {
      it(`rtdb#86, #87, #88: replays ${id} across ${planeLabel}`, async () => {
        const scenario = ALL_RULES_RTDB_SCENARIOS.find((entry) => entry.id === id);
        expect(scenario).toBeDefined();
        if (scenario === undefined) {
          return;
        }

        const subtree = JSON.parse(scenario.rules) as Record<string, unknown>;
        const fullRules = {
          rules: {
            '.read': false,
            '.write': false,
            [id]: subtree,
          },
        };

        const harness = await createHarness(fullRules);
        const remote = await harness.openRemote();
        adminSeq += 1;
        const adminApp = initializeAdminApp({ sandbox: remote }, `stdlib-admin-${adminSeq}`);
        const adminDb: AdminDatabase = getAdminDatabase(adminApp);
        const adminAuth = getAdminAuth(adminApp);

        try {
          const anonClient = await harness.openClient(`${id}-anon`);
          const anonCred = await workerSurface.signInAnonymously(
            workerSurface.getAuth(anonClient.raw),
          );
          const unauthedClient = await harness.openClient(`${id}-signed-out`);
          const identitySessions = new Map<
            string,
            { db: workerSurface.ClientRtdb; uid: string }
          >();

          const openIdentitySession = async (
            identity: RtdbCaseIdentity,
          ): Promise<{ db: workerSurface.ClientRtdb; uid: string }> => {
            const cacheKey = JSON.stringify(identity);
            const cached = identitySessions.get(cacheKey);
            if (cached !== undefined) {
              return cached;
            }
            const uid = `id-user-${identitySessions.size + 1}`;
            if (identity.emailDomain !== undefined) {
              await adminAuth.createUser({
                uid,
                email: `${uid}@${identity.emailDomain}`,
                emailVerified: identity.emailVerified ?? false,
              });
            }
            const customToken = await adminAuth.createCustomToken(uid, identity.claims);
            const opened = await harness.openClient(`${id}-${uid}`);
            const clientAuth = workerSurface.getAuth(opened.raw);
            await signInWithCustomToken(clientAuth, customToken);
            const session = { db: opened.db, uid };
            identitySessions.set(cacheKey, session);
            return session;
          };

          const capturedVerdicts = readObservation('rtdb-rules', `rules-rtdb-${id}`);
          const mismatches: string[] = [];

          for (const testCase of scenario.cases) {
            let activeDb = unauthedClient.db;
            let activeUid = anonCred.user.uid;
            if (testCase.authPresent) {
              if (testCase.identity !== undefined) {
                const customSession = await openIdentitySession(testCase.identity);
                activeDb = customSession.db;
                activeUid = customSession.uid;
              } else {
                activeDb = anonClient.db;
                activeUid = anonCred.user.uid;
              }
            }

            const seedData = buildSeedSubtree(testCase.seed, activeUid);
            if (Object.keys(seedData).length === 0) {
              await adminDb.ref(id).set(null);
            } else {
              await adminDb.ref(id).set(seedData);
            }

            const targetPath = `${id}${substituteUid(testCase.opPath, activeUid)}`.replace(/\/$/, '');
            const targetRef = workerSurface.rtdbRef(activeDb, targetPath);
            let actualVerdict: 'ALLOW' | 'DENY' = 'ALLOW';
            try {
              if (testCase.operation === 'read') {
                await workerSurface.rtdbGet(targetRef);
              } else if (testCase.operation === 'update') {
                const patch = substituteUid(testCase.newData, activeUid) as Record<string, unknown>;
                await workerSurface.rtdbUpdate(targetRef, patch);
              } else {
                const payload = substituteUid(testCase.newData, activeUid);
                await workerSurface.rtdbSet(targetRef, payload);
              }
            } catch {
              actualVerdict = 'DENY';
            }

            const expectedVerdict = capturedVerdicts[testCase.description];
            if (actualVerdict !== expectedVerdict) {
              mismatches.push(
                `${testCase.description}: expected ${String(expectedVerdict)}, got ${actualVerdict}`,
              );
            }
          }

          expect(mismatches).toEqual([]);
        } finally {
          await deleteAdminApp(adminApp);
        }
      });
    }
  });
}
