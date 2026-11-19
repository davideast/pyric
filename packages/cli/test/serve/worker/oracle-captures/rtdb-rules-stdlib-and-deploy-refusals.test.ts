import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { deleteApp as deleteAdminApp, initializeApp as initializeAdminApp } from 'pyric-admin/app';
import { getAuth as getAdminAuth } from 'pyric-admin/auth';
import { defineRtdbRules, rtdbRules, type PathDef } from 'pyric/rules';
import * as workerClient from '../../../../src/serve/worker/client.js';
import {
  ALL_RULES_RTDB_DEPLOY_SCENARIOS,
  ALL_RULES_RTDB_SCENARIOS,
} from '../../../../../conformance/rules-corpus/rtdb/index.ts';
import type { RtdbCaseIdentity } from '../../../../../conformance/rules-corpus/rtdb/types.ts';
import { RULES_DEPLOY_REFUSAL_CASES } from '../../../../../conformance/src/capture/rtdb-climb/rules-deploy-refusals.cases.ts';
import { CORE_PATTERN_PATHS } from '../../../../../pyric/test/rules/rtdb/stdlib/fixtures/match-rules.js';
import { PRESENCE_TIMING_PATHS } from '../../../../../pyric/test/rules/rtdb/stdlib/fixtures/presence-timing-rules.js';
import { AUTH_MEMBERSHIP_PATHS } from '../../../../../pyric/test/rules/rtdb/stdlib/fixtures/auth-membership-rules.js';
import {
  hostedRtdbContext,
  load,
  restoreSharedWorker,
  servedRtdbContext,
  type ServedRtdbAdminContext,
} from './support.ts';

restoreSharedWorker();

const RULES_RTDB_OBS_DIR = join(
  import.meta.dir,
  '..',
  '..',
  '..',
  '..',
  '..',
  'conformance',
  'observations',
  'rtdb-rules',
);

function loadRulesRtdbObservation(name: string): Record<string, unknown> {
  const raw = readFileSync(join(RULES_RTDB_OBS_DIR, `${name}.json`), 'utf8');
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

type RulesContextFactory = (
  databaseRules?: Record<string, unknown>,
) => Promise<ServedRtdbAdminContext>;

const PLANES: ReadonlyArray<[string, RulesContextFactory]> = [
  ['served SharedWorker', (rules) => servedRtdbContext(rules)],
  ['served Node host', (rules) => hostedRtdbContext(rules)],
];

const STDLIB_FIXTURES: ReadonlyArray<{ id: string; paths: Record<string, PathDef> }> = [
  { id: 'r27-stdlib-core-patterns', paths: CORE_PATTERN_PATHS },
  { id: 'r28-stdlib-presence-timing', paths: PRESENCE_TIMING_PATHS },
  { id: 'r34-stdlib-auth-membership-quota', paths: AUTH_MEMBERSHIP_PATHS },
];

let authAppSeq = 0;

for (const [planeLabel, createContext] of PLANES) {
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
      const ctx = await createContext(sentinelRules);
      const authed = await ctx.openAuthedClient('sentinel-owner');
      const unauthed = await ctx.newClient('sentinel-anon');
      await ctx.rtdb.set(ctx.rtdb.ref(authed.db, `guarded/${authed.uid}`), 'kept');

      const r29Scenario = ALL_RULES_RTDB_DEPLOY_SCENARIOS.find(
        (entry) => entry.id === 'r29-deploy-rejections',
      );
      expect(r29Scenario).toBeDefined();
      const r29Obs = loadRulesRtdbObservation('rules-rtdb-r29-deploy-rejections') as Record<
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
          const reply = await workerClient.setDatabaseRules(
            ctx.db as unknown as workerClient.ClientRtdb,
            candidate,
          );
          expect(reply.ok).toBe(false);
          const firstMsg = reply.messages[0] as { text?: string } | undefined;
          expect(firstMsg?.text ?? '').toContain(captured.error ?? '');
        }
      }

      const deployRefusalsObs = load('rtdb-rules-deploy-refusals');
      const refusalOutcomes = deployRefusalsObs.outcomes as Record<
        string,
        { accepted: boolean; message: string | null }
      >;
      for (const [label, subtree] of Object.entries(RULES_DEPLOY_REFUSAL_CASES)) {
        const outcome = refusalOutcomes[label];
        if (outcome === undefined || outcome.accepted) {
          continue;
        }
        const reply = await workerClient.setDatabaseRules(
          ctx.db as unknown as workerClient.ClientRtdb,
          { rules: { probe: subtree } },
        );
        expect(reply.ok).toBe(false);
        const firstMsg = reply.messages[0] as { text?: string } | undefined;
        if (label !== 'matches with an unterminated character class' && outcome.message !== null) {
          expect(firstMsg?.text ?? '').toContain(outcome.message);
        }
      }

      const ownerRead = await ctx.rtdb.get(ctx.rtdb.ref(authed.db, `guarded/${authed.uid}`));
      expect(ownerRead.val()).toBe('kept');

      let unauthedDenied = false;
      try {
        await ctx.rtdb.get(ctx.rtdb.ref(unauthed.db, `guarded/${authed.uid}`));
      } catch {
        unauthedDenied = true;
      }
      expect(unauthedDenied).toBe(true);

      for (const [label, subtree] of Object.entries(RULES_DEPLOY_REFUSAL_CASES)) {
        const outcome = refusalOutcomes[label];
        if (outcome === undefined || !outcome.accepted) {
          continue;
        }
        const reply = await workerClient.setDatabaseRules(
          ctx.db as unknown as workerClient.ClientRtdb,
          { rules: { probe: subtree } },
        );
        expect(reply.ok).toBe(true);
      }
    });

    for (const { id, paths } of STDLIB_FIXTURES) {
      it(`rtdb#86, #87, #88: replays ${id} compiled from defineRtdbRules`, async () => {
        const scenario = ALL_RULES_RTDB_SCENARIOS.find((entry) => entry.id === id);
        expect(scenario).toBeDefined();
        if (scenario === undefined) {
          return;
        }

        const compiledRules = rtdbRules(defineRtdbRules({ paths })).toJSON() as {
          rules: Record<string, unknown>;
        };
        const scenarioSubtree = JSON.parse(scenario.rules) as Record<string, unknown>;
        const { probes: probeSubtree, ...expectedPatterns } = scenarioSubtree;
        expect(expectedPatterns).toEqual(compiledRules.rules);

        const mountedSubtree: Record<string, unknown> = { ...compiledRules.rules };
        if (probeSubtree !== undefined) {
          mountedSubtree.probes = probeSubtree;
        }
        const fullRules = {
          rules: {
            '.read': false,
            '.write': false,
            [id]: mountedSubtree,
          },
        };

        const ctx = await createContext(fullRules);
        const adminDb = await ctx.openAdminDb();
        const remote = await ctx.openRemoteSandbox();
        authAppSeq += 1;
        const adminApp = initializeAdminApp(
          { sandbox: remote },
          `stdlib-auth-admin-${authAppSeq}`,
        );
        const adminAuth = getAdminAuth(adminApp);

        try {
          const anonSession = await ctx.openAuthedClient(`${id}-anon`);
          const unauthedSession = await ctx.newClient(`${id}-signed-out`);
          const identityClients = new Map<string, { db: ServedRtdbAdminContext['db']; uid: string }>();

          const openIdentitySession = async (
            identity: RtdbCaseIdentity,
          ): Promise<{ db: ServedRtdbAdminContext['db']; uid: string }> => {
            const cacheKey = JSON.stringify(identity);
            const cached = identityClients.get(cacheKey);
            if (cached !== undefined) {
              return cached;
            }
            const uid = `id-user-${identityClients.size + 1}`;
            if (identity.emailDomain !== undefined) {
              await adminAuth.createUser({
                uid,
                email: `${uid}@${identity.emailDomain}`,
                emailVerified: identity.emailVerified ?? false,
              });
            }
            const customToken = await adminAuth.createCustomToken(uid, identity.claims);
            const opened = await ctx.newClient(`${id}-${uid}`);
            const clientAuth = workerClient.getAuth(opened.db as unknown as workerClient.ClientDb);
            await workerClient.signInWithCustomToken(clientAuth, customToken);
            const session = { db: opened.db, uid };
            identityClients.set(cacheKey, session);
            return session;
          };

          const capturedVerdicts = loadRulesRtdbObservation(`rules-rtdb-${id}`);
          const mismatches: string[] = [];

          for (const testCase of scenario.cases) {
            let activeDb = unauthedSession.db;
            let activeUid = anonSession.uid;
            if (testCase.authPresent) {
              if (testCase.identity !== undefined) {
                const customSession = await openIdentitySession(testCase.identity);
                activeDb = customSession.db;
                activeUid = customSession.uid;
              } else {
                activeDb = anonSession.db;
                activeUid = anonSession.uid;
              }
            }

            const seedData = buildSeedSubtree(testCase.seed, activeUid);
            if (Object.keys(seedData).length === 0) {
              await adminDb.ref(id).set(null);
            } else {
              await adminDb.ref(id).set(seedData);
            }

            const targetPath = `${id}${substituteUid(testCase.opPath, activeUid)}`.replace(/\/$/, '');
            const targetRef = ctx.rtdb.ref(activeDb, targetPath);
            let actualVerdict: 'ALLOW' | 'DENY' = 'ALLOW';
            try {
              if (testCase.operation === 'read') {
                await ctx.rtdb.get(targetRef);
              } else if (testCase.operation === 'update') {
                const patch = substituteUid(testCase.newData, activeUid) as Record<string, unknown>;
                await ctx.rtdb.update(targetRef, patch);
              } else {
                const payload = substituteUid(testCase.newData, activeUid);
                await ctx.rtdb.set(targetRef, payload);
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
