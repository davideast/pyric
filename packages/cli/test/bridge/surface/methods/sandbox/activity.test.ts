/**
 * `sandbox.activity`: explicit coverage reporting across every `EventService`.
 *
 * The activity monitor only inspects Firestore reads and listeners. Every other
 * service that emits events in the inspected window must be named explicitly in
 * both `data.notExamined` and `summary`, and even an empty result must state
 * that only Firestore was examined.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getDatabase, onValue, ref, sandbox as rtdbSandbox } from 'pyric/database';
import { doc, getFirestore, onSnapshot } from 'pyric/firestore';
import {
  MUTATION_EVENT_SERVICES,
  initializeSandbox,
  type EventService,
  type LocalSandbox,
} from 'pyric/sandbox';
import { setRules } from 'pyric/sandbox/firestore';
import {
  emitSandboxEvent,
  makeSandboxListenerEvent,
  makeSandboxOperationEvent,
} from 'pyric/sandbox/internal';

import { createSurfaceContext, renderSurface } from '../../../../../src/bridge/surface/index.js';
import type { OperationResult, SurfaceContext } from '../../../../../src/bridge/surface/index.js';

interface UnexaminedServiceEntry {
  service: string;
  eventCount: number;
  listenerEventCount: number;
}

interface ActivityResultData {
  incidents: Array<{ service: string; pattern: string; count: number }>;
  examined?: string[];
  notExamined?: UnexaminedServiceEntry[];
}

const OPEN_FIRESTORE_RULES = `rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /{document=**} { allow read, write: if true; }
  }
}`;

const ALL_EVENT_SERVICES: readonly EventService[] = [
  'firestore',
  'runtime',
  ...MUTATION_EVENT_SERVICES,
];

/** Compile-time check so adding a new EventService fails typecheck if omitted. */
const EXHAUSTIVE_EVENT_SERVICES: Record<EventService, true> = {
  firestore: true,
  runtime: true,
  auth: true,
  storage: true,
  rtdb: true,
  messaging: true,
  ai: true,
  functions: true,
};

const surface = renderSurface('sdk-service');

let projectDir: string;
let sandbox: LocalSandbox;
let ctx: SurfaceContext;

async function callActivity(args: Record<string, unknown> = {}): Promise<OperationResult> {
  const tool = surface.tools.find((candidate) => candidate.name === 'sandbox');
  if (!tool) throw new Error('no rendered tool named sandbox');
  return tool.execute({ method: 'activity', args }, ctx);
}

function plantDuplicateListeners(targetSandbox: LocalSandbox, service: EventService, count: number): void {
  for (let i = 0; i < count; i += 1) {
    emitSandboxEvent(
      targetSandbox,
      makeSandboxListenerEvent({
        at: 1_000 + i,
        service,
        phase: 'attach',
        listenerId: `${service}-listener-${i}`,
        target: { kind: 'doc', path: 'items/a' },
        auth: null,
      }),
      {
        service,
        operationContext: {
          source: { kind: 'app' },
          authLens: { mode: 'anon' },
        },
      },
    );
  }
}

function plantOperations(targetSandbox: LocalSandbox, service: EventService, count: number): void {
  for (let i = 0; i < count; i += 1) {
    emitSandboxEvent(
      targetSandbox,
      makeSandboxOperationEvent({
        at: 2_000 + i,
        service,
        method: 'get',
        path: 'items/a',
        auth: null,
        result: 'allow',
        origin: 'user',
      }),
      {
        service,
        operationContext: {
          source: { kind: 'app' },
          authLens: { mode: 'anon' },
        },
      },
    );
  }
}

beforeEach(() => {
  projectDir = mkdtempSync(join(tmpdir(), 'pyric-activity-'));
  sandbox = initializeSandbox();
  setRules(sandbox, OPEN_FIRESTORE_RULES);
  ctx = createSurfaceContext(sandbox, projectDir);
});

afterEach(() => {
  rmSync(projectDir, { recursive: true, force: true });
});

describe('sandbox.activity coverage across every EventService', () => {
  it('enumerates the full EventService union', () => {
    const enumerated: string[] = [...ALL_EVENT_SERVICES].sort();
    expect(enumerated).toEqual(Object.keys(EXHAUSTIVE_EVENT_SERVICES).sort());
  });

  for (const service of ALL_EVENT_SERVICES) {
    it(`either raises an incident or explicitly reports ${service} as not examined for planted listeners`, async () => {
      plantDuplicateListeners(sandbox, service, 3);

      const result = await callActivity();
      expect(result.ok).toBe(true);
      const data = result.data as ActivityResultData;
      expect(data.examined).toEqual(['firestore']);
      expect(Array.isArray(data.notExamined)).toBe(true);

      const producedIncident = data.incidents.some((incident) => incident.service === service);
      if (producedIncident) {
        expect(data.notExamined).toEqual([]);
        expect(result.summary).toContain('Examined firestore only');
        return;
      }

      expect(data.notExamined).toEqual([
        { service, eventCount: 3, listenerEventCount: 3 },
      ]);
      expect(result.summary).toContain('Examined firestore only');
      expect(result.summary).toContain(`3 ${service} listener event(s)`);
      expect(result.summary).toContain('not examined');
    });
  }

  for (const service of ALL_EVENT_SERVICES) {
    if (service === 'firestore') continue;

    it(`explicitly reports ${service} operation events in data.notExamined and summary`, async () => {
      plantOperations(sandbox, service, 2);

      const result = await callActivity();
      expect(result.ok).toBe(true);
      const data = result.data as ActivityResultData;
      expect(data.incidents).toEqual([]);
      expect(data.examined).toEqual(['firestore']);
      expect(data.notExamined).toEqual([
        { service, eventCount: 2, listenerEventCount: 0 },
      ]);
      expect(result.summary).toBe(
        `0 incident(s). Examined firestore only; 2 ${service} event(s) not examined.`,
      );
    });
  }
});

describe('sandbox.activity real SDK and window coverage', () => {
  it('states firestore-only scope even when history is empty', async () => {
    const result = await callActivity();
    expect(result.ok).toBe(true);
    expect(result.summary).toBe('0 incident(s). Examined firestore only.');
    expect(result.data).toEqual({
      incidents: [],
      examined: ['firestore'],
      notExamined: [],
    });
  });

  it('reports unexamined rtdb listeners attached through the Realtime Database SDK', async () => {
    const rtdb = getDatabase(sandbox);
    rtdbSandbox.setRules(rtdb, rtdbSandbox.DEFAULT_OPEN_RULES);
    const unsubscribes: Array<() => void> = [];
    for (let i = 0; i < 6; i += 1) {
      unsubscribes.push(onValue(ref(rtdb, 'items/a'), () => {}));
    }

    try {
      const rtdbOnly = await callActivity();
      expect(rtdbOnly.ok).toBe(true);
      const rtdbData = rtdbOnly.data as ActivityResultData;
      expect(rtdbData.incidents).toEqual([]);
      expect(rtdbData.examined).toEqual(['firestore']);
      expect(rtdbData.notExamined).toHaveLength(1);
      expect(rtdbData.notExamined![0]!.service).toBe('rtdb');
      expect(rtdbData.notExamined![0]!.eventCount).toBeGreaterThanOrEqual(6);
      expect(rtdbData.notExamined![0]!.listenerEventCount).toBeGreaterThanOrEqual(6);
      expect(rtdbOnly.summary).toContain('Examined firestore only');
      expect(rtdbOnly.summary).toContain('rtdb');
      expect(rtdbOnly.summary).toContain('listener');
      expect(rtdbOnly.summary).toContain('not examined');

      const db = getFirestore(sandbox);
      const firestoreUnsubs = [
        onSnapshot(doc(db, 'items/a'), () => {}),
        onSnapshot(doc(db, 'items/a'), () => {}),
        onSnapshot(doc(db, 'items/a'), () => {}),
      ];
      try {
        const combined = await callActivity();
        expect(combined.ok).toBe(true);
        const combinedData = combined.data as ActivityResultData;
        expect(
          combinedData.incidents.some(
            (incident) => incident.service === 'firestore' && incident.pattern === 'duplicate-listener',
          ),
        ).toBe(true);
        expect(combinedData.examined).toEqual(['firestore']);
        expect(combinedData.notExamined?.some((entry) => entry.service === 'rtdb')).toBe(true);
        expect(combined.summary).toContain('rtdb');
        expect(combined.summary).toContain('listener');
        expect(combined.summary).toContain('not examined');
      } finally {
        for (const stop of firestoreUnsubs) stop();
      }
    } finally {
      for (const stop of unsubscribes) stop();
    }
  });

  it('scopes notExamined to events at or after the since cursor and keeps coverage under pattern filters', async () => {
    plantDuplicateListeners(sandbox, 'rtdb', 2);
    const db = getFirestore(sandbox);
    const stop = onSnapshot(doc(db, 'items/marker'), () => {});
    try {
      const history = sandbox.history();
      const firstFirestoreEvent = history.find((event) => (event.service ?? 'firestore') === 'firestore');
      expect(firstFirestoreEvent).toBeDefined();

      const afterRtdb = await callActivity({ since: firstFirestoreEvent!.id });
      expect(afterRtdb.ok).toBe(true);
      const afterData = afterRtdb.data as ActivityResultData;
      expect(afterData.notExamined).toEqual([]);
      expect(afterRtdb.summary).toBe('0 incident(s). Examined firestore only.');

      const filteredPattern = await callActivity({ pattern: 'duplicate-listener' });
      expect(filteredPattern.ok).toBe(true);
      const filteredData = filteredPattern.data as ActivityResultData;
      expect(filteredData.notExamined).toEqual([
        { service: 'rtdb', eventCount: 2, listenerEventCount: 2 },
      ]);
      expect(filteredPattern.summary).toContain('2 rtdb listener event(s) not examined');
    } finally {
      stop();
    }
  });

  it('sorts multiple unexamined services and summarizes mixed listener and non-listener events', async () => {
    plantOperations(sandbox, 'storage', 2);
    plantDuplicateListeners(sandbox, 'rtdb', 4);
    plantOperations(sandbox, 'rtdb', 1);
    plantOperations(sandbox, 'auth', 1);

    const result = await callActivity();
    expect(result.ok).toBe(true);
    const data = result.data as ActivityResultData;
    expect(data.notExamined).toEqual([
      { service: 'auth', eventCount: 1, listenerEventCount: 0 },
      { service: 'rtdb', eventCount: 5, listenerEventCount: 4 },
      { service: 'storage', eventCount: 2, listenerEventCount: 0 },
    ]);
    expect(result.summary).toBe(
      '0 incident(s). Examined firestore only; 1 auth event(s), 5 rtdb event(s) (4 listener), 2 storage event(s) not examined.',
    );
  });

  it('ignores stream control markers such as session_boundary and observation_gap', async () => {
    emitSandboxEvent(sandbox, {
      kind: 'session_boundary',
      id: 'evt-boundary',
      at: 10,
      phase: 'reset',
      priorOpCount: 0,
    });
    emitSandboxEvent(sandbox, {
      kind: 'observation_gap',
      id: 'evt-gap',
      at: 20,
      reason: 'history-limit',
      omittedCount: 5,
      firstEventId: 'evt-1',
      lastEventId: 'evt-5',
    });

    const result = await callActivity();
    expect(result.ok).toBe(true);
    expect(result.summary).toBe('0 incident(s). Examined firestore only.');
    expect(result.data).toEqual({
      incidents: [],
      examined: ['firestore'],
      notExamined: [],
    });
  });
});
