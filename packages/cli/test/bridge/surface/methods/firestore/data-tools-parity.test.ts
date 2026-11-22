import 'fake-indexeddb/auto';
import { describe, expect, it } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  collection,
  doc,
  getAdminFirestore,
  getDoc,
  getDocs,
  limit,
  orderBy,
  query,
  setDoc,
  writeBatch,
} from 'pyric/firestore';
import { initializeSandbox } from 'pyric/sandbox';
import { setRules } from 'pyric/sandbox/firestore';

import { loadSandboxSnapshot } from '../../../../../src/bridge/server/in-process.js';
import { createSurfaceContext, renderSurface } from '../../../../../src/bridge/surface/index.js';
import getDocsRecord from '../../../../../src/bridge/surface/methods/firestore/getDocs.js';
import setDocRecord from '../../../../../src/bridge/surface/methods/firestore/setDoc.js';
import writeBatchRecord from '../../../../../src/bridge/surface/methods/firestore/writeBatch.js';
import { parseArgs } from '../../../../../src/cli/parse-args.js';
import { runSurfaceMethod } from '../../../../../src/cli/surface-method-runner.js';

const surface = renderSurface(undefined);
if (
  setDocRecord.method !== 'setDoc' ||
  writeBatchRecord.method !== 'writeBatch' ||
  getDocsRecord.method !== 'getDocs'
) {
  throw new Error('unexpected firestore surface method record names');
}

async function callMcp(
  ctx: ReturnType<typeof createSurfaceContext>,
  key: string,
  args: Record<string, unknown> = {},
) {
  const [toolName, method] = key.split('.');
  const tool = surface.tools.find((candidate) => candidate.name === toolName);
  if (tool === undefined) throw new Error(`missing tool ${toolName}`);
  return tool.execute({ method, args }, ctx);
}

async function callCli(cwd: string, key: string, argv: string[]) {
  let stdout = '';
  let stderr = '';
  const code = await runSurfaceMethod(key, parseArgs(argv), {
    cwd,
    stdout: { write: (chunk) => { stdout += chunk; } },
    stderr: { write: (chunk) => { stderr += chunk; } },
    discover: async () => null,
  });
  return { code, stdout, stderr };
}

describe('Firestore MCP and CLI surface parity with pyric/firestore (#1915, #1916, #1917)', () => {
  it('setDoc and writeBatch with merge match the library on missing docs, nested maps, and dotted keys (#1915)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'pyric-fs-merge-'));
    try {
      const mcpSb = initializeSandbox();
      const libSb = initializeSandbox();
      const mcpCtx = createSurfaceContext(mcpSb, join(dir, 'mcp'));
      const libDb = getAdminFirestore(libSb);
      const mcpDb = getAdminFirestore(mcpSb);

      expect(
        (
          await callMcp(mcpCtx, 'firestore.setDoc', {
            path: 'users/missing',
            data: { profile: { name: 'Ada' }, 'a.b': 1 },
            options: { merge: true },
          })
        ).ok,
      ).toBe(true);
      await setDoc(
        doc(libDb, 'users/missing'),
        { profile: { name: 'Ada' }, 'a.b': 1 },
        { merge: true },
      );

      await setDoc(doc(mcpDb, 'users/existing'), { nested: { keep: 2 } });
      await setDoc(doc(libDb, 'users/existing'), { nested: { keep: 2 } });

      expect(
        (
          await callMcp(mcpCtx, 'firestore.setDoc', {
            path: 'users/existing',
            data: { nested: { added: 1 }, 'x.y': 9 },
            options: { merge: true },
          })
        ).ok,
      ).toBe(true);
      await setDoc(
        doc(libDb, 'users/existing'),
        { nested: { added: 1 }, 'x.y': 9 },
        { merge: true },
      );

      expect((await getDoc(doc(mcpDb, 'users/missing'))).data()).toEqual(
        (await getDoc(doc(libDb, 'users/missing'))).data(),
      );
      expect((await getDoc(doc(mcpDb, 'users/existing'))).data()).toEqual({
        nested: { keep: 2, added: 1 },
        'x.y': 9,
      });
      expect((await getDoc(doc(mcpDb, 'users/existing'))).data()).toEqual(
        (await getDoc(doc(libDb, 'users/existing'))).data(),
      );

      await setDoc(doc(mcpDb, 'batches/existing'), { a: { c: 2 } });
      await setDoc(doc(libDb, 'batches/existing'), { a: { c: 2 } });

      const batchMcp = await callMcp(mcpCtx, 'firestore.writeBatch', {
        writes: [
          {
            type: 'set',
            path: 'batches/missing',
            data: { a: { b: 1 }, 'x.y': 5 },
            options: { merge: true },
          },
          {
            type: 'set',
            path: 'batches/existing',
            data: { a: { b: 1 }, 'x.y': 7 },
            options: { merge: true },
          },
        ],
      });
      expect(batchMcp.ok).toBe(true);

      const batch = writeBatch(libDb);
      batch.set(doc(libDb, 'batches/missing'), { a: { b: 1 }, 'x.y': 5 }, { merge: true });
      batch.set(doc(libDb, 'batches/existing'), { a: { b: 1 }, 'x.y': 7 }, { merge: true });
      await batch.commit();

      expect((await getDoc(doc(mcpDb, 'batches/missing'))).data()).toEqual(
        (await getDoc(doc(libDb, 'batches/missing'))).data(),
      );
      expect((await getDoc(doc(mcpDb, 'batches/existing'))).data()).toEqual(
        (await getDoc(doc(libDb, 'batches/existing'))).data(),
      );

      const cliDir = join(dir, 'cli');
      mkdirSync(cliDir, { recursive: true });
      expect(
        (
          await callCli(cliDir, 'firestore.setDoc', [
            'setDoc',
            '--path',
            'cli/existing',
            '--data',
            '{"a":{"c":2}}',
          ])
        ).code,
      ).toBe(0);
      expect(
        (
          await callCli(cliDir, 'firestore.writeBatch', [
            'writeBatch',
            '--writes',
            JSON.stringify([
              { type: 'set', path: 'cli/missing', data: { 'x.y': 3 }, options: { merge: true } },
              {
                type: 'set',
                path: 'cli/existing',
                data: { a: { b: 1 }, 'x.y': 4 },
                options: { merge: true },
              },
            ]),
          ])
        ).code,
      ).toBe(0);

      const verifySb = initializeSandbox();
      loadSandboxSnapshot(verifySb, cliDir);
      const verifyDb = getAdminFirestore(verifySb);
      expect((await getDoc(doc(verifyDb, 'cli/missing'))).data()).toEqual({ 'x.y': 3 });
      expect((await getDoc(doc(verifyDb, 'cli/existing'))).data()).toEqual({
        a: { b: 1, c: 2 },
        'x.y': 4,
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('leaves no write behind when writeBatch fails through MCP or CLI (#1916)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'pyric-fs-batch-atomic-'));
    try {
      const sb = initializeSandbox();
      const ctx = createSurfaceContext(sb, join(dir, 'mcp'));
      const adminDb = getAdminFirestore(sb);

      const missingUpdate = await callMcp(ctx, 'firestore.writeBatch', {
        writes: [
          { type: 'set', path: 'a/first', data: { v: 1 } },
          { type: 'update', path: 'a/missing', data: { v: 2 } },
        ],
      });
      expect(missingUpdate.ok).toBe(false);
      expect((await getDoc(doc(adminDb, 'a/first'))).exists()).toBe(false);

      setRules(
        sb,
        `rules_version = '2';
        service cloud.firestore {
          match /databases/{db}/documents {
            match /open/{id} { allow read, write: if true; }
            match /locked/{id} { allow read, write: if false; }
          }
        }`,
      );
      expect((await callMcp(ctx, 'auth.impersonate', { uid: 'alice' })).ok).toBe(true);

      const rulesDenied = await callMcp(ctx, 'firestore.writeBatch', {
        writes: [
          { type: 'set', path: 'open/first', data: { v: 1 } },
          { type: 'set', path: 'locked/second', data: { v: 2 } },
        ],
      });
      expect(rulesDenied.ok).toBe(false);
      expect((await getDoc(doc(adminDb, 'open/first'))).exists()).toBe(false);

      const cliDir = join(dir, 'cli');
      mkdirSync(cliDir, { recursive: true });
      expect(
        (
          await callCli(cliDir, 'firestore.setDoc', [
            'setDoc',
            '--path',
            'seed/keep',
            '--data',
            '{"seeded":true}',
          ])
        ).code,
      ).toBe(0);
      const cliFailed = await callCli(cliDir, 'firestore.writeBatch', [
        'writeBatch',
        '--writes',
        JSON.stringify([
          { type: 'set', path: 'a/first', data: { v: 1 } },
          { type: 'update', path: 'a/missing', data: { v: 2 } },
        ]),
      ]);
      expect(cliFailed.code).toBe(2);

      const verifySb = initializeSandbox();
      loadSandboxSnapshot(verifySb, cliDir);
      expect((await getDoc(doc(getAdminFirestore(verifySb), 'a/first'))).exists()).toBe(false);
      expect((await getDoc(doc(getAdminFirestore(verifySb), 'seed/keep'))).exists()).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('applies every orderBy before limit and refuses limit: 0 in MCP and CLI (#1917)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'pyric-fs-getdocs-'));
    try {
      const sb = initializeSandbox();
      const ctx = createSurfaceContext(sb, join(dir, 'mcp'));
      const db = getAdminFirestore(sb);

      const rows: Array<[string, string, number]> = [
        ['a', 'tier-b', 1],
        ['b', 'tier-a', 2],
        ['c', 'tier-a', 3],
        ['d', 'tier-b', 3],
        ['e', 'tier-a', 5],
      ];
      for (const [id, tier, score] of rows) {
        await setDoc(doc(db, `scores/${id}`), { tier, score });
      }

      const top2 = await callMcp(ctx, 'firestore.getDocs', {
        path: 'scores',
        constraints: [
          { type: 'orderBy', field: 'score', direction: 'desc' },
          { type: 'limit', value: 2 },
        ],
      });
      const libTop2 = await getDocs(
        query(collection(db, 'scores'), orderBy('score', 'desc'), limit(2)),
      );
      expect(top2.ok).toBe(true);
      expect((top2.data as { docs: Array<{ id: string }> }).docs.map((d) => d.id)).toEqual([
        'e',
        'd',
      ]);
      expect((top2.data as { docs: Array<{ id: string }> }).docs.map((d) => d.id)).toEqual(
        libTop2.docs.map((d) => d.id),
      );

      const compound = await callMcp(ctx, 'firestore.getDocs', {
        path: 'scores',
        constraints: [
          { type: 'orderBy', field: 'score', direction: 'desc' },
          { type: 'orderBy', field: 'tier', direction: 'asc' },
          { type: 'limit', value: 2 },
        ],
      });
      const libCompound = await getDocs(
        query(
          collection(db, 'scores'),
          orderBy('score', 'desc'),
          orderBy('tier', 'asc'),
          limit(2),
        ),
      );
      expect(compound.ok).toBe(true);
      expect((compound.data as { docs: Array<{ id: string }> }).docs.map((d) => d.id)).toEqual([
        'e',
        'c',
      ]);
      expect((compound.data as { docs: Array<{ id: string }> }).docs.map((d) => d.id)).toEqual(
        libCompound.docs.map((d) => d.id),
      );

      const zeroLimit = await callMcp(ctx, 'firestore.getDocs', {
        path: 'scores',
        constraints: [{ type: 'limit', value: 0 }],
      });
      expect(zeroLimit.ok).toBe(false);

      const negativeLimit = await callMcp(ctx, 'firestore.getDocs', {
        path: 'scores',
        constraints: [{ type: 'limit', value: -1 }],
      });
      expect(negativeLimit.ok).toBe(false);

      const cliDir = join(dir, 'cli');
      mkdirSync(cliDir, { recursive: true });
      for (const [id, score] of [['a', 1], ['b', 2], ['c', 3], ['d', 4], ['e', 5]] as const) {
        await callCli(cliDir, 'firestore.setDoc', [
          'setDoc',
          '--path',
          `scores/${id}`,
          '--data',
          JSON.stringify({ score }),
        ]);
      }
      const cliTop2 = await callCli(cliDir, 'firestore.getDocs', [
        'getDocs',
        '--path',
        'scores',
        '--constraints',
        JSON.stringify([
          { type: 'orderBy', field: 'score', direction: 'desc' },
          { type: 'limit', value: 2 },
        ]),
        '--json',
      ]);
      expect(cliTop2.code).toBe(0);
      expect(
        (JSON.parse(cliTop2.stdout).data as { docs: Array<{ id: string }> }).docs.map((d) => d.id),
      ).toEqual(['e', 'd']);

      const cliZero = await callCli(cliDir, 'firestore.getDocs', [
        'getDocs',
        '--path',
        'scores',
        '--constraints',
        JSON.stringify([{ type: 'limit', value: 0 }]),
      ]);
      expect(cliZero.code).toBe(2);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
