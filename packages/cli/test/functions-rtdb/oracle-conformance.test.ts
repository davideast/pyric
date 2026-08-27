/**
 * Red-at-birth replay for the unchanged Functions RTDB integration seam.
 * Normal CLI tests skip the climbing surface; `compat:climb` sets
 * PYRIC_CLIMB=1 and maps the row id in each describe block.
 */
import 'fake-indexeddb/auto';
import { describe, expect, it } from 'bun:test';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  descendantProbe,
  exactProbe,
  failureProbe,
  functionsRtdbRows,
  startupProbe,
  wildcardProbe,
} from '@pyric/conformance/functions-rtdb-fixture';
import {
  spawnFunctionsRtdbChild,
  type FunctionsRtdbChildEvent,
} from '../../src/functions-rtdb/child.js';
import { buildChildEnv, registerModuleUrl } from '../../src/cli/sandbox-runner.js';
import { startServe } from '../../src/cli/serve.js';
import { connectRemoteSandbox } from '../../src/remote/index.js';
import { silentServeLogger } from '../../src/serve/server.js';
import {
  connectFunctionsWorkerPeer,
  createFunctionsWorkerHostCtx,
} from './worker-peer.js';

const climbDescribe = process.env.PYRIC_CLIMB === '1' ? describe : describe.skip;
const OBS_DIR = join(import.meta.dir, '..', '..', '..', 'conformance', 'observations', 'functions-rtdb');

type Behavior = Record<string, any>;
type RuntimeOutcomes = Record<string, Behavior>;
type AssertionSpec = { observation: string; assert(local: Behavior, production: Behavior): void };

const cliRoot = resolve(import.meta.dir, '../..');
const repoRoot = resolve(cliRoot, '../..');
const childModule = join(cliRoot, 'dist/functions-rtdb/child.js');
const EXACT_NEGATIVE_OBSERVATION_MS = 1_000;
const STARTUP_OBSERVATION_MS = 15_000;

function observation(name: string): Behavior {
  const raw = JSON.parse(readFileSync(join(OBS_DIR, `${name}.json`), 'utf8')) as {
    behavior: Behavior;
  };
  return raw.behavior;
}

/**
 * PRs 2–4 replace only this boundary. It must start the ordinary CLI, load
 * unchanged firebase-functions source, commit through RTDB, await the handler,
 * and return application-observable outcomes grouped by observation name.
 */
let fixtureRun: Promise<RuntimeOutcomes> | undefined;

async function connectWorkerPeer(url: string): Promise<() => Promise<void>> {
  const ctx = await createFunctionsWorkerHostCtx({
    persistenceKeyPrefix: 'functions-conformance',
    instanceId: 'functions-conformance',
  });
  const peer = await connectFunctionsWorkerPeer({
    url,
    ctx,
    sandboxId: 'functions-conformance-peer',
  });
  return peer.close;
}

async function waitFor(read: () => Promise<boolean>, timeoutMs = 8_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await read()) return;
    await Bun.sleep(20);
  }
  throw new Error('timed out waiting for the local Functions conformance fixture');
}

function runUnchangedFunctionsFixture(): Promise<RuntimeOutcomes> {
  fixtureRun ??= runFixtureOnce();
  return fixtureRun;
}

async function runFixtureOnce(): Promise<RuntimeOutcomes> {
  if (!existsSync(childModule)) {
    throw new Error(`Functions conformance requires a built CLI child: ${childModule}`);
  }
  const cwd = mkdtempSync(join(tmpdir(), 'pyric-functions-conformance-'));
  mkdirSync(join(cwd, 'public'));
  mkdirSync(join(cwd, 'functions/node_modules'), { recursive: true });
  writeFileSync(join(cwd, 'public/index.html'), '<!doctype html><body>fixture</body>');
  writeFileSync(join(cwd, 'firebase.json'), JSON.stringify({
    hosting: { public: 'public' },
    functions: { source: 'functions' },
  }));
  writeFileSync(join(cwd, 'functions/package.json'), JSON.stringify({
    name: 'functions-conformance-fixture',
    private: true,
    type: 'commonjs',
    main: 'index.cjs',
  }));
  writeFileSync(join(cwd, 'functions/index.cjs'), LOCAL_FIXTURE_SOURCE);
  symlinkSync(
    join(repoRoot, 'packages/conformance/node_modules/firebase-functions'),
    join(cwd, 'functions/node_modules/firebase-functions'),
  );

  const runtime = await startServe({
    cwd,
    port: 0,
    cacheRoot: join(cwd, '.cache'),
    logger: silentServeLogger(),
    bridge: true,
    disableAuditLog: true,
  });
  const closePeer = await connectWorkerPeer(
    `ws://127.0.0.1:${runtime.handle.port}/__pyric/sandbox`,
  );
  const observer = await connectRemoteSandbox({ url: runtime.handle.url });
  const runId = 'local-replay';
  const base = `/pyric_oracle/functions/${runId}`;
  await observer.rtdb.set(startupProbe.inputPath(runId), startupProbe.inputValue);
  const events: FunctionsRtdbChildEvent[] = [];
  const child = spawnFunctionsRtdbChild({
    cwd: join(cwd, 'functions'),
    entry: join(cwd, 'functions/index.cjs'),
    childModuleUrl: pathToFileURL(childModule),
    env: buildChildEnv(process.env, {
      serveUrl: runtime.handle.url,
      registerUrl: registerModuleUrl(),
    }),
    instance: 'digame-mas-default-rtdb',
    location: 'us-central1',
    onEvent: (event) => events.push(event),
  });

  const captures = async (): Promise<Record<string, any>[]> => {
    const value = await observer.rtdb.get('__pyric_functions_captures');
    if (typeof value !== 'object' || value === null) return [];
    return Object.entries(value as Record<string, Record<string, any>>)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([, capture]) => capture);
  };
  const scenario = async (name: string): Promise<Record<string, any>[]> =>
    (await captures()).filter((capture) => capture.scenario === name);
  const waitForCount = async (name: string, count: number): Promise<Record<string, any>[]> => {
    await waitFor(async () => (await scenario(name)).length >= count);
    return scenario(name);
  };

  try {
    expect((await child.ready).triggerCount).toBe(5);
    const startupObservationStartedAt = Date.now();

    await observer.rtdb.set(exactProbe.inputPath(runId), exactProbe.inputValue);
    await waitForCount('exact-lifecycle', 1);
    await observer.rtdb.update(exactProbe.inputPath(runId), { count: 2 });
    await observer.rtdb.remove(exactProbe.inputPath(runId));
    await Bun.sleep(EXACT_NEGATIVE_OBSERVATION_MS);
    const exactCaptures = await scenario('exact-lifecycle');
    for (const capture of exactCaptures) {
      if (capture.event.authId === '__PYRIC_NULL__') capture.event.authId = null;
    }

    const wildcardRoot = wildcardProbe.rootPath(runId);
    await observer.rtdb.set(`${wildcardRoot}/single`, wildcardProbe.cases.single);
    await waitForCount('wildcard-batches', 1);
    await observer.rtdb.set(`${wildcardRoot}/fanout`, wildcardProbe.cases.fanout);
    await waitForCount('wildcard-batches', 3);
    await observer.rtdb.update(`${wildcardRoot}/multipath`, wildcardProbe.cases.multipath);
    await waitForCount('wildcard-batches', 5);
    for (const sequence of wildcardProbe.cases.ordering) {
      await observer.rtdb.set(`${wildcardRoot}/ordering/item-${sequence}`, { sequence });
    }
    const wildcardCaptures = await waitForCount('wildcard-batches', 8);

    await observer.rtdb.set(descendantProbe.ancestorPath(runId), descendantProbe.inputValue);
    const descendantCaptures = await waitForCount('descendant-projection', 1);

    await observer.rtdb.set(failureProbe.inputPath(runId), failureProbe.inputValue);
    const failureCaptures = await waitForCount('failed-execution', 1);
    await waitFor(async () => events.some((event) =>
      event.type === 'execution' &&
      event.status === 'rejected' &&
      event.error.message.includes(failureProbe.errorMarker)));

    await waitFor(
      async () => Date.now() - startupObservationStartedAt >= STARTUP_OBSERVATION_MS,
      STARTUP_OBSERVATION_MS + 1_000,
    );

    const handlerWrite = await observer.rtdb.get(`${base}/exact/handler-write`);
    const startupValue = await observer.rtdb.get(startupProbe.inputPath(runId));
    const matchingRuntimeErrorCount = events.filter((event) =>
      event.type === 'execution' &&
      event.status === 'rejected' &&
      event.error.message.includes(failureProbe.errorMarker)).length;
    const startupDeliveryCount = events.filter((event) =>
      event.type === 'execution' &&
      event.ref === startupProbe.inputPath(runId).replace(/^\//, '')).length;
    return {
      [exact]: exactProbe.behavior(exactCaptures, handlerWrite),
      [startup]: startupProbe.behavior(
        startupDeliveryCount,
        startupValue,
        Date.now() - startupObservationStartedAt,
      ),
      [wildcard]: wildcardProbe.behavior(wildcardCaptures),
      [descendant]: descendantProbe.behavior(descendantCaptures[0]!),
      [failure]: failureProbe.behavior(failureCaptures.length, {
        matchingRuntimeErrorCount,
        // Pyric has no Eventarc HTTP request seam, so it cannot observe or
        // claim the production request acknowledgement status.
        requestStatuses: [],
      }),
    };
  } finally {
    await child.stop();
    observer.close();
    await closePeer();
    await runtime.handle.stop();
  }
}

const LOCAL_FIXTURE_SOURCE = String.raw`
'use strict';
const { onValueCreated } = require('firebase-functions/v2/database');
const captures = '__pyric_functions_captures';
let captureSequence = 0;
const options = ref => ({ ref, region: 'us-central1', retry: false });
const envelope = event => ({
  idPresent: typeof event.id === 'string' && event.id.length > 0,
  type: event.type,
  subject: event.subject,
  timePresent: typeof event.time === 'string' && event.time.length > 0,
  instance: event.instance,
  location: event.location,
  ref: event.ref,
  params: event.params,
  authType: event.authType,
  // RTDB deletes nested nulls, so the local observation channel encodes the
  // null-vs-undefined distinction and the parent restores it before replay.
  authId: event.authId === null ? '__PYRIC_NULL__' :
    event.authId === undefined ? '__PYRIC_UNDEFINED__' : event.authId,
});
const snapshot = data => {
  const childKeys = [];
  data.forEach(child => { childKeys.push(child.key); });
  return {
    val: data.val(), key: data.key, exists: data.exists(), toJSON: data.toJSON(),
    numChildren: data.numChildren(), childKeys,
    nestedEnabled: data.child('nested/enabled').val(),
    hasNestedEnabled: data.hasChild('nested/enabled'),
  };
};
const capture = (event, payload) => event.data.ref.root
  .child(captures).child(String(++captureSequence).padStart(4, '0')).set(payload);

exports.exact = onValueCreated(
  options('/pyric_oracle/functions/{runId}/exact/target'),
  async event => {
    const startedAt = Date.now();
    await new Promise(resolve => setTimeout(resolve, 750));
    const outputRef = event.data.ref.parent.child('handler-write');
    await outputRef.set({ completed: true, sourceKey: event.data.key });
    await capture(event, {
      scenario: 'exact-lifecycle', runId: event.params.runId,
      event: envelope(event), snapshot: snapshot(event.data),
      handler: {
        awaitedMs: Date.now() - startedAt,
        adminRefKey: event.data.ref.key,
        adminRefPathMatchesEventRef: event.data.ref.toString().endsWith('/' + event.ref),
        outputRefKey: outputRef.key,
        adminWriteCompleted: true,
      },
    });
  },
);
exports.wildcard = onValueCreated(
  options('/pyric_oracle/functions/{runId}/wildcard/{caseId}/{itemId}'),
  event => capture(event, {
    scenario: 'wildcard-batches', runId: event.params.runId,
    event: envelope(event), snapshot: snapshot(event.data),
  }),
);
exports.descendant = onValueCreated(
  options('/pyric_oracle/functions/{runId}/descendant/leaf'),
  event => capture(event, {
    scenario: 'descendant-projection', runId: event.params.runId,
    event: envelope(event), snapshot: snapshot(event.data),
  }),
);
exports.startup = onValueCreated(
  options('/pyric_oracle/functions/{runId}/startup/target'),
  event => capture(event, {
    scenario: 'startup-existing', runId: event.params.runId,
    event: envelope(event), snapshot: snapshot(event.data),
  }),
);
exports.failure = onValueCreated(
  options('/pyric_oracle/functions/{runId}/failure/target'),
  async event => {
    await capture(event, {
      scenario: 'failed-execution', runId: event.params.runId,
      event: envelope(event), snapshot: snapshot(event.data),
    });
    throw new Error('PYRIC_EXPECTED_ONVALUECREATED_FAILURE');
  },
);
`;

const exact = 'functions-rtdb-onvaluecreated-exact-create';
const startup = 'functions-rtdb-onvaluecreated-startup-existing';
const wildcard = 'functions-rtdb-onvaluecreated-wildcard-batches';
const descendant = 'functions-rtdb-onvaluecreated-descendant-projection';
const failure = 'functions-rtdb-onvaluecreated-failed-execution';

const assertions: Record<string, AssertionSpec> = {
  'functions-rtdb#1': {
    observation: exact,
    assert(local, production) {
      expect(local.deliveryCount).toBe(production.deliveryCount);
      expect(local.event).toEqual(production.event);
      expect(local.snapshot.val).toEqual(production.snapshot.val);
    },
  },
  'functions-rtdb#2': {
    observation: exact,
    assert(local, production) {
      expect(local.createOnlyAfterUpdateAndDelete).toBe(production.createOnlyAfterUpdateAndDelete);
      expect(local.deliveryCount).toBe(production.deliveryCount);
    },
  },
  'functions-rtdb#3': {
    observation: startup,
    assert(local, production) {
      expect(local.deliveryCount).toBe(production.deliveryCount);
      expect(local.value).toEqual(production.value);
      expect(local.observationWindowMs).toBeGreaterThanOrEqual(production.observationWindowMs);
    },
  },
  'functions-rtdb#4': {
    observation: wildcard,
    assert(local, production) {
      expect(local.single).toEqual(production.single);
    },
  },
  'functions-rtdb#5': {
    observation: wildcard,
    assert(local, production) {
      expect(local.fanout).toEqual(production.fanout);
    },
  },
  'functions-rtdb#6': {
    observation: descendant,
    assert(local, production) {
      expect(local.deliveryCount).toBe(production.deliveryCount);
      expect(local.key).toBe(production.key);
      expect(local.val).toEqual(production.val);
      expect(local.siblingExcluded).toBe(production.siblingExcluded);
      expect(local.event).toEqual(production.event);
    },
  },
  'functions-rtdb#7': {
    observation: wildcard,
    assert(local, production) {
      expect(local.multipath).toEqual(production.multipath);
    },
  },
  'functions-rtdb#8': {
    observation: exact,
    assert(local, production) {
      expect(local.snapshot).toEqual(production.snapshot);
    },
  },
  'functions-rtdb#9': {
    observation: exact,
    assert(local, production) {
      expect(local.handler.adminRefKey).toBe(production.handler.adminRefKey);
      expect(local.handler.outputRefKey).toBe(production.handler.outputRefKey);
      expect(local.handler.adminRefPathMatchesEventRef).toBe(
        production.handler.adminRefPathMatchesEventRef,
      );
      expect(local.handler.adminWriteCompleted).toBe(production.handler.adminWriteCompleted);
      expect(local.handlerWrite).toEqual(production.handlerWrite);
    },
  },
  'functions-rtdb#10': {
    observation: exact,
    assert(local, production) {
      expect(local.event.authType).toBe(production.event.authType);
      expect(local.event.authId).toBe(production.event.authId);
    },
  },
  'functions-rtdb#11': {
    observation: exact,
    assert(local, production) {
      expect(local.handler.awaitedMs >= 750).toBe(production.handler.awaitedMs >= 750);
      expect(local.handler.adminWriteCompleted).toBe(production.handler.adminWriteCompleted);
    },
  },
  'functions-rtdb#12': {
    observation: failure,
    assert(local, production) {
      expect(local.deliveryCount).toBe(production.deliveryCount);
      expect(local.runtimeErrorReported).toBe(production.runtimeErrorReported);
      expect(local.matchingRuntimeErrorCount).toBe(production.matchingRuntimeErrorCount);
      expect(local.errorMarker).toBe(production.errorMarker);
      expect(local.requestStatuses).toEqual(production.requestStatuses);
    },
  },
  'functions-rtdb#13': {
    observation: wildcard,
    assert(local, production) {
      expect(local.ordering.deliveryCount).toBe(production.ordering.deliveryCount);
      expect([...local.ordering.observedArrival].sort()).toEqual(
        [...production.ordering.observedArrival].sort(),
      );
      expect(local.ordering.guaranteed).toBe(false);
    },
  },
};

for (const row of functionsRtdbRows) {
  climbDescribe(`${row.id} ${row.api}`, () => {
    it('replays the frozen production behavior through unchanged source', async () => {
      const spec = assertions[row.id];
      const production = observation(spec.observation);
      const local = (await runUnchangedFunctionsFixture())[spec.observation];
      spec.assert(local, production);
    }, 30_000);
  });
}

describe('functions-rtdb climb completeness', () => {
  it('has exactly one assertion set per admitted row', () => {
    expect(new Set(Object.keys(assertions))).toEqual(new Set(functionsRtdbRows.map((row) => row.id)));
  });
});
