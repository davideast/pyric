// Install JSDOM globals before importing React or RTL.
import { JSDOM } from 'jsdom';
const dom = new JSDOM('<!DOCTYPE html><html><body></body></html>', {
  pretendToBeVisual: true,
  url: 'http://localhost:3473/functions',
});
const g = globalThis as Record<string, unknown>;
g.window = dom.window;
g.document = dom.window.document;
g.navigator = dom.window.navigator;
g.HTMLElement = dom.window.HTMLElement;
g.HTMLInputElement = dom.window.HTMLInputElement;
g.HTMLTextAreaElement = dom.window.HTMLTextAreaElement;
g.HTMLSelectElement = dom.window.HTMLSelectElement;
g.HTMLButtonElement = dom.window.HTMLButtonElement;
g.SVGElement = dom.window.SVGElement;
g.Element = dom.window.Element;
g.Node = dom.window.Node;
g.Event = dom.window.Event;
g.MouseEvent = dom.window.MouseEvent;
g.KeyboardEvent = dom.window.KeyboardEvent;
g.getComputedStyle = dom.window.getComputedStyle.bind(dom.window);
g.IS_REACT_ACT_ENVIRONMENT = true;

import { afterEach, describe, expect, it } from 'bun:test';
import { act, cleanup, fireEvent, render, waitFor } from '@testing-library/react';
import type { SandboxEvent } from 'pyric/sandbox';
import { DevSeedProvider } from '../../../src/dev/DevSeedProvider.js';
import { EnvironmentProvider } from '../../../src/shell/environment.js';
import { ROUTES } from '../../../src/shell/routes.js';
import { hrefFor } from '../../../src/shell/router.js';
import { resetServeInitForTests } from '../../../src/shell/serve-init.js';
import { matchCommands } from '../../../src/features/home/command.js';
import {
  FunctionsSurface,
  type DiscoveredTrigger,
  type FireOutcome,
  type FireTriggerInput,
  type FunctionExecution,
  type FunctionsApi,
  type FunctionsSurfaceProps,
  type UnsupportedTrigger,
} from '../../../src/features/functions/index.js';

afterEach(() => {
  cleanup();
});

/** Drive controlled inputs cleanly in Studio's shared JSDOM test realm. */
function changeInput(input: HTMLElement, value: string): void {
  const propsKey = Object.keys(input).find((key) => key.startsWith('__reactProps'));
  act(() => {
    const props = propsKey
      ? (input as unknown as Record<string, { onChange?: (ev: { target: { value: string } }) => void }>)[propsKey]
      : undefined;
    if (props?.onChange) {
      props.onChange({ target: { value } });
    } else {
      fireEvent.change(input, { target: { value } });
    }
  });
}

const SAMPLE_TRIGGERS: DiscoveredTrigger[] = [
  {
    exportName: 'apiHandler',
    eventType: 'https',
    regions: ['us-central1'],
    platform: 'gcfv2',
  },
  {
    exportName: 'computeScore',
    eventType: 'callable',
    regions: ['us-east1'],
    platform: 'gcfv2',
  },
  {
    exportName: 'onOrderCreated',
    eventType: 'google.cloud.firestore.document.v1.created',
    document: 'orders/{orderId}',
    database: '(default)',
    location: 'us-central1',
  },
  {
    exportName: 'makeUppercase',
    eventType: 'google.firebase.database.ref.v1.created',
    reference: 'messages/{pushId}/original',
    instance: 'demo-default-rtdb',
    location: 'us-central1',
  },
  {
    exportName: 'thumbMaker',
    eventType: 'google.cloud.storage.object.v1.finalized',
    bucket: 'media-uploads',
  },
  {
    exportName: 'guardSignup',
    eventType: 'providers/cloud.auth/eventTypes/user.beforeCreate',
  },
  {
    exportName: 'consumeOrders',
    eventType: 'google.cloud.pubsub.topic.v1.messagePublished',
    topic: 'orders',
    topicResource: 'projects/demo-app/topics/orders',
  },
  {
    exportName: 'nightlyDigest',
    eventType: 'schedule',
    schedule: 'every day 01:00',
    timeZone: 'UTC',
    regions: ['us-central1'],
  },
  {
    exportName: 'sendWelcomeTask',
    eventType: 'task-queue',
    regions: ['us-central1'],
  },
];

const SAMPLE_UNSUPPORTED: UnsupportedTrigger[] = [
  {
    exportName: 'legacyCron',
    eventType: 'schedule (v1 pubsub.schedule is not supported)',
  },
  {
    exportName: 'omittedFn',
    eventType: 'google.cloud.firestore.document.v1.deleted (omitted from emulation)',
  },
];

const SAMPLE_EXECUTIONS: FunctionExecution[] = [
  {
    id: '1',
    trigger: 'makeUppercase',
    cause: { ref: '/messages/m1/original', params: { pushId: 'm1' } },
    startedAt: 1700000001000,
    durationMs: 24,
    status: 'fulfilled',
    result: { upper: 'HELLO' },
  },
  {
    id: '2',
    trigger: 'apiHandler',
    cause: { ref: '/api/orders', params: { method: 'POST', status: '500' } },
    startedAt: 1700000002000,
    durationMs: 112,
    status: 'rejected',
    error: 'POST /api/orders responded 500',
  },
];

function createFakeApi(options: {
  triggers?: DiscoveredTrigger[];
  unsupported?: UnsupportedTrigger[];
  executions?: FunctionExecution[];
  onFire?: (trigger: DiscoveredTrigger, input: FireTriggerInput) => Promise<FireOutcome>;
  listFailure?: { kind: 'shared-worker-fallback' | 'no-bridge' | 'error'; message: string };
} = {}): FunctionsApi {
  let executions = [...(options.executions ?? [])];
  return {
    origin: 'http://localhost:3473',
    projectId: 'demo-app',
    async listTriggers() {
      if (options.listFailure) {
        return { ok: false, failure: options.listFailure };
      }
      return {
        ok: true,
        data: {
          triggers: options.triggers ?? [],
          unsupported: options.unsupported ?? [],
          summary: `${(options.triggers ?? []).length} trigger(s)`,
        },
      };
    },
    async listExecutions() {
      return { ok: true, data: executions };
    },
    async fireTrigger(trigger, input) {
      if (options.onFire) {
        const res = await options.onFire(trigger, input);
        if (res.ok) {
          executions = [
            ...executions,
            {
              id: String(executions.length + 1),
              trigger: trigger.exportName,
              cause: { ref: input.path ?? trigger.exportName, params: {} },
              startedAt: 1700000005000,
              durationMs: 15,
              status: 'fulfilled',
              result: res.result,
            },
          ];
        }
        return res;
      }
      return { ok: true, summary: `Ran ${trigger.exportName}`, executionId: '99', result: { ok: true } };
    },
  };
}

function renderSurface(props: FunctionsSurfaceProps) {
  resetServeInitForTests({ status: 'absent', payload: null });
  return render(
    <DevSeedProvider>
      <EnvironmentProvider mode="local">
        <FunctionsSurface {...props} />
      </EnvironmentProvider>
    </DevSeedProvider>,
  );
}

describe('FunctionsSurface', () => {
  it('wires /functions into Studio routes and Command-K navigation', () => {
    expect(hrefFor({ tab: 'functions' })).toBe('/functions');
    const results = matchCommands('func', ROUTES);
    expect(results[0]).toMatchObject({
      label: 'Go to Functions',
      target: { tab: 'functions' },
    });
  });

  it('renders discovered triggers across all 9 families, unsupported diagnostics, and keyboard tab filtering', async () => {
    const view = renderSurface({
      api: createFakeApi({
        triggers: SAMPLE_TRIGGERS,
        unsupported: SAMPLE_UNSUPPORTED,
        executions: SAMPLE_EXECUTIONS,
      }),
    });

    await waitFor(() => {
      expect(view.container.querySelectorAll('[data-functions-trigger]').length).toBe(9);
    });

    // Endpoint URLs, patterns, and region badges
    expect(view.container.textContent).toContain('http://localhost:3473/demo-app/us-central1/apiHandler');
    expect(view.container.textContent).toContain('http://localhost:3473/demo-app/us-east1/computeScore');
    expect(view.container.textContent).toContain('orders/{orderId}');
    expect(view.container.textContent).toContain('/messages/{pushId}/original');
    expect(view.container.textContent).toContain('gs://media-uploads');
    expect(view.container.textContent).toContain('projects/demo-app/topics/orders');
    expect(view.container.textContent).toContain('every day 01:00');

    // Unsupported-trigger diagnostics panel
    const unsupportedEl = view.container.querySelector('[data-functions-unsupported]');
    expect(unsupportedEl).not.toBeNull();
    expect(unsupportedEl!.textContent).toContain('legacyCron');
    expect(unsupportedEl!.textContent).toContain('v1 pubsub.schedule is not supported');
    expect(unsupportedEl!.textContent).toContain('omittedFn');
    expect(unsupportedEl!.textContent).toContain('omitted from emulation');

    // Keyboard navigation on family tabs (ArrowRight moves All -> HTTP)
    const allTab = view.container.querySelector('[data-functions-family-tab="all"]') as HTMLButtonElement;
    allTab.focus();
    fireEvent.keyDown(allTab, { key: 'ArrowRight' });

    await waitFor(() => {
      const httpTab = view.container.querySelector('[data-functions-family-tab="http"]');
      expect(httpTab?.getAttribute('aria-selected')).toBe('true');
      expect(view.container.querySelectorAll('[data-functions-trigger]').length).toBe(1);
    });

    // End jumps to Tasks; Home returns to All
    const httpTab = view.container.querySelector('[data-functions-family-tab="http"]') as HTMLButtonElement;
    fireEvent.keyDown(httpTab, { key: 'End' });
    await waitFor(() => {
      const tasksTab = view.container.querySelector('[data-functions-family-tab="tasks"]');
      expect(tasksTab?.getAttribute('aria-selected')).toBe('true');
    });
    const tasksTab = view.container.querySelector('[data-functions-family-tab="tasks"]') as HTMLButtonElement;
    fireEvent.keyDown(tasksTab, { key: 'Home' });
    await waitFor(() => {
      expect(view.container.querySelectorAll('[data-functions-trigger]').length).toBe(9);
    });

    // Search filter + Clear filters recovery
    const search = view.getByLabelText('Filter functions') as HTMLInputElement;
    changeInput(search, 'does-not-exist');
    expect(view.container.querySelector('[data-functions-filtered-empty]')).not.toBeNull();
    fireEvent.click(view.getByText('Clear filters'));
    expect(view.container.querySelectorAll('[data-functions-trigger]').length).toBe(9);
  });

  it('rejects malformed Fire JSON payloads inline without calling the bridge, then succeeds on valid input', async () => {
    const firedCalls: Array<{ name: string; input: FireTriggerInput }> = [];
    const view = renderSurface({
      api: createFakeApi({
        triggers: [SAMPLE_TRIGGERS[3]!, SAMPLE_TRIGGERS[6]!, SAMPLE_TRIGGERS[7]!],
        onFire: async (trigger, input) => {
          firedCalls.push({ name: trigger.exportName, input });
          return {
            ok: true,
            summary: `Ran ${trigger.exportName}`,
            executionId: '42',
            result: { upper: 'HELLO' },
          };
        },
      }),
    });

    await waitFor(() => {
      expect(view.container.querySelector('[data-functions-fire-toggle="makeUppercase"]')).not.toBeNull();
    });

    // Open RTDB Fire drawer
    const toggle = view.container.querySelector(
      '[data-functions-fire-toggle="makeUppercase"]',
    ) as HTMLButtonElement;
    fireEvent.click(toggle);
    expect(toggle.getAttribute('aria-expanded')).toBe('true');

    // Malformed JSON payload must be caught client-side
    const payloadArea = view.getByLabelText('Event value (JSON, optional)') as HTMLTextAreaElement;
    changeInput(payloadArea, '{broken json');
    fireEvent.click(view.container.querySelector('[data-functions-fire-submit="makeUppercase"]')!);

    expect(firedCalls).toHaveLength(0);
    const alert = view.container.querySelector('[data-functions-fire-validation]');
    expect(alert).not.toBeNull();
    expect(alert!.textContent).toContain('Invalid JSON payload');
    expect(payloadArea.getAttribute('aria-invalid')).toBe('true');

    // Invalid timeout flags ONLY the timeout input, not the payload textarea
    changeInput(payloadArea, '{"text":"hello"}');
    const timeoutInput = view.getByLabelText('Timeout (ms, optional)') as HTMLInputElement;
    changeInput(timeoutInput, '999999');
    fireEvent.click(view.container.querySelector('[data-functions-fire-submit="makeUppercase"]')!);
    expect(firedCalls).toHaveLength(0);
    expect(timeoutInput.getAttribute('aria-invalid')).toBe('true');
    expect(payloadArea.getAttribute('aria-invalid')).toBeNull();
    changeInput(timeoutInput, '');

    // Valid JSON payload dispatches and shows inline success + refreshes executions
    fireEvent.click(view.container.querySelector('[data-functions-fire-submit="makeUppercase"]')!);

    await waitFor(() => {
      const resultBox = view.container.querySelector('[data-functions-fire-outcome="ok"]');
      expect(resultBox).not.toBeNull();
      expect(resultBox!.textContent).toContain('run #42');
      expect(resultBox!.textContent).toContain('HELLO');
    });
    expect(firedCalls).toHaveLength(1);
    expect(firedCalls[0]!.input).toEqual({
      path: 'messages/sample-pushId/original',
      payload: { text: 'hello' },
    });

    // Escape closes the drawer and restores focus to the toggle
    const form = view.container.querySelector('[data-functions-fire-form="makeUppercase"]')!;
    fireEvent.keyDown(form, { key: 'Escape' });
    expect(view.container.querySelector('[data-functions-fire-form="makeUppercase"]')).toBeNull();
    expect(document.activeElement).toBe(toggle);

    // Pub/Sub rejects non-string attributes and Scheduler rejects array options
    fireEvent.click(view.container.querySelector('[data-functions-fire-toggle="consumeOrders"]')!);
    changeInput(view.getByLabelText('Attributes (JSON string map, optional)'), '{"count": 5}');
    fireEvent.click(view.container.querySelector('[data-functions-fire-submit="consumeOrders"]')!);
    expect(firedCalls).toHaveLength(1);
    expect(view.container.querySelector('[data-functions-fire-validation]')?.textContent).toContain(
      'string value',
    );

    fireEvent.click(view.container.querySelector('[data-functions-fire-toggle="nightlyDigest"]')!);
    changeInput(view.getByLabelText('Schedule options (JSON object, optional)'), '[1, 2]');
    fireEvent.click(view.container.querySelector('[data-functions-fire-submit="nightlyDigest"]')!);
    expect(firedCalls).toHaveLength(1);
    expect(view.container.textContent).toContain('Scheduler options must be a JSON object.');
  });

  it('merges live service:functions execution_finished events and filters/expands execution details', async () => {
    const liveEvents: SandboxEvent[] = [
      {
        kind: 'service_mutation',
        id: 'live-evt-1',
        at: 1700000003500,
        service: 'functions',
        op: 'execution_finished',
        path: 'schedule/nightlyDigest',
        auth: null,
        detail: {
          trigger: 'nightlyDigest',
          params: { scheduleTime: '2026-11-27T01:00:00Z' },
          startedAt: 1700000003000,
          durationMs: 310,
          status: 'timeout',
        },
      } as SandboxEvent,
    ];

    const view = renderSurface({
      api: createFakeApi({
        triggers: SAMPLE_TRIGGERS,
        executions: SAMPLE_EXECUTIONS,
      }),
      eventsOverride: liveEvents,
    });

    await waitFor(() => {
      expect(view.container.querySelectorAll('[data-functions-execution]').length).toBe(3);
    });

    // Inline error preview for rejected execution
    expect(view.container.querySelector('[data-functions-exec-error]')?.textContent).toContain(
      'POST /api/orders responded 500',
    );

    // Filter executions to Rejected only
    fireEvent.click(view.container.querySelector('[data-functions-status-filter="rejected"]')!);
    expect(view.container.querySelectorAll('[data-functions-execution]').length).toBe(1);

    // Expand detail row to inspect params and full error
    const rowBtn = view.container.querySelector('[data-functions-execution="2"] button')!;
    fireEvent.click(rowBtn);
    const detail = view.container.querySelector('[data-functions-exec-detail="2"]');
    expect(detail).not.toBeNull();
    expect(detail!.textContent).toContain('POST /api/orders responded 500');
    expect(detail!.textContent).toContain('method');
  });

  it('renders empty state, SharedWorker fallback, no-bridge fallback, and Retry on error cleanly', async () => {
    // 1. Empty state when project has no functions
    const emptyView = renderSurface({
      api: createFakeApi({ triggers: [], unsupported: [], executions: [] }),
    });
    await waitFor(() => {
      expect(emptyView.container.querySelector('[data-functions-empty]')).not.toBeNull();
    });
    expect(emptyView.container.querySelector('[data-functions-executions-empty]')).not.toBeNull();
    cleanup();

    // 2. SharedWorker fallback notice while still rendering live execution stream
    const fallbackEvents: SandboxEvent[] = [
      {
        kind: 'service_mutation',
        id: 'sw-live-1',
        at: 1700000004000,
        service: 'functions',
        op: 'execution_finished',
        path: '/messages/m2/original',
        auth: null,
        detail: {
          trigger: 'makeUppercase',
          params: {},
          startedAt: 1700000004000,
          durationMs: 11,
          status: 'fulfilled',
        },
      } as SandboxEvent,
    ];
    const swView = renderSurface({
      api: createFakeApi({
        listFailure: {
          kind: 'shared-worker-fallback',
          message: 'Node-hosted method endpoint unavailable.',
        },
      }),
      eventsOverride: fallbackEvents,
    });
    await waitFor(() => {
      expect(swView.container.querySelector('[data-functions-notice="shared-worker-fallback"]')).not.toBeNull();
    });
    expect(swView.container.querySelectorAll('[data-functions-execution]').length).toBe(1);
    cleanup();

    // 3. No-bridge notice when Studio is not served
    const noBridgeView = renderSurface({ modeOverride: 'no-bridge' });
    expect(noBridgeView.container.querySelector('[data-functions-notice="no-bridge"]')).not.toBeNull();
    cleanup();

    // 3b. Live mode notice + unsupported-only project state
    const liveView = renderSurface({ modeOverride: 'live-mode' });
    expect(liveView.container.querySelector('[data-functions-notice="live-mode"]')).not.toBeNull();
    cleanup();

    const onlyUnsupported = renderSurface({
      api: createFakeApi({ triggers: [], unsupported: SAMPLE_UNSUPPORTED, executions: [] }),
    });
    await waitFor(() => {
      expect(onlyUnsupported.container.querySelector('[data-functions-unsupported]')).not.toBeNull();
      expect(onlyUnsupported.container.querySelector('[data-functions-empty]')?.textContent).toContain(
        'No supported Functions triggers found',
      );
    });
    cleanup();

    // 4. Bridge error recovers cleanly on Retry and surfaces inline Fire errors + trigger log filter
    let failFirst = true;
    const flakyApi: FunctionsApi = {
      origin: 'http://localhost:3473',
      projectId: 'demo-app',
      async listTriggers() {
        if (failFirst) {
          failFirst = false;
          return { ok: false, failure: { kind: 'error', message: 'Temporary bridge hiccup' } };
        }
        return { ok: true, data: { triggers: [SAMPLE_TRIGGERS[0]!], unsupported: [] } };
      },
      async listExecutions() {
        return { ok: true, data: SAMPLE_EXECUTIONS };
      },
      async fireTrigger() {
        return { ok: false, summary: 'apiHandler responded HTTP 500', error: 'Boom' };
      },
    };
    const errView = renderSurface({ api: flakyApi });
    await waitFor(() => {
      expect(errView.container.querySelector('[data-functions-notice="error"]')).not.toBeNull();
    });
    fireEvent.click(errView.getByText('Retry'));
    await waitFor(() => {
      expect(errView.container.querySelectorAll('[data-functions-trigger]').length).toBe(1);
    });

    // Trigger card Logs filter scopes executions to apiHandler, then clears back to 2
    fireEvent.click(errView.getByText('Logs'));
    expect(errView.container.querySelectorAll('[data-functions-execution]').length).toBe(1);
    fireEvent.click(errView.getByLabelText('Clear trigger filter'));
    expect(errView.container.querySelectorAll('[data-functions-execution]').length).toBe(2);

    // Failed Fire response surfaces inline role="alert"
    fireEvent.click(errView.container.querySelector('[data-functions-fire-toggle="apiHandler"]')!);
    fireEvent.click(errView.container.querySelector('[data-functions-fire-submit="apiHandler"]')!);
    await waitFor(() => {
      const outcome = errView.container.querySelector('[data-functions-fire-outcome="error"]');
      expect(outcome).not.toBeNull();
      expect(outcome!.textContent).toContain('HTTP 500');
    });
  });
});
