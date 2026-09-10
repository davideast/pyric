/**
 * The loaded record set: the directory is the index, the path is the key, and
 * every canonical operation is reachable through exactly the records that name
 * it.
 */
import { describe, expect, it } from 'bun:test';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

import {
  renderSurfaceManifest,
  surfaceSources,
} from '../../../scripts/generate-surface-manifest.js';
import { schemaDepth, toJsonSchema } from '../../../src/bridge/surface/json-schema.js';
import { operationIds } from '../../../src/bridge/surface/method-types.js';
import { METHODS, TOOLS } from '../../../src/bridge/surface/methods/registry.js';
import { CANONICAL_OPERATION_IDS } from '../../../src/bridge/surface/render/canonical-dispatch.js';

const SURFACE_DIRECTORY = join(
  import.meta.dir,
  '..',
  '..',
  '..',
  'src',
  'bridge',
  'surface',
);

const EFFECTS = ['read', 'write', 'destructive', 'production'];

describe('the loaded record set', () => {
  it('renders the six service tools in a stable order', () => {
    expect(TOOLS.map((tool) => tool.name)).toEqual([
      'firestore',
      'database',
      'storage',
      'auth',
      'rules',
      'sandbox',
    ]);
  });

  it('stamps every record with the tool and method its path carries', () => {
    for (const method of METHODS) {
      expect(method.key).toBe(`${method.tool}.${method.method}`);
      const owner = TOOLS.find((tool) => tool.methods.includes(method));
      expect(owner?.name).toBe(method.tool);
    }
  });

  it('computes the manifest from the directories rather than an authored list', () => {
    const sources = surfaceSources(readdirSync(join(SURFACE_DIRECTORY, 'tools')), (tool) =>
      readdirSync(join(SURFACE_DIRECTORY, 'methods', tool)),
    );
    const committed = readFileSync(join(SURFACE_DIRECTORY, 'manifest.generated.ts'), 'utf8');
    expect(renderSurfaceManifest(sources)).toBe(committed);
  });

  it('reaches every canonical operation and names no other', () => {
    const reached = new Set(METHODS.flatMap((method) => operationIds(method)));
    expect([...reached].sort()).toEqual([...CANONICAL_OPERATION_IDS].sort());
  });

  it('carries an effect class on every record', () => {
    for (const method of METHODS) {
      expect(EFFECTS).toContain(method.effect);
    }
  });

  it('marks every method that replaces or discards state destructive', () => {
    const destructive = METHODS.filter((method) => method.effect === 'destructive');
    expect(destructive.map((method) => method.key).sort()).toEqual([
      'sandbox.deleteCheckpoint',
      'sandbox.promote',
      'sandbox.reset',
      'sandbox.restore',
    ]);
  });

  it('keeps every argument schema within two object levels of the root', () => {
    for (const method of METHODS) {
      expect(schemaDepth(toJsonSchema(method.args))).toBeLessThanOrEqual(2);
    }
  });

  it('describes every method for the agent that has to choose it', () => {
    for (const method of METHODS) {
      expect(method.description.length).toBeGreaterThan(10);
      expect(method.description.endsWith('.')).toBe(true);
      expect(method.signature.startsWith(`${method.method}(`)).toBe(true);
    }
  });
});
