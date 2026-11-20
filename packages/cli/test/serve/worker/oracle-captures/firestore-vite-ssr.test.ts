import { afterEach, beforeAll, describe, expect, it } from 'bun:test';
import { EventEmitter } from 'node:events';
import type { AddressInfo } from 'node:net';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { ViteDevServer } from 'vite';
import { deleteApp as deleteAdminApp, initializeApp as initializeAdminApp } from 'pyric-admin/app';
import { getFirestore as getAdminFirestore } from 'pyric-admin/firestore';
import { observeFirestoreAdminSnapshotAndReferenceMetadata } from '../../../../../conformance/probes/firestore-admin/firestore-admin-snapshot-and-reference-metadata.ts';
import {
  buildWriteAndCrossDocRulesBlock,
  seedDataForWriteAndCrossDoc,
} from '../../../../../conformance/probes/firestore/firestore-rules-write-and-cross-doc-verdicts.ts';
import { bundleWorker, workerSourceHash } from '../../../../src/serve/bundler.js';
import { attachViteSsrActivation } from '../../../../src/serve/vite-ssr-activation.js';
import { buildFirestoreSsrScripts, runPlainNodeScript } from './firestore-vite-ssr-scripts.ts';
import {
  cleanupFirestoreViteSsrFixtures,
  createFirestoreViteSsrProjectDir,
  createSsrAdminSnapshotMetaSubject,
  loadFirestoreAdminSnapshotMetaBehavior,
  loadFirestoreWriteCrossDocBehavior,
  openFirestoreHostedServerHost,
} from './firestore-vite-ssr-support.ts';
import { restoreSharedWorker } from './support.ts';

restoreSharedWorker();

const DENY_ALL_FIRESTORE_RULES = `rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /{document=**} { allow read, write: if false; }
  }
}
`;

function wrapFirestoreRulesBlock(block: string): string {
  return `rules_version = '2';\nservice cloud.firestore {\n  match /databases/{database}/documents {\n${block}\n    match /{document=**} { allow read, write: if false; }\n  }\n}\n`;
}

function fakeListeningViteServer(port: number): ViteDevServer {
  const address: AddressInfo = { address: '127.0.0.1', family: 'IPv4', port };
  const http = Object.assign(new EventEmitter(), {
    listening: true,
    address: () => address,
  });
  return { httpServer: http } as unknown as ViteDevServer;
}

beforeAll(async () => {
  await bundleWorker({ outDir: join(homedir(), '.pyric', 'vite-worker', workerSourceHash()) });
}, 60_000);

afterEach(async () => {
  await cleanupFirestoreViteSsrFixtures();
});

describe('Firestore server-rendered modules under vite dev (RS2 & RS3)', () => {
  it('replays firestore-admin-snapshot-and-reference-metadata via attachViteSsrActivation bare initializeApp past deny-all rules (RS3)', async () => {
    const host = await openFirestoreHostedServerHost(DENY_ALL_FIRESTORE_RULES);
    const port = Number(new URL(host.serveUrl).port);
    const activation = attachViteSsrActivation(fakeListeningViteServer(port), true, {});
    const bareAdminApp = initializeAdminApp(undefined, `rs3-fs-bare-ssr-admin-${Date.now()}`);
    try {
      const ssrAdminDb = getAdminFirestore(bareAdminApp);
      const subject = createSsrAdminSnapshotMetaSubject(ssrAdminDb, 'pyric_oracle/ssr_rs3_meta');
      const actual = await observeFirestoreAdminSnapshotAndReferenceMetadata(subject);
      expect(actual).toEqual(loadFirestoreAdminSnapshotMetaBehavior());
    } finally {
      await deleteAdminApp(bareAdminApp);
      activation.close();
    }
  }, 25_000);

  it('replays firestore-rules-write-and-cross-doc-verdicts across Vite ssrLoadModule client & admin modules, releases on server.close, and refuses SharedWorker (RS2 & RS3)', async () => {
    const expectedVerdicts = loadFirestoreWriteCrossDocBehavior();
    const runId = 'vite_ssr_wc';
    const basePath = `__pyric_fs_probe/${runId}`;
    const plainUid = 'bob_ssr';
    const rulesSource = wrapFirestoreRulesBlock(buildWriteAndCrossDocRulesBlock(runId));
    const seedEntries = seedDataForWriteAndCrossDoc(plainUid);
    const { sharedWorkerScript, hostedScript } = buildFirestoreSsrScripts(basePath, plainUid, seedEntries);

    const swDir = createFirestoreViteSsrProjectDir(rulesSource);
    const swRes = await runPlainNodeScript(swDir, 'run-fs-vite-sw.mjs', sharedWorkerScript, 30_000);
    expect(swRes.status, swRes.stderr).toBe(0);
    const swLine = swRes.stdout.split('\n').find((line) => line.startsWith('VITE_SW_REFUSAL '));
    expect(swLine).toBeDefined();
    let rawSwLine = 'VITE_SW_REFUSAL {}';
    if (typeof swLine === 'string') rawSwLine = swLine;
    const swOut = JSON.parse(rawSwLine.slice('VITE_SW_REFUSAL '.length)) as {
      rs2Refusal: { code: string | null; message: string };
      rs3Refusal: { code: string | null; message: string };
    };
    expect(swOut.rs2Refusal.code).toBe('failed-precondition');
    expect(swOut.rs2Refusal.message).toContain('pyric({ hosted: true })');
    expect(swOut.rs3Refusal.code).toBe('failed-precondition');
    expect(swOut.rs3Refusal.message).toContain('pyric({ hosted: true })');

    const viteDir = createFirestoreViteSsrProjectDir(rulesSource);
    const res = await runPlainNodeScript(viteDir, 'run-fs-vite-ssr.mjs', hostedScript, 45_000);
    expect(res.status, res.stderr).toBe(0);
    const outLine = res.stdout.split('\n').find((line) => line.startsWith('VITE_SSR_RESULT '));
    expect(outLine).toBeDefined();
    let rawOutLine = 'VITE_SSR_RESULT {}';
    if (typeof outLine === 'string') rawOutLine = outLine;
    const out = JSON.parse(rawOutLine.slice('VITE_SSR_RESULT '.length)) as {
      verdicts: Record<string, unknown>;
      sharedSession: { appCount: number; uid: string };
      adminReadBack: { ownedDoc: unknown; claimedDoc: unknown; browserDoc: unknown };
    };

    expect(out.verdicts).toEqual(expectedVerdicts);
    expect(out.sharedSession).toEqual({
      appCount: 1,
      uid: 'editor_ssr',
    });
    expect(out.adminReadBack).toEqual({
      ownedDoc: { owner: plainUid, count: 2 },
      claimedDoc: { edited: true },
      browserDoc: { from: 'browser-client' },
    });
  }, 60_000);
});
