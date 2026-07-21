import { describe, expect, spyOn, test } from 'bun:test';
import { SimulateFirestoreRulesHandler } from 'pyric/rules/internal';
import { FirestoreEventBus } from '../../../src/firestore/sandbox/event-bus.js';
import { LocalState } from '../../../src/firestore/sandbox/local-state.js';
import { RulesListAuthorizer } from '../../../src/firestore/sandbox/rules-list-authorizer.js';
import { RulesState } from '../../../src/firestore/sandbox/rules-state.js';
import type { RequestEvent } from '../../../src/sandbox/types/events.js';

const OPEN_RULES = `rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /{document=**} { allow read: if true; }
  }
}`;

const DATA_GATED_RULES = `rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /posts/{id} { allow list: if resource.data.visibility == 'public'; }
  }
}`;

function makeAuthorizer(source: string) {
  const state = new LocalState({ 'posts/public': { visibility: 'public' } });
  const events = new FirestoreEventBus();
  const authorizer = new RulesListAuthorizer(
    events,
    new RulesState(source),
    new SimulateFirestoreRulesHandler(),
    { get state() { return state; } },
  );
  return { authorizer, events };
}

function authorizeCollectionGroup(source: string) {
  return makeAuthorizer(source).authorizer.authorize({
    path: 'items',
    collectionGroup: true,
    auth: null,
    constraints: {},
    origin: 'user',
  });
}

describe('RulesListAuthorizer', () => {
  test('authorizes a provable list rule and emits one allow event', () => {
    const { authorizer, events } = makeAuthorizer(DATA_GATED_RULES);
    const requests: RequestEvent[] = [];
    events.request.subscribe((event) => requests.push(event));

    const result = authorizer.authorize({
      path: 'posts',
      auth: null,
      constraints: {
        where: [{ field: 'visibility', op: '==', value: 'public' }],
      },
      origin: 'user',
    });

    expect(result).toEqual({ allowed: true });
    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({ method: 'list', path: 'posts', result: 'allow', origin: 'user' });
  });

  test('captures request.time before query proof work begins', () => {
    const ticks = [1_000, 1_100, 2_000];
    const nowSpy = spyOn(Date, 'now').mockImplementation(() => ticks.shift() ?? 2_000);
    try {
      const state = new LocalState({ 'posts/public': { visibility: 'public' } });
      const events = new FirestoreEventBus();
      const requests: RequestEvent[] = [];
      events.request.subscribe((event) => requests.push(event));
      const rules = new RulesState(OPEN_RULES);
      const simulator = new SimulateFirestoreRulesHandler();
      const originalSimulate = simulator.simulate.bind(simulator);
      let requestTime: string | undefined;
      simulator.simulate = (source, cases, options) => {
        requestTime = cases[0]?.requestTime;
        return originalSimulate(source, cases, options);
      };
      const authorizer = new RulesListAuthorizer(
        events,
        rules,
        simulator,
        { get state() { return state; } },
      );

      authorizer.authorize({ path: 'posts', auth: null, constraints: {}, origin: 'user' });

      expect(requestTime).toBe('1970-01-01T00:00:01.000Z');
      expect(requests[0]!.at).toBe(1_100);
    } finally {
      nowSpy.mockRestore();
    }
  });

  test('keeps listener denial local while preserving trigger attribution', () => {
    const { authorizer, events } = makeAuthorizer(DATA_GATED_RULES);
    const requests: RequestEvent[] = [];
    const denials: unknown[] = [];
    events.request.subscribe((event) => requests.push(event));
    events.denial.subscribe((error) => denials.push(error));

    const result = authorizer.authorize({
      path: 'posts',
      auth: null,
      constraints: {},
      origin: 'listener',
      triggeredBy: { method: 'update', path: 'posts/public' },
    });

    expect(result.allowed).toBe(false);
    expect(requests[0]).toMatchObject({
      result: 'deny',
      origin: 'listener',
      triggeredBy: { method: 'update', path: 'posts/public' },
    });
    expect(denials).toHaveLength(0);
  });

  test('publishes user-origin denials on the denial channel', () => {
    const { authorizer, events } = makeAuthorizer(DATA_GATED_RULES);
    const denials: unknown[] = [];
    events.denial.subscribe((error) => denials.push(error));

    const result = authorizer.authorize({
      path: 'posts',
      auth: null,
      constraints: {},
      origin: 'user',
    });

    expect(result.allowed).toBe(false);
    expect(denials).toHaveLength(1);
  });

  test('bypass emits the origin-specific admin event without consulting rules', () => {
    const { authorizer, events } = makeAuthorizer(OPEN_RULES.replace('if true', 'if false'));
    const requests: RequestEvent[] = [];
    events.request.subscribe((event) => requests.push(event));

    const result = authorizer.authorize({
      path: 'posts',
      auth: null,
      constraints: {},
      bypassRules: true,
      activityQuery: { source: 'listener' },
      origin: 'listener',
      timing: { at: 123 },
    });

    expect(result).toEqual({ allowed: true });
    expect(requests[0]).toMatchObject({
      at: 123,
      result: 'allow',
      origin: 'listener',
      detail: { admin: true, activityQuery: { source: 'listener' } },
    });
    expect(requests[0]!.reasons[0]).toBe('admin lens — rules bypassed');
  });

  for (const scope of ['global', 'service'] as const) {
    test(`evaluates a reachable path-invariant helper declared at ${scope} scope`, () => {
      const globalHelper = scope === 'global'
        ? 'function signedOut() { return request.auth == null; }'
        : '';
      const serviceHelper = scope === 'service'
        ? 'function signedOut() { return request.auth == null; }'
        : '';
      const rules = `rules_version = '2';
        ${globalHelper}
        service cloud.firestore {
          ${serviceHelper}
          match /databases/{database}/documents {
            match /{document=**} { allow list: if signedOut(); }
          }
        }`;

      expect(authorizeCollectionGroup(rules)).toEqual({ allowed: true });
    });
  }

});
