/** The operation set: the ids the contract fixes, loaded from the directory. */
import { describe, expect, it } from 'bun:test';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

import { OPERATIONS, OPERATIONS_BY_ID } from '../../../src/bridge/surface/operations/index.js';
import {
  renderOperationManifest,
} from '../../../src/bridge/surface/operations/generate-manifest.js';
import { schemaDepth, toJsonSchema } from '../../../src/bridge/surface/json-schema.js';
import { CANONICAL_OPERATION_IDS } from './canonical-operations.js';

const OPERATIONS_DIRECTORY = join(
  import.meta.dir,
  '..',
  '..',
  '..',
  'src',
  'bridge',
  'surface',
  'operations',
);

describe('the loaded operation set', () => {
  it('holds exactly the canonical ids', () => {
    expect([...OPERATIONS_BY_ID.keys()].sort()).toEqual([...CANONICAL_OPERATION_IDS].sort());
  });

  it('loads one record per file with no duplicates', () => {
    expect(OPERATIONS.length).toBe(CANONICAL_OPERATION_IDS.length);
    expect(new Set(OPERATIONS.map((operation) => operation.id)).size).toBe(OPERATIONS.length);
  });

  it('computes the manifest from the directory rather than an authored list', () => {
    const rendered = renderOperationManifest(readdirSync(OPERATIONS_DIRECTORY));
    const committed = readFileSync(join(OPERATIONS_DIRECTORY, 'manifest.generated.ts'), 'utf8');
    expect(rendered).toBe(committed);
  });

  it('keeps every parameter schema within two object levels of the root', () => {
    for (const operation of OPERATIONS) {
      expect(schemaDepth(toJsonSchema(operation.parameters))).toBeLessThanOrEqual(2);
    }
  });

  it('describes every operation for the agent that has to choose it', () => {
    for (const operation of OPERATIONS) {
      expect(operation.description.length).toBeGreaterThan(20);
    }
  });
});
