/**
 * Five-surface MCP entrypoint parity suite (`SURFACE_VARIANT_IDS`).
 *
 * Exercises `sdk-service`, `discriminator`, `verb-prefixed`, `noun-prefixed`,
 * and `verb-suffixed` end-to-end through real `McpServer` + `Client` transports
 * to verify:
 * 1. Caller identity fidelity (`tenantId`, `customClaims`, fresh `default`
 *    session isolation, and stored-user `uid` lookup) across `TargetRouter` ->
 *    hosted runtime.
 * 2. Isolated Functions `[DEFAULT]` app initialization parity, `pyric.json`
 *    project resolution, configured default RTDB instance agreement across
 *    `listTriggers` and `fire`, and `Worker` thread sandbox connectivity.
 * 3. Firestore document & collection reads, Realtime Database reads, Cloud
 *    Storage metadata reads, event stream reads, and RFC 3986 percent-decoding
 *    (including malformed percent-sequence rejection) on resource templates.
 */
import 'fake-indexeddb/auto';
import { describe, expect, it } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve as resolvePath } from 'node:path';

import { TargetRouter } from '../../src/bridge/server/target-router.js';
import { SURFACE_VARIANT_IDS } from '../../src/bridge/surface/index.js';
import { createHostedRuntime } from '../../src/serve/hosted/runtime.js';
import {
  callMethodOnVariant,
  fireTriggerOnVariant,
  impersonateUser,
  importUsers,
  listFirestoreCollection,
  listTriggersOnVariant,
  makeHostedInit,
  makeInMemoryPersistence,
  openHostedLoopbackBridge,
  openMcpVariant,
  parseResourceEnvelope,
  parseToolEnvelope,
  readDatabaseValue,
  readFirestoreDoc,
  readStorageMetadata,
  setDatabaseValue,
  setFirestoreDoc,
  switchAdmin,
  switchAnonymous,
  uploadStorageObject,
} from './five-surface-parity-harness.js';

describe('five-surface MCP entrypoint parity', () => {
  for (const variant of SURFACE_VARIANT_IDS) {
    it(`[${variant}] preserves caller identity tenantId, customClaims, fresh default mode, and stored uid lookup over hosted TargetRouter`, async () => {
      const dir = mkdtempSync(join(tmpdir(), `pyric-5surf-id-${variant}-`));
      writeFileSync(join(dir, '.firebaserc'), JSON.stringify({ projects: { default: 'org-alpha' } }));
      writeFileSync(join(dir, 'firebase.json'), JSON.stringify({}));

      const hostRuntime = await createHostedRuntime(
        makeHostedInit('org-alpha'),
        'http://127.0.0.1:4210',
        () => {},
        dir,
        { persistence: makeInMemoryPersistence() as never, record: false },
      );
      await hostRuntime.deployRules(
        'firestore',
        [
          "rules_version = '2';",
          'service cloud.firestore {',
          '  match /databases/{database}/documents {',
          '    match /orgs/{orgId} {',
          '      allow read, write: if request.auth != null && request.auth.token.firebase.tenant == orgId;',
          '    }',
          '    match /items/{id} {',
          "      allow read, write: if request.auth != null && request.auth.token.get('suspended', false) != true;",
          '    }',
          '  }',
          '}',
        ].join('\n'),
      );

      const makeRouter = () => {
        const conn = {};
        return new TargetRouter({
          projectDir: dir,
          cacheTtlMs: 0,
          discover: async () => ({
            pointerProjectDir: dir,
            url: 'http://localhost:4210',
            base: 'http://127.0.0.1:4210',
            mcpUrl: 'http://127.0.0.1:4210/__pyric/mcp',
            instanceId: hostRuntime.instanceId,
            source: `pointer ${join(dir, '.pyric', 'serve.json')}`,
          }),
          callHosted: async (_host, key, args, projectDir, allowProduction) =>
            hostRuntime.runMethod(
              { instanceId: hostRuntime.instanceId, projectDir, key, args, allowProduction },
              conn,
            ),
        });
      };

      const sessionA = await openMcpVariant(variant, dir, makeRouter());
      const sessionB = await openMcpVariant(variant, dir, makeRouter());
      try {
        expect((await switchAnonymous(sessionA)).ok).toBe(true);
        await hostRuntime.runMethod(
          {
            instanceId: hostRuntime.instanceId,
            projectDir: dir,
            key: 'auth.actAsAnonymous',
            args: {},
            allowProduction: false,
          },
          {},
        );
        expect((await setFirestoreDoc(sessionA, 'items/anon-blocked', { v: 1 })).ok).toBe(false);

        expect((await setFirestoreDoc(sessionB, 'items/default-fresh', { v: 1 })).ok).toBe(true);

        expect(
          (await impersonateUser(sessionB, 'user-1', 'org-alpha', { suspended: true })).ok,
        ).toBe(true);
        expect((await setFirestoreDoc(sessionB, 'items/suspended-blocked', { v: 2 })).ok).toBe(
          false,
        );
        expect((await setFirestoreDoc(sessionB, 'orgs/org-alpha', { name: 'alpha' })).ok).toBe(
          true,
        );
        expect((await setFirestoreDoc(sessionB, 'orgs/org-beta', { name: 'beta' })).ok).toBe(false);

        expect((await switchAdmin(sessionB)).ok).toBe(true);
        expect(
          (
            await importUsers(sessionB, [
              { uid: 'stored-member', email: 'member@example.test', tenantId: 'org-alpha' },
            ])
          ).ok,
        ).toBe(true);

        if (variant === 'discriminator') {
          const perCallWrite = parseToolEnvelope(
            await sessionB.client.callTool({
              name: 'mutate_sandbox_data',
              arguments: {
                service: 'firestore',
                action: 'set',
                path: 'orgs/org-alpha',
                dataJson: JSON.stringify({ via: 'per-call-uid' }),
                auth: { mode: 'uid', uid: 'stored-member' },
              },
            }),
          );
          expect(perCallWrite.ok).toBe(true);
        } else {
          const sim = await callMethodOnVariant(sessionB, 'rules.simulate', {
            service: 'firestore',
            operation: 'get',
            path: 'orgs/org-alpha',
            uid: 'stored-member',
          });
          expect(sim.ok).toBe(true);
          expect((sim.data as { allowed?: boolean }).allowed).toBe(true);

          expect((await impersonateUser(sessionB, 'stored-member')).ok).toBe(true);
          expect((await setFirestoreDoc(sessionB, 'orgs/org-alpha', { via: 'stored-uid' })).ok).toBe(
            true,
          );
        }
      } finally {
        await sessionA.close();
        await sessionB.close();
        await hostRuntime.close();
        rmSync(dir, { recursive: true, force: true });
      }
    });

    it(`[${variant}] preserves Functions [DEFAULT] app init, pyric.json project, custom default RTDB instance, and Worker writes`, async () => {
      const dir = mkdtempSync(join(tmpdir(), `pyric-5surf-fn-${variant}-`));
      const fnDir = join(dir, 'functions');
      mkdirSync(fnDir, { recursive: true });
      symlinkSync(
        resolvePath(import.meta.dir, '../../../conformance/node_modules'),
        join(fnDir, 'node_modules'),
        'dir',
      );
      writeFileSync(join(dir, 'pyric.json'), JSON.stringify({ project: 'org-alpha' }));
      writeFileSync(join(dir, 'database.rules.json'), JSON.stringify({ rules: { '.read': true, '.write': true } }));
      writeFileSync(
        join(dir, 'firebase.json'),
        JSON.stringify({
          functions: { source: 'functions' },
          database: [{ instance: 'custom-rtdb', rules: 'database.rules.json' }],
        }),
      );
      writeFileSync(
        join(fnDir, 'package.json'),
        JSON.stringify({ name: 'parity-fn', type: 'module', main: 'index.mjs' }),
      );
      writeFileSync(
        join(fnDir, 'index.mjs'),
        [
          "import { Worker } from 'node:worker_threads';",
          "import { getApp, getApps, initializeApp } from 'firebase-admin/app';",
          "import { onValueCreated } from 'firebase-functions/v2/database';",
          'const appsAtModuleLoad = getApps().length;',
          'const cfg = JSON.parse(process.env.FIREBASE_CONFIG ?? "{}");',
          'const defaultInstance = cfg.databaseURL ? new URL(cfg.databaseURL).hostname.split(".")[0] : "unset";',
          'initializeApp({',
          "  projectId: 'org-alpha',",
          "  storageBucket: 'org-alpha-custom-bucket',",
          "  databaseURL: 'https://custom-rtdb.firebaseio.com',",
          '});',
          'export const onItemCreated = onValueCreated(',
          "  { ref: '/items/{itemId}', instance: defaultInstance },",
          '  async (event) => {',
          '    const workerCode = [',
          "      \"import { parentPort, workerData } from 'node:worker_threads';\",",
          "      \"import { initializeApp } from 'firebase-admin/app';\",",
          "      \"import { getFirestore } from 'firebase-admin/firestore';\",",
          "      \"const app = initializeApp({ projectId: 'org-alpha' }, 'worker-app');\",",
          "      \"await getFirestore(app).doc('workerItems/' + workerData.itemId).set({ ok: true });\",",
          "      'parentPort.postMessage(true);',",
          "    ].join('\\n');",
          '    await new Promise((resolve, reject) => {',
          '      const worker = new Worker(workerCode, { eval: true, workerData: { itemId: event.params.itemId } });',
          "      worker.once('message', resolve);",
          "      worker.once('error', reject);",
          '    });',
          "    await event.data.ref.parent.parent.child('processed').child(event.params.itemId).set({ done: true });",
          '    return {',
          '      appsAtModuleLoad,',
          '      gcloudProject: process.env.GCLOUD_PROJECT ?? null,',
          '      storageBucket: getApp().options.storageBucket ?? null,',
          '    };',
          '  },',
          ');',
        ].join('\n'),
      );

      const hostedBridge = await openHostedLoopbackBridge(dir);
      const inProcSession = await openMcpVariant(variant, dir);
      const hostedSession = await openMcpVariant(variant, dir, hostedBridge.makeRouter());
      try {
        for (const [planeIndex, session] of [inProcSession, hostedSession].entries()) {
          const itemId = `k${planeIndex + 1}`;
          const listed = await listTriggersOnVariant(session);
          expect(listed.ok).toBe(true);
          const triggers = (listed.data as { triggers: Array<{ name: string; instance: string }> })
            .triggers;
          expect(triggers).toHaveLength(1);
          expect(triggers[0]?.instance).toBe('custom-rtdb');

          const fired = await fireTriggerOnVariant(session, 'onItemCreated', `items/${itemId}`, {
            title: 'alpha',
          });
          expect(fired.ok).toBe(true);
          const fireData = fired.data as {
            event: { instance: string };
            result: {
              appsAtModuleLoad: number;
              gcloudProject: string | null;
              storageBucket: string | null;
            };
          };
          expect(fireData.event.instance).toBe('custom-rtdb');
          expect(fireData.result.appsAtModuleLoad).toBe(0);
          expect(fireData.result.gcloudProject).toBe('org-alpha');
          expect(fireData.result.storageBucket).toBe('org-alpha-custom-bucket');

          const workerDoc = await readFirestoreDoc(session, `workerItems/${itemId}`);
          expect(workerDoc.ok).toBe(true);
          expect((workerDoc.data as { exists?: boolean }).exists).toBe(true);

          const rtdbProcessed = await readDatabaseValue(session, `processed/${itemId}`);
          expect(rtdbProcessed.ok).toBe(true);
          expect((rtdbProcessed.data as { value?: unknown }).value).toEqual({ done: true });
        }
      } finally {
        await inProcSession.close();
        await hostedSession.close();
        await hostedBridge.close();
        rmSync(dir, { recursive: true, force: true });
      }
    });

    it(`[${variant}] reads documents, collections, database paths, storage metadata, and RFC 3986 percent-encoded resource URIs`, async () => {
      const dir = mkdtempSync(join(tmpdir(), `pyric-5surf-res-${variant}-`));
      const session = await openMcpVariant(variant, dir);
      try {
        expect((await setFirestoreDoc(session, 'items/item-1', { n: 1 })).ok).toBe(true);
        expect((await setFirestoreDoc(session, 'items/item 2', { n: 2 })).ok).toBe(true);
        expect((await setFirestoreDoc(session, 'users/alice@example.com', { active: true })).ok).toBe(
          true,
        );
        expect(
          (await setFirestoreDoc(session, 'orgs/org 1/members/m1', { role: 'owner' })).ok,
        ).toBe(true);
        expect((await setDatabaseValue(session, 'rooms/main lobby', { open: true })).ok).toBe(true);
        expect(
          (
            await uploadStorageObject(
              session,
              'docs/report 2026 @ final.txt',
              Buffer.from('summary').toString('base64'),
            )
          ).ok,
        ).toBe(true);

        const plainDoc = await readFirestoreDoc(session, 'items/item-1');
        expect(plainDoc.ok).toBe(true);
        expect((plainDoc.data as { exists?: boolean }).exists).toBe(true);

        const spacedDoc = await readFirestoreDoc(session, 'items/item 2', 'items/item%202');
        expect(spacedDoc.ok).toBe(true);
        expect((spacedDoc.data as { exists?: boolean }).exists).toBe(true);

        const emailDoc = await readFirestoreDoc(
          session,
          'users/alice@example.com',
          'users/alice%40example.com',
        );
        expect(emailDoc.ok).toBe(true);
        expect((emailDoc.data as { exists?: boolean }).exists).toBe(true);

        const collectionListing = await listFirestoreCollection(session, 'items');
        expect(collectionListing.ok).toBe(true);
        expect(((collectionListing.data as { docs?: unknown[] }).docs ?? []).length).toBe(2);

        const subcollectionListing = await listFirestoreCollection(
          session,
          'orgs/org 1/members',
          'orgs/org%201/members',
        );
        expect(subcollectionListing.ok).toBe(true);
        expect(((subcollectionListing.data as { docs?: unknown[] }).docs ?? []).length).toBe(1);

        const spacedRtdb = await readDatabaseValue(
          session,
          'rooms/main lobby',
          'rooms/main%20lobby',
        );
        expect(spacedRtdb.ok).toBe(true);
        expect((spacedRtdb.data as { value?: unknown }).value).toEqual({ open: true });

        const spacedStorage = await readStorageMetadata(
          session,
          'docs/report 2026 @ final.txt',
          'docs/report%202026%20%40%20final.txt',
        );
        expect(spacedStorage.ok).toBe(true);

        if (variant === 'discriminator') {
          const slashEncodedDoc = await readFirestoreDoc(
            session,
            'items/item 2',
            'items%2Fitem%202',
          );
          expect(slashEncodedDoc.ok).toBe(true);
          expect((slashEncodedDoc.data as { exists?: boolean }).exists).toBe(true);

          const slashEncodedStorage = await readStorageMetadata(
            session,
            'docs/report 2026 @ final.txt',
            'docs%2Freport%202026%20%40%20final.txt',
          );
          expect(slashEncodedStorage.ok).toBe(true);

          const eventsRead = parseResourceEnvelope(
            await session.client.readResource({ uri: 'pyric://sandbox/events' }),
          );
          expect(eventsRead.ok).toBe(true);

          for (const badUri of [
            'pyric://firestore/docs/items/bad%ZZ',
            'pyric://storage/objects/docs/bad%E0%A4%A.txt',
            'pyric://database/tree/rooms/bad%2',
            'pyric://firestore/docs/items/item-1/../../secrets/s1',
            'pyric://firestore/docs/items/item-1/%2e%2e/%2e%2e/secrets/s1',
            'pyric://firestore/docs/items%2Fitem-1%2F..%2F..%2Fsecrets%2Fs1',
            'pyric://firestore/docs/items/..',
            'pyric://firestore/docs/items/.',
            'pyric://storage/objects/docs%2F..%2Fsecrets%2Fkey.txt',
            'pyric://database/tree/rooms/../secrets',
            'pyric://stdlib/rules/..%2F..%2Fpackage.json',
          ]) {
            const malformed = parseResourceEnvelope(
              await session.client.readResource({ uri: badUri }),
            );
            expect(malformed.ok).toBe(false);
            expect((malformed.data as { code?: string } | undefined)?.code).toBe(
              'invalid_arguments',
            );
          }
        }
      } finally {
        await session.close();
        rmSync(dir, { recursive: true, force: true });
      }
    });
  }
});
