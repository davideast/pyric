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
import { DevSeedProvider } from '../../../src/dev/DevSeedProvider.js';
import { EnvironmentProvider } from '../../../src/shell/environment.js';
import { resetServeInitForTests } from '../../../src/shell/serve-init.js';
import {
  FunctionsSurface,
  createFunctionsBridgeApi,
  type DiscoveredTrigger,
  type FireTriggerInput,
  type FunctionsApi,
} from '../../../src/features/functions/index.js';

afterEach(() => {
  cleanup();
});

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

function renderWithApi(api: FunctionsApi) {
  resetServeInitForTests({ status: 'absent', payload: null });
  return render(
    <DevSeedProvider>
      <EnvironmentProvider mode="local">
        <FunctionsSurface api={api} />
      </EnvironmentProvider>
    </DevSeedProvider>,
  );
}

describe('FunctionsSurface refresh and health hydration', () => {
  it('hydrates projectId from /__pyric/health for rendered URLs and HTTP Fire on non-RTDB projects', async () => {
    const requestedUrls: string[] = [];
    const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
      requestedUrls.push(url);
      if (url.endsWith('/__pyric/health')) {
        return new Response(
          JSON.stringify({ status: 'ok', project: 'my-real-app', instanceId: 'inst-1' }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      }
      if (url.endsWith('/__pyric/hosted/method')) {
        const body = JSON.parse(String(init?.body ?? '{}')) as { key: string };
        if (body.key === 'functions.listTriggers') {
          return new Response(
            JSON.stringify({
              ok: true,
              summary: '1 trigger(s)',
              data: {
                triggers: [{ exportName: 'apiHandler', eventType: 'https', regions: ['us-central1'] }],
                unsupported: [],
              },
            }),
            { status: 200, headers: { 'content-type': 'application/json' } },
          );
        }
        return new Response(
          JSON.stringify({ ok: true, summary: '0 executions', data: { executions: [] } }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      }
      if (url === 'http://localhost:3473/my-real-app/us-central1/apiHandler') {
        return new Response(JSON.stringify({ pong: true }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      return new Response('not found', { status: 404 });
    }) as typeof fetch;

    const api = createFunctionsBridgeApi({
      baseUrl: 'http://localhost:3473',
      instanceId: 'inst-1',
      projectDir: '/workspace/no-rtdb',
      projectId: null,
      fetchImpl,
    });

    const view = renderWithApi(api);
    await waitFor(() => {
      expect(view.container.textContent).toContain(
        'http://localhost:3473/my-real-app/us-central1/apiHandler',
      );
    });
    expect(view.container.textContent).not.toContain('/demo-project/');

    fireEvent.click(view.container.querySelector('[data-functions-fire-toggle="apiHandler"]')!);
    fireEvent.click(view.container.querySelector('[data-functions-fire-submit="apiHandler"]')!);
    await waitFor(() => {
      expect(view.container.querySelector('[data-functions-fire-outcome="ok"]')).not.toBeNull();
    });
    expect(requestedUrls).toContain('http://localhost:3473/my-real-app/us-central1/apiHandler');
  });

  it('resets selectedFamily to All without a keyboard tab trap when the selected family disappears after Refresh', async () => {
    const httpTrigger: DiscoveredTrigger = {
      exportName: 'apiHandler',
      eventType: 'https',
      regions: ['us-central1'],
    };
    const pubsubTrigger: DiscoveredTrigger = {
      exportName: 'consumeOrders',
      eventType: 'google.cloud.pubsub.topic.v1.messagePublished',
      topic: 'orders',
    };

    let currentTriggers: DiscoveredTrigger[] = [httpTrigger, pubsubTrigger];
    const api: FunctionsApi = {
      origin: 'http://localhost:3473',
      projectId: 'demo-app',
      async listTriggers() {
        return { ok: true, data: { triggers: currentTriggers, unsupported: [] } };
      },
      async listExecutions() {
        return { ok: true, data: [] };
      },
      async fireTrigger() {
        return { ok: true, summary: 'ok' };
      },
    };

    const view = renderWithApi(api);
    await waitFor(() => {
      expect(view.container.querySelector('[data-functions-family-tab="pubsub"]')).not.toBeNull();
    });

    // Select Pub/Sub tab
    fireEvent.click(view.container.querySelector('[data-functions-family-tab="pubsub"]')!);
    expect(
      view.container.querySelector('[data-functions-family-tab="pubsub"]')?.getAttribute('aria-selected'),
    ).toBe('true');
    expect(view.container.querySelectorAll('[data-functions-trigger]').length).toBe(1);

    // Remove Pub/Sub trigger and Refresh
    currentTriggers = [httpTrigger];
    fireEvent.click(view.container.querySelector('[data-functions-refresh]')!);

    await waitFor(() => {
      expect(view.container.querySelectorAll('[data-functions-family-tab="pubsub"]').length).toBe(0);
    });
    const allTab = view.container.querySelector('[data-functions-family-tab="all"]')!;
    expect(allTab.getAttribute('aria-selected')).toBe('true');
    expect(allTab.getAttribute('tabindex')).toBe('0');
    expect(view.container.querySelectorAll('[data-functions-trigger]').length).toBe(1);
    expect(view.container.querySelector('[data-functions-filtered-empty]')).toBeNull();

    // Re-adding Pub/Sub later stays on All instead of snapping back to stale selection
    currentTriggers = [httpTrigger, pubsubTrigger];
    fireEvent.click(view.container.querySelector('[data-functions-refresh]')!);
    await waitFor(() => {
      expect(view.container.querySelector('[data-functions-family-tab="pubsub"]')).not.toBeNull();
    });
    expect(
      view.container.querySelector('[data-functions-family-tab="all"]')?.getAttribute('aria-selected'),
    ).toBe('true');
    expect(view.container.querySelectorAll('[data-functions-trigger]').length).toBe(2);
  });

  it('syncs TriggerCard selectedRegion and untouched RTDB pathInput across Refresh while preserving custom edits', async () => {
    let currentTriggers: DiscoveredTrigger[] = [
      {
        exportName: 'apiHandler',
        eventType: 'https',
        regions: ['us-east1', 'europe-west1'],
      },
      {
        exportName: 'makeUppercase',
        eventType: 'google.firebase.database.ref.v1.created',
        reference: 'messages/{pushId}/original',
      },
    ];
    const firedCalls: Array<{ name: string; input: FireTriggerInput }> = [];

    const api: FunctionsApi = {
      origin: 'http://localhost:3473',
      projectId: 'demo-app',
      async listTriggers() {
        return { ok: true, data: { triggers: currentTriggers, unsupported: [] } };
      },
      async listExecutions() {
        return { ok: true, data: [] };
      },
      async fireTrigger(trigger, input) {
        firedCalls.push({ name: trigger.exportName, input });
        return { ok: true, summary: `Ran ${trigger.exportName}` };
      },
    };

    const view = renderWithApi(api);
    await waitFor(() => {
      expect(view.container.querySelectorAll('[data-functions-trigger]').length).toBe(2);
    });

    // Open both fire drawers before Refresh
    fireEvent.click(view.container.querySelector('[data-functions-fire-toggle="apiHandler"]')!);
    fireEvent.click(view.container.querySelector('[data-functions-fire-toggle="makeUppercase"]')!);

    // Refresh with changed regions (shrinks to single region) and changed RTDB reference
    currentTriggers = [
      {
        exportName: 'apiHandler',
        eventType: 'https',
        regions: ['asia-east1'],
      },
      {
        exportName: 'makeUppercase',
        eventType: 'google.firebase.database.ref.v1.created',
        reference: 'chats/{chatId}/body',
      },
    ];
    fireEvent.click(view.container.querySelector('[data-functions-refresh]')!);

    await waitFor(() => {
      expect(view.container.textContent).toContain(
        'http://localhost:3473/demo-app/asia-east1/apiHandler',
      );
      const rtdbPath = view.getByLabelText('Concrete RTDB path') as HTMLInputElement;
      expect(rtdbPath.value).toBe('chats/sample-chatId/body');
    });

    // Fire both and verify updated region + RTDB path are sent
    fireEvent.click(view.container.querySelector('[data-functions-fire-submit="apiHandler"]')!);
    fireEvent.click(view.container.querySelector('[data-functions-fire-submit="makeUppercase"]')!);
    await waitFor(() => {
      expect(firedCalls).toHaveLength(2);
    });
    expect(firedCalls[0]).toMatchObject({ name: 'apiHandler', input: { region: 'asia-east1' } });
    expect(firedCalls[1]).toMatchObject({
      name: 'makeUppercase',
      input: { path: 'chats/sample-chatId/body' },
    });

    // User-edited RTDB path is preserved across a subsequent Refresh
    const rtdbPath = view.getByLabelText('Concrete RTDB path') as HTMLInputElement;
    changeInput(rtdbPath, 'chats/custom-room/body');
    currentTriggers = [
      currentTriggers[0]!,
      {
        exportName: 'makeUppercase',
        eventType: 'google.firebase.database.ref.v1.created',
        reference: 'rooms/{roomId}/text',
      },
    ];
    fireEvent.click(view.container.querySelector('[data-functions-refresh]')!);
    await waitFor(() => {
      expect(view.container.textContent).toContain('/rooms/{roomId}/text');
    });
    expect((view.getByLabelText('Concrete RTDB path') as HTMLInputElement).value).toBe(
      'chats/custom-room/body',
    );
  });
});
