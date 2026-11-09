// Install JSDOM globals before importing React or RTL.
import { JSDOM } from 'jsdom';
const dom = new JSDOM('<!DOCTYPE html><html><body></body></html>', {
  pretendToBeVisual: true,
  url: 'http://localhost:3000/traffic',
});
const g = globalThis as any;
g.window = dom.window;
g.Window = dom.window.Window;
g.document = dom.window.document;
g.navigator = dom.window.navigator;
g.HTMLElement = dom.window.HTMLElement;
g.SVGElement = dom.window.SVGElement;
g.Element = dom.window.Element;
g.Node = dom.window.Node;
g.Event = dom.window.Event;
g.MouseEvent = dom.window.MouseEvent;
g.KeyboardEvent = dom.window.KeyboardEvent;
g.MutationObserver = dom.window.MutationObserver;
g.requestAnimationFrame = dom.window.requestAnimationFrame.bind(dom.window);
g.cancelAnimationFrame = dom.window.cancelAnimationFrame.bind(dom.window);
g.getComputedStyle = dom.window.getComputedStyle.bind(dom.window);
g.IS_REACT_ACT_ENVIRONMENT = true;

import { afterEach, describe, expect, it } from 'bun:test';
import { act, cleanup, fireEvent, render } from '@testing-library/react';
import type { SandboxEvent, SandboxOperationEvent } from 'pyric/sandbox';
import { OBSERVED_DISPOSITION } from 'pyric/sandbox/internal';
import { TrafficSurface } from '../../../src/features/traffic/TrafficSurface.js';
import { EnvironmentProvider } from '../../../src/shell/environment.js';
import { resetLiveStatusPollerForTesting } from '../../../src/shell/live-status.js';
import { currentPath, replacePath } from '../../../src/shell/router.js';

const DEFAULT_RTDB_RULES = {
  rules: {
    '.read': 'false',
    config: {
      public: {
        '.read': 'true',
      },
    },
    rooms: {
      '.read': 'auth.token.admin === true',
      $roomId: {
        '.read': 'auth != null && auth.uid === $roomId',
        '.write': "auth != null && !data.exists() && newData.hasChild('title')",
      },
    },
  },
};

const AUDIT_RTDB_RULES = {
  rules: {
    audit: {
      $entryId: {
        '.read': "auth != null && auth.token.role === 'auditor'",
      },
    },
  },
};

const FIRESTORE_RULES = [
  "rules_version = '2';",
  'service cloud.firestore {',
  '  match /databases/{database}/documents {',
  '    match /rooms/{roomId} {',
  '      allow read: if resource.data.public == true;',
  '    }',
  '  }',
  '}',
].join('\n');

const LIVE_HEALTH_REPORT = {
  live: {
    projectId: 'demo-live',
    configProjectId: 'demo-live',
    configSource: 'firebase.json',
    appProjectIds: ['demo-live'],
    billed: { reads: 2, writes: 1, deliveries: 1 },
    passThrough: [],
    observed: ['firebase/database', 'firebase/firestore'],
  },
};

interface HarnessOptions {
  readonly history: readonly SandboxEvent[];
  readonly liveHost: boolean;
}

function installWorkerShim(history: readonly SandboxEvent[]) {
  const previousWorker = g.SharedWorker;
  const eventSubIds: string[] = [];
  const port = {
    onmessage: null as ((ev: { data: unknown }) => void) | null,
    postMessage(msg: any) {
      setTimeout(() => {
        if (msg.t === 'op') {
          port.onmessage?.({ data: { t: 'res', id: msg.id, ok: true, value: {} } });
        } else if (msg.t === 'sub' && msg.target === 'events') {
          eventSubIds.push(msg.subId);
          port.onmessage?.({ data: { t: 'event', subId: msg.subId, events: history } });
        }
      }, 0);
    },
    start() {},
    addEventListener() {},
  };
  g.SharedWorker = class {
    port = port;
    constructor(_url: unknown, _opts: unknown) {}
  };
  return () => {
    g.SharedWorker = previousWorker;
  };
}

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

function installFetchShim(liveHost: boolean) {
  const previousFetch = g.fetch;
  g.fetch = async (input: string | URL | Request): Promise<Response> => {
    const rawUrl = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    if (rawUrl.includes('/__pyric/health')) {
      return jsonResponse(liveHost ? LIVE_HEALTH_REPORT : {});
    }
    if (rawUrl.includes('/__pyric/init.json')) {
      return jsonResponse({
        rules: FIRESTORE_RULES,
        databaseRules: DEFAULT_RTDB_RULES,
        databaseInstances: {
          defaultInstance: 'demo-live-default-rtdb',
          rules: {
            'demo-live-default-rtdb': DEFAULT_RTDB_RULES,
            'demo-live-audit-rtdb': AUDIT_RTDB_RULES,
          },
        },
      });
    }
    return new Response('not found', { status: 404 });
  };
  return () => {
    g.fetch = previousFetch;
  };
}

const flush = () => act(() => new Promise<void>((resolve) => setTimeout(resolve, 40)));

let restoreHarness: (() => void) | undefined;

afterEach(() => {
  cleanup();
  restoreHarness?.();
  restoreHarness = undefined;
  resetLiveStatusPollerForTesting();
  replacePath({ tab: 'traffic' });
});

async function mountTrafficSurface(options: HarnessOptions) {
  resetLiveStatusPollerForTesting();
  replacePath({ tab: 'traffic' });
  const restoreWorker = installWorkerShim(options.history);
  const restoreFetch = installFetchShim(options.liveHost);
  restoreHarness = () => {
    restoreWorker();
    restoreFetch();
  };
  let rendered!: ReturnType<typeof render>;
  await act(async () => {
    rendered = render(
      <EnvironmentProvider mode="local">
        <TrafficSurface />
      </EnvironmentProvider>,
    );
  });
  await flush();
  return rendered;
}

function liveRtdbOperation(
  overrides: Partial<SandboxOperationEvent> & { id: string; method: string; path: string },
): SandboxOperationEvent {
  return {
    kind: 'operation',
    service: 'rtdb',
    at: 1_700_000_001_000,
    auth: { uid: 'alice' },
    result: 'allow',
    origin: 'user',
    rulesDisposition: OBSERVED_DISPOSITION,
    ...overrides,
  } as SandboxOperationEvent;
}

describe('TrafficSurface Live mode RTDB and unevaluated rules inspection', () => {
  it('expands decided live RTDB allow and onValue rows in place with database.rules.json line highlight, cascade trace, and $variable bindings', async () => {
    const configAllow = liveRtdbOperation({
      id: 'rtdb-config-allow',
      at: 1_700_000_002_000,
      method: 'get',
      path: '/config/public',
      auth: null,
      production: {
        outcome: { status: 'ok' },
        local: {
          result: 'allow',
          rule: { path: '/config/public', expression: 'true' },
          rtdb: {
            matchedPath: '/config/public',
            matchedRule: 'true',
            rtdbTrace: [
              {
                path: '/',
                kind: 'read',
                conditionText: 'false',
                verdict: 'DENY',
                pathVariableBindings: {},
              },
              {
                path: '/config/public',
                kind: 'read',
                conditionText: 'true',
                verdict: 'ALLOW',
                pathVariableBindings: {},
              },
            ],
          },
        },
      },
    });

    const listenerAllow = liveRtdbOperation({
      id: 'rtdb-listener-allow',
      at: 1_700_000_003_000,
      method: 'onValue',
      path: '/rooms/alice',
      auth: { uid: 'alice' },
      production: {
        outcome: { status: 'ok' },
        local: {
          result: 'allow',
          rule: { path: '/rooms/$roomId', expression: 'auth != null && auth.uid === $roomId' },
          rtdb: {
            matchedPath: '/rooms/$roomId',
            matchedRule: 'auth != null && auth.uid === $roomId',
            pathVariableBindings: { $roomId: 'alice' },
            rtdbTrace: [
              {
                path: '/',
                kind: 'read',
                conditionText: 'false',
                verdict: 'DENY',
                pathVariableBindings: {},
              },
              {
                path: '/rooms',
                kind: 'read',
                conditionText: 'auth.token.admin === true',
                verdict: 'DENY',
                pathVariableBindings: {},
              },
              {
                path: '/rooms/$roomId',
                kind: 'read',
                conditionText: 'auth != null && auth.uid === $roomId',
                verdict: 'ALLOW',
                pathVariableBindings: { $roomId: 'alice' },
              },
            ],
          },
        },
      },
    });

    const { container } = await mountTrafficSurface({
      history: [configAllow, listenerAllow],
      liveHost: true,
    });

    const configButton = container.querySelector(
      '[data-pyric-traffic-id="rtdb-config-allow"] [data-pyric-traffic-row]',
    );
    expect(configButton).not.toBeNull();
    fireEvent.click(configButton!);
    await flush();

    expect(currentPath().tab).toBe('traffic');
    expect(currentPath().query.inspect).toBe('rtdb-config-allow');

    const configInspector = container.querySelector('[data-pyric-ui="traffic-live-rules-inspector"]');
    expect(configInspector).not.toBeNull();
    expect(configInspector?.textContent).toContain('production ok');
    const configSource = container.querySelector('[data-pyric-ui="rtdb-rule-source"]');
    expect(configSource?.getAttribute('data-marked-line')).toBe('6');

    const listenerButton = container.querySelector(
      '[data-pyric-traffic-id="rtdb-listener-allow"] [data-pyric-traffic-row]',
    );
    expect(listenerButton).not.toBeNull();
    fireEvent.click(listenerButton!);
    await flush();

    expect(currentPath().tab).toBe('traffic');
    expect(currentPath().query.inspect).toBe('rtdb-listener-allow');
    const traceRows = container.querySelectorAll('[data-pyric-ui="rtdb-trace-row"]');
    expect(traceRows.length).toBe(3);
    expect(traceRows[2].textContent).toContain('$roomId');
    expect(traceRows[2].textContent).toContain('alice');
    const listenerSource = container.querySelector('[data-pyric-ui="rtdb-rule-source"]');
    expect(listenerSource?.getAttribute('data-marked-line')).toBe('12');
  });

  it('expands a live RTDB deny with drift against a named database instance ruleset', async () => {
    const namedDrift = liveRtdbOperation({
      id: 'rtdb-named-drift',
      at: 1_700_000_004_000,
      instance: 'demo-live-audit-rtdb',
      method: 'get',
      path: '/audit/e42',
      result: 'allow',
      production: {
        outcome: { status: 'ok' },
        claimNames: ['role'],
        local: {
          result: 'deny',
          drift: true,
          rule: {
            path: '/audit/$entryId',
            expression: "auth != null && auth.token.role === 'auditor'",
          },
          rtdb: {
            matchedPath: '/audit/$entryId',
            matchedRule: "auth != null && auth.token.role === 'auditor'",
            pathVariableBindings: { $entryId: 'e42' },
            reason: 'Read denied by rule at /audit/$entryId',
            rtdbTrace: [
              {
                path: '/audit/$entryId',
                kind: 'read',
                conditionText: "auth != null && auth.token.role === 'auditor'",
                verdict: 'DENY',
                pathVariableBindings: { $entryId: 'e42' },
              },
            ],
          },
        },
      },
    });

    const { container } = await mountTrafficSurface({
      history: [namedDrift],
      liveHost: true,
    });

    const rowButton = container.querySelector(
      '[data-pyric-traffic-id="rtdb-named-drift"] [data-pyric-traffic-row]',
    );
    fireEvent.click(rowButton!);
    await flush();

    expect(currentPath().tab).toBe('traffic');
    // The live row's detail carries the drift sentence once, beside the rules view.
    const rowDetail = container.querySelector('[data-pyric-ui="traffic-row-detail"]');
    expect(rowDetail?.querySelectorAll('[data-drift-reason]').length).toBe(1);
    const inspector = rowDetail?.querySelector('[data-pyric-ui="traffic-live-rules-inspector"]');
    expect(inspector).not.toBeNull();
    expect(inspector?.textContent).toContain('production ok');
    // The local deny is advisory: it reads as what the local rules would do, under production's ok.
    const badge = inspector?.querySelector('[data-pyric-ui="denial-detail"] [data-pyric-badge-kind]');
    expect(badge?.textContent).toBe('local rules would deny');
    const advisory = inspector?.querySelector('[data-pyric-ui="denial-detail-advisory"]');
    expect(advisory?.textContent).toContain('Local rules would deny get on /audit/e42');
    const productionLine = inspector?.querySelector('[data-production-verdict]');
    expect(productionLine?.compareDocumentPosition(advisory!)).toBe(Node.DOCUMENT_POSITION_FOLLOWING);
    expect(inspector?.textContent).toContain('$entryId');
    expect(inspector?.textContent).toContain('e42');
    const source = container.querySelector('[data-pyric-ui="rtdb-rule-source"]');
    expect(source?.getAttribute('data-marked-line')).toBe('5');
  });

  it('expands unevaluated live RTDB and Firestore rows in place with missing runtime context and neutral rule source line', async () => {
    const unevaluatedRtdb = liveRtdbOperation({
      id: 'rtdb-write-uneval',
      at: 1_700_000_005_000,
      method: 'set',
      path: '/rooms/s9',
      result: 'allow',
      production: {
        outcome: { status: 'ok' },
        claimNames: ['admin'],
        local: {
          result: 'unevaluated',
          needs: ['stored-document', 'write-data'],
          rule: {
            path: '/rooms/$roomId',
            expression: "auth != null && !data.exists() && newData.hasChild('title')",
          },
          rtdb: {
            matchedPath: '/rooms/$roomId',
            matchedRule: "auth != null && !data.exists() && newData.hasChild('title')",
            pathVariableBindings: { $roomId: 's9' },
          },
        },
      },
    });

    const unevaluatedFirestore: SandboxOperationEvent = {
      id: 'fs-read-uneval',
      kind: 'operation',
      service: 'firestore',
      at: 1_700_000_006_000,
      method: 'getDoc',
      path: 'rooms/r1',
      auth: { uid: 'alice' },
      result: 'deny',
      origin: 'user',
      rulesDisposition: OBSERVED_DISPOSITION,
      production: {
        outcome: { status: 'error', code: 'permission-denied' },
        local: {
          result: 'unevaluated',
          needs: ['stored-document'],
          rule: { line: 5, expression: 'resource.data.public == true' },
        },
      },
    } as SandboxOperationEvent;

    const { container } = await mountTrafficSurface({
      history: [unevaluatedRtdb, unevaluatedFirestore],
      liveHost: true,
    });

    const rtdbButton = container.querySelector(
      '[data-pyric-traffic-id="rtdb-write-uneval"] [data-pyric-traffic-row]',
    );
    fireEvent.click(rtdbButton!);
    await flush();

    expect(currentPath().tab).toBe('traffic');
    expect(currentPath().query.inspect).toBe('rtdb-write-uneval');

    const rtdbInspector = container.querySelector(
      '[data-pyric-ui="traffic-live-rules-inspector"][data-live-unevaluated]',
    );
    expect(rtdbInspector).not.toBeNull();
    expect(rtdbInspector?.textContent).toContain('production ok');
    expect(rtdbInspector?.querySelector('[data-live-need="stored-document"]')).not.toBeNull();
    expect(rtdbInspector?.querySelector('[data-live-need="write-data"]')).not.toBeNull();
    expect(rtdbInspector?.textContent).toContain('$roomId → s9');
    expect(rtdbInspector?.textContent).toContain('token claim names: admin');
    const rtdbRuleSource = rtdbInspector?.querySelector(
      '[data-pyric-ui="live-unevaluated-rule-source"]',
    );
    expect(rtdbRuleSource?.getAttribute('data-marked-line')).toBe('13');
    expect(rtdbRuleSource?.querySelector('.cm-contextLine')).not.toBeNull();
    expect(rtdbInspector?.textContent).toContain('applicable rule — /rooms/$roomId .write');

    const fsButton = container.querySelector(
      '[data-pyric-traffic-id="fs-read-uneval"] [data-pyric-traffic-row]',
    );
    fireEvent.click(fsButton!);
    await flush();

    expect(currentPath().tab).toBe('traffic');
    expect(currentPath().query.inspect).toBe('fs-read-uneval');
    const fsInspector = container.querySelector(
      '[data-pyric-ui="traffic-live-rules-inspector"][data-live-unevaluated]',
    );
    expect(fsInspector).not.toBeNull();
    expect(fsInspector?.textContent).toContain('production denied');
    expect(fsInspector?.querySelector('[data-live-need="stored-document"]')).not.toBeNull();
    const fsRuleSource = fsInspector?.querySelector(
      '[data-pyric-ui="live-unevaluated-rule-source"]',
    );
    expect(fsRuleSource?.getAttribute('data-marked-line')).toBe('5');
    // A Firestore rule from a simulation missing inputs is labelled as such, not as the applicable rule.
    expect(fsInspector?.textContent).toContain('rule evaluated with missing inputs — allow read · line 5');
    expect(fsInspector?.textContent).not.toContain('applicable rule');
  });

  it('offers no record link for a production RTDB row and keeps the sandbox-served RTDB row\'s /rtdb link on a live host', async () => {
    const liveAdminSet = liveRtdbOperation({
      id: 'rtdb-live-admin',
      at: 1_700_000_007_000,
      method: 'Reference.set',
      path: '/rooms/s1',
      rulesDisposition: { kind: 'bypassed', reason: 'admin' },
      production: {
        outcome: { status: 'ok' },
      },
    });
    const sandboxAdminSet: SandboxOperationEvent = {
      id: 'rtdb-sandbox-admin',
      kind: 'operation',
      service: 'rtdb',
      at: 1_700_000_009_000,
      method: 'set',
      path: '/rooms/s1',
      auth: null,
      result: 'allow',
      origin: 'user',
      rulesDisposition: { kind: 'bypassed', reason: 'admin' },
    } as SandboxOperationEvent;

    const { container } = await mountTrafficSurface({
      history: [liveAdminSet, sandboxAdminSet],
      liveHost: true,
    });
    const detailActions = () => [...container.querySelectorAll('[data-pyric-ui="traffic-row-detail"] .traffic__row-detail-action')];

    // On a live host every row opens in place; production's RTDB data is not in the local viewer, so no link.
    fireEvent.click(container.querySelector('[data-pyric-traffic-id="rtdb-live-admin"] [data-pyric-traffic-row]')!);
    await flush();
    expect(currentPath().query.inspect).toBe('rtdb-live-admin');
    expect(detailActions()).toHaveLength(0);

    fireEvent.click(container.querySelector('[data-pyric-traffic-id="rtdb-sandbox-admin"] [data-pyric-traffic-row]')!);
    await flush();
    expect(currentPath().query.inspect).toBe('rtdb-sandbox-admin');
    const [openRecord] = detailActions();
    expect(openRecord?.textContent).toBe('Open the record');
    fireEvent.click(openRecord!);
    expect(currentPath().tab).toBe('rtdb');
  });

  it('renders Matched rule — paused on uncaptured path headings and missing path pills when missingPaths is present', async () => {
    const pausedRtdb = liveRtdbOperation({
      id: 'rtdb-paused-path',
      at: 1_700_000_011_000,
      method: 'get',
      path: '/rooms/s9',
      production: {
        outcome: { status: 'ok' },
        local: {
          result: 'unevaluated',
          needs: ['stored-document'],
          missingPaths: ['/workspaces/ws-1/archived'],
          rule: { path: '/rooms/$roomId', expression: 'auth != null && auth.uid === $roomId' },
          rtdb: {
            matchedPath: '/rooms/$roomId',
            matchedRule: 'auth != null && auth.uid === $roomId',
            pathVariableBindings: { $roomId: 's9' },
          },
        },
      },
    });
    const pausedFirestore = {
      id: 'fs-paused-paths',
      kind: 'operation',
      service: 'firestore',
      at: 1_700_000_012_000,
      method: 'getDoc',
      path: 'rooms/r1',
      auth: { uid: 'alice' },
      result: 'deny',
      origin: 'user',
      rulesDisposition: OBSERVED_DISPOSITION,
      production: {
        outcome: { status: 'error', code: 'permission-denied' },
        local: {
          result: 'unevaluated',
          needs: ['stored-document'],
          missingPaths: ['admins/alice', 'rooms/r1'],
          rule: { line: 5, expression: 'resource.data.public == true' },
        },
      },
    } as SandboxOperationEvent;

    const { container } = await mountTrafficSurface({
      history: [pausedRtdb, pausedFirestore],
      liveHost: true,
    });

    fireEvent.click(container.querySelector('[data-pyric-traffic-id="rtdb-paused-path"] [data-pyric-traffic-row]')!);
    await flush();
    const rtdbInspector = container.querySelector('[data-pyric-ui="traffic-live-rules-inspector"][data-live-unevaluated]');
    expect(rtdbInspector?.textContent).toContain('Matched rule — paused on uncaptured path /workspaces/ws-1/archived');
    expect(rtdbInspector?.querySelector('[data-missing-path="/workspaces/ws-1/archived"]')).not.toBeNull();

    fireEvent.click(container.querySelector('[data-pyric-traffic-id="fs-paused-paths"] [data-pyric-traffic-row]')!);
    await flush();
    const fsInspector = container.querySelector('[data-pyric-ui="traffic-live-rules-inspector"][data-live-unevaluated]');
    expect(fsInspector?.textContent).toContain('Matched rule — paused on uncaptured paths admins/alice, rooms/r1');
    expect(fsInspector?.querySelector('[data-missing-path="admins/alice"]')).not.toBeNull();
    expect(fsInspector?.querySelector('[data-missing-path="rooms/r1"]')).not.toBeNull();
  });
});
