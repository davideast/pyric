#!/usr/bin/env bun
/**
 * Captures what production Firestore rules see as `request.resource.data` for
 * single-document client writes. A probe ruleset guarded by one rule per
 * (case, predicate) is deployed temporarily, each case's write is applied by
 * the Web SDK to a document seeded through the admin SDK, and the write's
 * allow or deny verdict is recorded per predicate. The prior release is
 * restored and verified in a `finally` path, and the run's documents are
 * deleted.
 */
import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { deleteApp, initializeApp, type FirebaseOptions } from 'firebase/app';
import { getAuth, signInWithCustomToken } from 'firebase/auth';
import {
  FieldPath,
  deleteField,
  doc,
  getFirestore,
  setDoc,
  terminate,
  updateDoc,
} from 'firebase/firestore';
import { cert, deleteApp as deleteAdminApp, initializeApp as initializeAdminApp } from 'firebase-admin/app';
import { getAuth as getAdminAuth } from 'firebase-admin/auth';
import { getFirestore as getAdminFirestore } from 'firebase-admin/firestore';
import { acquireRunLock } from './storage-stdlib-real-lock.ts';
import { resolvedFirebaseVersion } from './package-version.ts';
import {
  FIREBASE_API,
  accessHeaders,
  jsonRequest,
  resolveServiceAccount,
  type AccessHeaders,
  type ServiceAccount,
  type WebConfig,
} from './storage-stdlib-real-api.ts';
import {
  activateFirestoreRules,
  replaceSelectedRulesFile,
  restoreFirestoreRules,
  selectFirestoreRulesFile,
  snapshotFirestoreRules,
} from './firestore-real-rules.ts';
import {
  SEED_DOCUMENT,
  WRITE_CASES,
  applyWrite,
  predicateDocId,
  writeProjectionRules,
  type WriteSdk,
} from './firestore-write-request-resource-cases.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
const OBSERVATION_PATH = join(
  HERE,
  '..',
  'observations',
  'firestore',
  'firestore-write-request-resource.json',
);
const LOCK_PATH = '/tmp/pyric-firestore-real.lock';
const DOCUMENTS_MATCH = /match\s+\/databases\/\{database\}\/documents\s*\{/;

const sdk: WriteSdk = {
  updateDoc: (ref, ...args) =>
    (updateDoc as (...a: unknown[]) => Promise<void>)(ref, ...args),
  setDoc: (ref, data, options) =>
    (setDoc as (...a: unknown[]) => Promise<void>)(ref, data, options),
  deleteField,
  FieldPath: FieldPath as unknown as WriteSdk['FieldPath'],
};

async function discoverWebConfig(sa: ServiceAccount, headers: AccessHeaders): Promise<WebConfig> {
  const listed = await jsonRequest<{ apps?: Array<{ appId: string }> }>(
    `${FIREBASE_API}/projects/${sa.project_id}/webApps`,
    { headers: headers.auth },
    'list Firebase Web Apps',
  );
  const appId = listed.apps?.[0]?.appId;
  if (!appId) throw new Error('oracle project has no Web App');
  return jsonRequest<WebConfig>(
    `${FIREBASE_API}/projects/${sa.project_id}/webApps/${encodeURIComponent(appId)}/config`,
    { headers: headers.auth },
    'read Firebase Web App config',
  );
}

function injectProbeRules(source: string, runId: string): string {
  const found = DOCUMENTS_MATCH.exec(source);
  if (!found) throw new Error('current rules lack canonical documents match block');
  const insertAt = found.index + found[0].length;
  const block = `\n    match /__pyric_firestore_cdd/${runId} {\n${writeProjectionRules()}\n    }\n`;
  return `${source.slice(0, insertAt)}${block}${source.slice(insertAt)}`;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Admin calls occasionally fail with a transient UNAUTHENTICATED on token refresh. */
async function withAdminRetry<T>(op: () => Promise<T>): Promise<T> {
  let last: unknown;
  for (let attempt = 0; attempt < 4; attempt += 1) {
    try {
      return await op();
    } catch (error) {
      last = error;
      if ((error as { code?: unknown }).code !== 16) throw error;
      await sleep(1_000);
    }
  }
  throw last;
}

async function run(): Promise<void> {
  const credentialPath = process.env.PYRIC_ORACLE_SA_PATH;
  if (!credentialPath) {
    console.log('[write-request-resource] inert: set PYRIC_ORACLE_SA_PATH to capture.');
    return;
  }
  const releaseLock = acquireRunLock(LOCK_PATH);
  try {
    const sa = resolveServiceAccount(credentialPath);
    const headers = await accessHeaders(sa);
    const web = await discoverWebConfig(sa, headers);
    if (web.projectId !== sa.project_id) throw new Error('Web config and service account target different projects');
    const runId = `w${Date.now().toString(36)}`;
    const snapshot = await snapshotFirestoreRules(sa, headers);
    const selected = selectFirestoreRulesFile(snapshot.ruleset);
    const content = injectProbeRules(selected.content, runId);
    const files = replaceSelectedRulesFile(snapshot.ruleset, selected, content);

    const admin = initializeAdminApp({ credential: cert(sa as Parameters<typeof cert>[0]) }, `pyric-wrr-admin-${runId}`);
    const adminDb = getAdminFirestore(admin);
    const app = initializeApp(web as FirebaseOptions, `pyric-wrr-${runId}`);
    const db = getFirestore(app);
    const base = `__pyric_firestore_cdd/${runId}/wrr`;
    const seeded: string[] = [];
    let activated = false;
    let probeRulesetName: string | undefined;
    let restoreVerified = false;
    const results: Array<Record<string, unknown>> = [];
    try {
      const token = await getAdminAuth(admin).createCustomToken(`pyric-wrr-${runId}`);
      await signInWithCustomToken(getAuth(app), token);

      const seed = async (id: string) => {
        await withAdminRetry(() =>
          adminDb.doc(`${base}/${id}`).set(JSON.parse(JSON.stringify(SEED_DOCUMENT))),
        );
        if (!seeded.includes(id)) seeded.push(id);
      };

      activated = true;
      probeRulesetName = await activateFirestoreRules(sa, headers, snapshot, files);

      // Wait until the probe ruleset serves the data plane: the constant-true
      // predicate must allow three consecutive writes.
      const warmId = predicateDocId('control', 'always_true');
      const deadline = Date.now() + 90_000;
      let consecutive = 0;
      while (consecutive < 5) {
        if (Date.now() > deadline) throw new Error('probe rules did not reach the data plane');
        await seed(warmId);
        try {
          await updateDoc(doc(db, `${base}/${warmId}`), { keep: 2 });
          consecutive += 1;
          await sleep(1_000);
        } catch (error) {
          if ((error as { code?: unknown }).code !== 'permission-denied') throw error;
          consecutive = 0;
          await sleep(1_000);
        }
      }

      // Replicas pick up a new ruleset at different times; settle before reading verdicts.
      await sleep(15_000);

      for (const c of WRITE_CASES) {
        for (const p of c.predicates) {
          const id = predicateDocId(c.id, p.id);
          await seed(id);
          let verdict: 'allow' | 'deny';
          let code: string | null = null;
          try {
            await applyWrite(sdk, doc(db, `${base}/${id}`), c.write);
            verdict = 'allow';
          } catch (error) {
            const found = (error as { code?: unknown }).code;
            if (found !== 'permission-denied') throw error;
            verdict = 'deny';
            code = String(found);
          }
          const stored =
            (await withAdminRetry(() => adminDb.doc(`${base}/${id}`).get())).data() ?? null;
          results.push({ case: c.id, predicate: p.id, verdict, code, stored });
          console.log(`[write-request-resource] ${c.id}/${p.id}: ${verdict}`);
        }
      }
    } finally {
      try {
        await Promise.allSettled(
          seeded.map((id) => withAdminRetry(() => adminDb.doc(`${base}/${id}`).delete())),
        );
        await Promise.allSettled([terminate(db)]);
        await Promise.allSettled([deleteApp(app)]);
      } finally {
        if (activated) {
          await restoreFirestoreRules(headers, snapshot);
          restoreVerified = true;
        }
        await deleteAdminApp(admin);
      }
    }
    if (!probeRulesetName || !restoreVerified) throw new Error('capture did not complete with verified rules restoration');

    const observation = {
      name: 'firestore-write-request-resource',
      matrixRow: 'firestore #137a',
      rowIds: ['firestore#137a'],
      description:
        'Authenticated Web SDK single-document writes against temporarily deployed production rules. Each predicate over request.resource.data, resource.data, and request.resource.data.diff(resource.data) is a separate guarded rule, so the allow or deny verdict of the write reads out what the rules engine built for it. Covers a dotted updateDoc key, FieldPath updates with literal dots, a dotted deleteField, setDoc merge and mergeFields, a nested map replace, and a non-merge setDoc.',
      observedAt: new Date().toISOString(),
      fbSdkVersion: resolvedFirebaseVersion(),
      projectId: sa.project_id,
      inputDigest: createHash('sha256').update(content).digest('hex'),
      lifecycle: {
        originalRulesetName: snapshot.release.rulesetName,
        probeRulesetName,
        restoredOriginalRelease: restoreVerified,
      },
      behavior: {
        seed: SEED_DOCUMENT,
        cases: WRITE_CASES.map((c) => ({
          case: c.id,
          description: c.description,
          write: c.write,
          predicates: c.predicates.map((p) => {
            const r = results.find((x) => x.case === c.id && x.predicate === p.id);
            return { id: p.id, expr: p.expr, verdict: r?.verdict, stored: r?.stored };
          }),
        })),
      },
    };
    mkdirSync(dirname(OBSERVATION_PATH), { recursive: true });
    writeFileSync(OBSERVATION_PATH, `${JSON.stringify(observation, null, 2)}\n`);
    console.log(`[write-request-resource] captured ${OBSERVATION_PATH}`);
  } finally {
    releaseLock();
  }
}

await run();
