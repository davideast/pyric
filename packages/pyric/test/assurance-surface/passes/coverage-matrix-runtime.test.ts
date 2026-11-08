import { describe, expect, it } from 'bun:test';
import {
  collectRuntimeObservations,
  concretizeSitePattern,
} from '../../../src/assurance-surface/passes/coverage-matrix-runtime.js';
import type { SandboxSnapshot } from '../../../src/sandbox/internal/snapshot-codec.js';
import {
  parseResourcePattern,
  renderResourcePattern,
} from '../../../src/sandbox/internal/resource-pattern.js';
import type { SandboxEvent } from '../../../src/sandbox/types/events.js';

describe('coverageMatrixPass runtime observation and concretization', () => {
  it('extracts concrete observations across Firestore, RTDB (.value/.priority unwrapped), and Storage snapshots', () => {
    const snapshot: SandboxSnapshot = {
      version: 1,
      rules: {},
      auth: { users: [] },
      firestore: {
        '(default)': {
          'orgs/acme/members/u1': { role: 'owner' },
        },
      },
      rtdb: {
        '(default)': {
          orgs: {
            acme: {
              presence: {
                u1: { '.value': 'online', '.priority': 10 },
              },
            },
          },
        },
      },
      storage: {
        'media-bucket': [
          {
            path: 'orgs/acme/logo.png',
            contentBase64: '',
            size: 0,
            contentType: 'image/png',
          },
        ],
      },
    };

    const observations = collectRuntimeObservations({ snapshot });

    expect(
      observations.some(
        (obs) =>
          obs.service === 'firestore'
          && obs.resourceId === '(default)'
          && obs.concretePath === 'orgs/acme/members/u1'
          && obs.source === 'snapshot:firestore:(default)',
      ),
    ).toBe(true);

    expect(
      observations.some(
        (obs) =>
          obs.service === 'rtdb'
          && obs.resourceId === '(default)'
          && obs.concretePath === 'orgs/acme/presence/u1'
          && obs.source === 'snapshot:rtdb:(default)',
      ),
    ).toBe(true);
    expect(observations.some((obs) => obs.concretePath.includes('.value'))).toBe(false);
    expect(observations.some((obs) => obs.concretePath.includes('.priority'))).toBe(false);

    expect(
      observations.some(
        (obs) =>
          obs.service === 'storage'
          && obs.resourceId === 'media-bucket'
          && obs.concretePath === 'orgs/acme/logo.png'
          && obs.source === 'snapshot:storage:media-bucket',
      ),
    ).toBe(true);
  });

  it('extracts concrete observations from sandbox history events across all three services', () => {
    const history: SandboxEvent[] = [
      {
        kind: 'request',
        id: 'req-1',
        at: 100,
        evalMs: 1,
        method: 'get',
        path: 'orgs/acme/settings/general',
        auth: { uid: 'u1' },
        result: 'allow',
        reasons: [],
        origin: 'user',
      },
      {
        kind: 'operation',
        id: 'op-rtdb-1',
        at: 101,
        service: 'rtdb',
        instance: 'realtime-shard',
        method: 'set',
        path: '/orgs/acme/status/u1',
        auth: { uid: 'u1' },
        result: 'allow',
        origin: 'user',
      },
      {
        kind: 'service_mutation',
        id: 'mut-storage-1',
        at: 102,
        service: 'storage',
        op: 'put',
        path: 'gs://media-bucket/orgs/acme/banner.png',
        auth: { uid: 'u1' },
      },
    ];

    const observations = collectRuntimeObservations({ history });

    expect(observations).toContainEqual({
      service: 'firestore',
      resourceId: '(default)',
      concretePath: 'orgs/acme/settings/general',
      segments: ['orgs', 'acme', 'settings', 'general'],
      source: 'history:request:req-1',
    });
    expect(observations).toContainEqual({
      service: 'rtdb',
      resourceId: 'realtime-shard',
      concretePath: 'orgs/acme/status/u1',
      segments: ['orgs', 'acme', 'status', 'u1'],
      source: 'history:operation:op-rtdb-1',
    });
    expect(observations).toContainEqual({
      service: 'storage',
      resourceId: 'media-bucket',
      concretePath: 'orgs/acme/banner.png',
      segments: ['orgs', 'acme', 'banner.png'],
      source: 'history:service_mutation:mut-storage-1',
    });
  });

  it('concretizes partial path templates from observed prefixes and preserves runtimeSite evidence', () => {
    const snapshot: SandboxSnapshot = {
      version: 1,
      rules: {},
      auth: { users: [] },
      firestore: {
        '(default)': {
          'orgs/acme/members/u1': { role: 'member' },
        },
      },
      rtdb: {},
      storage: {},
    };
    const observations = collectRuntimeObservations({ snapshot });

    const partialSitePattern = parseResourcePattern('firestore', 'orgs/{dynamic}/items/1');
    const concretized = concretizeSitePattern(partialSitePattern, observations);

    expect(renderResourcePattern(concretized.pattern)).toBe('orgs/acme/items/1');
    expect(concretized.runtimeSite).toEqual({
      source: 'snapshot:firestore:(default)',
      concretePath: 'orgs/acme/members/u1',
    });

    const unrelatedPattern = parseResourcePattern('firestore', 'teams/{dynamic}/items/1');
    const untouched = concretizeSitePattern(unrelatedPattern, observations);
    expect(renderResourcePattern(untouched.pattern)).toBe('teams/{dynamic}/items/1');
    expect(untouched.runtimeSite).toBeUndefined();

    const unanchoredVar = parseResourcePattern('firestore', '{dynamic}');
    const unanchoredResult = concretizeSitePattern(unanchoredVar, observations);
    expect(renderResourcePattern(unanchoredResult.pattern)).toBe('{dynamic}');
    expect(unanchoredResult.runtimeSite).toBeUndefined();
  });
});
