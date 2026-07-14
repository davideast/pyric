/**
 * Red-at-birth replay for the unchanged Functions RTDB integration seam.
 * Normal CLI tests skip the climbing surface; `compat:climb` sets
 * PYRIC_CLIMB=1 and maps the row id in each describe block.
 */
import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { functionsRtdbRows } from '../../../conformance/registry/functions-rtdb.ts';

const climbDescribe = process.env.PYRIC_CLIMB === '1' ? describe : describe.skip;
const OBS_DIR = join(import.meta.dir, '..', '..', '..', 'conformance', 'observations', 'functions-rtdb');

type Behavior = Record<string, any>;
type RuntimeOutcomes = Record<string, Behavior>;
type AssertionSpec = { observation: string; assert(local: Behavior, production: Behavior): void };

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
async function runUnchangedFunctionsFixture(): Promise<RuntimeOutcomes> {
  throw new Error('functions-rtdb runtime is not implemented');
}

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
    });
  });
}

describe('functions-rtdb climb completeness', () => {
  it('has exactly one assertion set per admitted row', () => {
    expect(new Set(Object.keys(assertions))).toEqual(new Set(functionsRtdbRows.map((row) => row.id)));
  });
});
