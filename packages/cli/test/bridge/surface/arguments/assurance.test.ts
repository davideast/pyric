/**
 * The assurance argument vocabulary: the service names it translates and the
 * one file read every method that names a capture goes through.
 */
import 'fake-indexeddb/auto';
import { describe, expect, it } from 'bun:test';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  CASE_SERVICES,
  REPLAY_SERVICES,
  probeMutation,
  readFixtureFile,
  verifiableService,
} from '../../../../src/bridge/surface/arguments/assurance.js';
import { jsonSchemaToZodShape } from '../../../../src/bridge/server/json-schema-to-zod.js';
import { createSurfaceContext, renderSurface } from '../../../../src/bridge/surface/index.js';
import { CAPTURE_RELATIVE_PATH } from '../../../../src/serve/capture-store.js';
import { failFor } from '../../../../src/bridge/surface/method-validation.js';
import { recordNoteSession, writeCapture } from '../assurance-fixture.js';
import { initializeSandbox } from 'pyric/sandbox';
import { z } from 'zod';

const fail = failFor('assurance', 'replaySession');

describe('the services an assurance method names', () => {
  it('offers the surface names rather than the engine names', () => {
    expect([...REPLAY_SERVICES]).toEqual(['firestore', 'database']);
    expect([...CASE_SERVICES]).toEqual(['firestore']);
  });

  it("translates the surface's database into the replay engine's rtdb", () => {
    expect(verifiableService('database')).toBe('rtdb');
    expect(verifiableService('firestore')).toBe('firestore');
    expect(verifiableService(undefined)).toBe('firestore');
  });
});

describe('reading a capture a method names', () => {
  it('reads a capture written inside the project directory', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'pyric-assurance-args-'));
    writeCapture(dir, CAPTURE_RELATIVE_PATH, await recordNoteSession());
    const read = readFixtureFile(dir, CAPTURE_RELATIVE_PATH, 'sessionPath', fail);
    if (!('fixture' in read)) throw new Error(read.refusal.summary);
    expect(read.fixture.events.length).toBeGreaterThan(0);
  });

  it('refuses a path outside the project directory by name', () => {
    const dir = mkdtempSync(join(tmpdir(), 'pyric-assurance-args-'));
    const read = readFixtureFile(dir, '../elsewhere.json', 'sessionPath', fail);
    if ('fixture' in read) throw new Error('a path outside the project directory was accepted');
    expect(read.refusal.summary).toContain('outside the project directory');
    expect(read.refusal.data.field).toBe('sessionPath');
  });

  it('refuses a path nothing was written to', () => {
    const dir = mkdtempSync(join(tmpdir(), 'pyric-assurance-args-'));
    const read = readFixtureFile(dir, 'captures/missing.json', 'sessionPath', fail);
    if ('fixture' in read) throw new Error('a missing capture was accepted');
    expect(read.refusal.summary).toContain('no file was read there');
  });

  it('refuses a file that is not a capture', () => {
    const dir = mkdtempSync(join(tmpdir(), 'pyric-assurance-args-'));
    writeFileSync(join(dir, 'notes.json'), '{"hello":"world"}', 'utf8');
    const read = readFixtureFile(dir, 'notes.json', 'sessionPath', fail);
    if ('fixture' in read) throw new Error('a file that is not a capture was accepted');
    expect(read.refusal.summary).toContain('is not a recorded session');
  });
});

describe('probeMutation explicit id across flattened MCP surfaces', () => {
  it('preserves mutations[].id through noun-prefixed, verb-prefixed, and verb-suffixed MCP schemas', async () => {
    expect(
      probeMutation.safeParse({
        id: 'custom-probe-1',
        dimension: 'path',
        description: 'Read peer profile.',
        operation: { service: 'firestore', method: 'get', path: 'users/u-2' },
      }).success,
    ).toBe(true);
    expect(
      probeMutation.safeParse({
        id: '',
        dimension: 'path',
        description: 'Empty id.',
        operation: { service: 'firestore', method: 'get', path: 'users/u-2' },
      }).success,
    ).toBe(false);

    for (const mode of ['noun-prefixed', 'verb-prefixed', 'verb-suffixed'] as const) {
      const surface = renderSurface(mode);
      const ctx = createSurfaceContext(initializeSandbox());
      const findByOp = (op: string) => {
        const match = surface.tools.find(
          (tool) => surface.resolve(tool.name, {}).operation === op,
        );
        if (!match) throw new Error(`missing tool for ${op} in ${mode}`);
        return match;
      };
      const invokeMcp = async (op: string, rawArgs: Record<string, unknown>) => {
        const tool = findByOp(op);
        const parsed = z
          .object(jsonSchemaToZodShape(tool.inputSchema as Record<string, unknown>))
          .parse(rawArgs);
        return tool.execute(parsed, ctx);
      };

      await invokeMcp('start_assurance_campaign', {
        campaignId: `camp-${mode}`,
        target: {
          schema: 'pyric.assurance.target.v1',
          network: 'forbid',
          rules: {
            firestore: `rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /users/{uid} {
      allow get: if request.auth != null && request.auth.uid == uid;
    }
  }
}`,
          },
          state: {
            firestore: {
              'users/u-1': { label: 'one' },
              'users/u-2': { label: 'two' },
              'users/u-3': { label: 'three' },
            },
            auth: { users: [{ uid: 'u-1' }, { uid: 'u-2' }, { uid: 'u-3' }] },
          },
        },
      });
      await invokeMcp('define_assurance_invariants', {
        campaignId: `camp-${mode}`,
        invariants: [
          {
            id: 'inv-private',
            statement: 'Only owner reads user profile.',
            service: 'firestore',
            expected: 'DENY',
            source: 'declared',
            confidence: 'authoritative',
          },
        ],
      });
      await invokeMcp('map_assurance_campaign', {
        campaignId: `camp-${mode}`,
        actors: [{ id: 'actor-1', acquisition: { kind: 'fixture-user', uid: 'u-1' } }],
        observations: [
          {
            id: 'obs-1',
            actorId: 'actor-1',
            result: 'ALLOW',
            source: 'authored',
            operation: { service: 'firestore', method: 'get', path: 'users/u-1' },
          },
        ],
      });

      const first = await invokeMcp('propose_assurance_probes', {
        campaignId: `camp-${mode}`,
        observationId: 'obs-1',
        invariantId: 'inv-private',
        mutations: [
          {
            id: 'custom-probe-alpha',
            dimension: 'path',
            description: 'Read peer profile users/u-2.',
            operation: { service: 'firestore', method: 'get', path: 'users/u-2' },
          },
        ],
      });
      const second = await invokeMcp('propose_assurance_probes', {
        campaignId: `camp-${mode}`,
        observationId: 'obs-1',
        invariantId: 'inv-private',
        mutations: [
          {
            id: 'custom-probe-beta',
            dimension: 'path',
            description: 'Read peer profile users/u-3.',
            operation: { service: 'firestore', method: 'get', path: 'users/u-3' },
          },
        ],
      });
      expect(first.ok).toBe(true);
      expect(second.ok).toBe(true);
      expect((first.data as { probes: Array<{ id: string }> }).probes[0]?.id).toBe(
        'custom-probe-alpha',
      );
      expect((second.data as { probes: Array<{ id: string }> }).probes[0]?.id).toBe(
        'custom-probe-beta',
      );
    }
  });
});
