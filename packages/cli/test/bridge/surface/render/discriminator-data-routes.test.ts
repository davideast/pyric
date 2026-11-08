/**
 * Behavioral tests for data, Firestore structure, and Storage discriminator
 * routes, including `extract_database_indexes` and `pathsJson` on
 * `extract_firestore_indexes`.
 */
import 'fake-indexeddb/auto';
import { describe, expect, it } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { initializeSandbox } from 'pyric/sandbox';

import { createSurfaceContext, renderSurface } from '../../../../src/bridge/surface/index.js';
import { CANONICAL_OPERATION_IDS } from '../../../../src/bridge/surface/render/canonical-dispatch.js';
import {
  DATA_ROUTES,
  FIRESTORE_STRUCTURE_ROUTES,
  STORAGE_ROUTES,
} from '../../../../src/bridge/surface/render/discriminator-data-routes.js';
import {
  inspectFirestoreStructureSchema,
  querySandboxDataSchema,
} from '../../../../src/bridge/surface/render/discriminator-schemas.js';

describe('discriminator data, firestore structure, and storage routes', () => {
  it('maps every route to a registered canonical operation', () => {
    for (const route of [...DATA_ROUTES, ...FIRESTORE_STRUCTURE_ROUTES, ...STORAGE_ROUTES]) {
      expect(CANONICAL_OPERATION_IDS).toContain(route.operation);
    }
  });

  it('validates querySandboxDataSchema without path and executes extract_database_indexes end-to-end', async () => {
    const extractArgs = {
      service: 'database' as const,
      action: 'extractIndexes' as const,
      pathsJson: '["src"]',
      instance: 'shard-00',
      rulesPath: 'database.shard.json',
      check: true,
    };
    expect(querySandboxDataSchema.safeParse(extractArgs).success).toBe(true);

    const matched = DATA_ROUTES.find((route) => route.selects(extractArgs));
    expect(matched?.operation).toBe('extract_database_indexes');
    expect(matched?.translate(extractArgs)).toEqual({
      paths: ['src'],
      instance: 'shard-00',
      rulesPath: 'database.shard.json',
      check: true,
    });

    const dir = mkdtempSync(join(tmpdir(), 'pyric-discrim-db-idx-'));
    try {
      mkdirSync(join(dir, 'src'), { recursive: true });
      writeFileSync(
        join(dir, 'src/feed.ts'),
        `
          import { getDatabase, orderByChild, query, ref } from 'firebase/database';
          const db = getDatabase();
          export const q = query(ref(db, 'items'), orderByChild('createdAt'));
        `,
      );
      const discSurface = renderSurface('discriminator');
      const queryTool = discSurface.tools.find((t) => t.name === 'query_sandbox_data');
      expect(queryTool).toBeDefined();
      const result = await queryTool!.execute(
        { service: 'database', action: 'extractIndexes', pathsJson: '["src"]' },
        createSurfaceContext(initializeSandbox(), dir),
      );
      expect(result.ok).toBe(true);
      const data = result.data as { requirements: Array<{ path: string; indexOn: string[] }> };
      expect(data.requirements.map((r) => ({ path: r.path, indexOn: r.indexOn }))).toEqual([
        { path: 'items', indexOn: ['createdAt'] },
      ]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('validates and translates queriesJson and pathsJson on inspect_firestore_structure extractIndexes', () => {
    const fsArgs = {
      action: 'extractIndexes' as const,
      queriesJson: '[{"path":"orders"}]',
      pathsJson: '["src"]',
    };
    expect(inspectFirestoreStructureSchema.safeParse(fsArgs).success).toBe(true);

    const fsRoute = FIRESTORE_STRUCTURE_ROUTES.find((route) => route.action === 'extractIndexes');
    expect(fsRoute?.operation).toBe('extract_firestore_indexes');
    expect(fsRoute?.translate(fsArgs)).toEqual({
      queries: [{ path: 'orders' }],
      paths: ['src'],
    });
  });
});
