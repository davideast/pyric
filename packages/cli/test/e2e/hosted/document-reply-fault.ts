import type { Page } from '@playwright/test';

/** Corrupt one real document delivery, retaining its correlation and transport. */
export async function installDocumentReplyFault(page: Page, json: string, delivery: 'res' | 'snap' = 'res'): Promise<void> {
  await installReplyFault(page, { kind: 'document', json, delivery });
}

/** Replace selected replies with malformed envelopes from a fixture-owned DOM field. */
export async function installEnvelopeReplyFault(page: Page, delivery: 'res' | 'snap' = 'res'): Promise<void> {
  await installReplyFault(page, { kind: 'envelope', json: '', delivery });
}

export async function installBridgeReplyFault(page: Page): Promise<void> {
  await installReplyFault(page, { kind: 'bridge-envelope', json: '', delivery: 'res' });
}

async function installReplyFault(page: Page, fault: { kind: 'document' | 'envelope' | 'bridge-envelope'; json: string; delivery: 'res' | 'snap' }): Promise<void> {
  await page.addInitScript(({ kind, json, delivery }) => {
    function isRecord(value: unknown): value is Record<string, unknown> {
      const isObject = value !== null && typeof value === 'object';
      return isObject;
    }
    let lastInjection: string | undefined;
    function intercept(event: MessageEvent, deliver: (data: unknown) => void): void {
      const injection = document.documentElement?.dataset.inject;
      const isArmed = injection !== undefined && injection !== lastInjection;
      if (isArmed) {
        const isJson = typeof event.data === 'string';
        let parsed: unknown = event.data;
        if (isJson) {
          try { parsed = JSON.parse(event.data); } catch { return; }
        }
        const frame = parsed;
        const isBridge = isRecord(frame) && frame.type === 'worker-message-result';
        const message = isBridge ? frame.message : frame;
        const isDelivery = isRecord(message) && message.t === delivery;
        const value = isDelivery ? message.value : undefined;
        const isDocument = isRecord(value) && value.path === 'shared/greeting';
        const data = isDocument ? value.data : undefined;
        const isTarget = isDelivery && isDocument && isRecord(data);
        if (isTarget) {
          lastInjection = injection;
          event.stopImmediatePropagation();
          const replacesEnvelope = kind !== 'document';
          const replacement = replacesEnvelope
            ? JSON.parse(document.documentElement.dataset.fault ?? 'null')
            : { ...message, value: { ...value, data: { ...data, json } } };
          const hasCorrelationPlaceholder = isRecord(replacement) && replacement.subId === '$correlation';
          if (hasCorrelationPlaceholder) replacement.subId = message.subId;
          const hasRequestPlaceholder = isRecord(replacement) && replacement.id === '$correlation';
          if (hasRequestPlaceholder) replacement.id = message.id;
          const preservesBridge = isBridge && kind !== 'bridge-envelope';
          const output = preservesBridge ? { ...frame, message: replacement } : replacement;
          deliver(isJson ? JSON.stringify(output) : output);
          document.documentElement.dataset.injected = 'true';
        }
      }
    }
    const NativeWebSocket = WebSocket;
    globalThis.WebSocket = class extends NativeWebSocket {
      constructor(...args: ConstructorParameters<typeof WebSocket>) {
        super(...args);
        this.addEventListener('message', event => intercept(event, data => {
          this.dispatchEvent(new MessageEvent('message', { data }));
        }));
      }
    };
    const NativeSharedWorker = SharedWorker;
    globalThis.SharedWorker = class extends NativeSharedWorker {
      constructor(...args: ConstructorParameters<typeof SharedWorker>) {
        super(...args);
        this.port.addEventListener('message', event => intercept(event, data => {
          this.port.dispatchEvent(new MessageEvent('message', { data }));
        }));
      }
    };
  }, fault);
}
