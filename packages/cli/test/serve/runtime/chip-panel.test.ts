import { JSDOM } from 'jsdom';
import { describe, expect, it } from 'bun:test';
import { mountPyricRuntimeChip } from '../../../src/serve/runtime/chip.js';
import { createPyricRuntimeStatus } from '../../../src/serve/runtime/status.js';
import type { PyricRuntimeManifest } from '../../../src/serve/runtime/manifest.js';
import type { SandboxEvent } from 'pyric/sandbox';
import { createListenerMode } from '../../../src/serve/runtime/listener-mode.js';
import type { ActivityIncident } from 'pyric/firestore/internal';
import {
  CHIP_TAB_KEY,
  isChipTab,
  openingChipTab,
  problemTab,
  readRememberedChipTab,
  writeRememberedChipTab,
} from '../../../src/serve/runtime/chip-tab.js';

const manifest: PyricRuntimeManifest = {
  studioUrl: '/__pyric/ui/studio',
  worker: { url: '/__pyric/sdk/worker.js', name: 'pyric-shared-worker', servedEpoch: 'bbbbbbbbbbbbbbbb' },
};

const clean = { failedRecently: false, duplicateListener: false, updatePending: false };

function duplicateIncident(events: readonly SandboxEvent[]): readonly ActivityIncident[] {
  const attachIds = events
    .filter((event) => (event as { kind: string }).kind === 'listener_attach')
    .map((event) => (event as { id: string }).id);
  if (attachIds.length === 0) return [];
  return [{
    fingerprint: 'fp1',
    pattern: 'duplicate-listener',
    confidence: 'high',
    severity: 'warning',
    service: 'firestore',
    method: 'listen',
    targetFingerprint: 'conversations',
    actor: { kind: 'unknown' },
    authLens: 'app',
    authUid: null,
    count: 2,
    windowMs: 5000,
    evidenceEventIds: attachIds,
  } as unknown as ActivityIncident];
}

function attach(id: string, listenerId: string): SandboxEvent {
  return {
    kind: 'listener_attach',
    id,
    at: 1,
    listenerId,
    target: { kind: 'query', collection: 'conversations' },
    auth: null,
    owners: [{ kind: 'tag', name: 'ChatPage' }],
  } as unknown as SandboxEvent;
}

/** A chip that starts collapsed, so every test opens it itself. */
function setup(options: { rememberedTab?: string; withListeners?: boolean } = {}) {
  const dom = new JSDOM('<!doctype html><body></body>', { url: 'http://localhost/' });
  const doc = dom.window.document;
  if (options.rememberedTab !== undefined) {
    dom.window.localStorage.setItem(CHIP_TAB_KEY, options.rememberedTab);
  }
  const runtime = createPyricRuntimeStatus(manifest);
  let deliver: ((events: readonly SandboxEvent[]) => void) | null = null;
  const chip = mountPyricRuntimeChip({
    runtime,
    document: doc,
    identity: { subscribeAuth: () => () => {} },
    getLens: () => undefined,
    setLens: () => {},
    subscribeLens: () => () => {},
    ...(options.withListeners
      ? {
          listeners: (onChange: (outlines: never) => void) => createListenerMode({
            document: doc,
            onChange: onChange as never,
            incidents: duplicateIncident,
            subscribeEvents: (callback) => {
              deliver = callback;
              return () => {
                deliver = null;
              };
            },
          }),
        }
      : {}),
  });
  const root = chip.element.shadowRoot!;
  return {
    runtime,
    chip,
    root,
    push: (events: readonly SandboxEvent[]) => deliver?.(events),
    open() {
      root.querySelector<HTMLButtonElement>('[data-expand]')!.click();
      return root.querySelector('[data-chip-view]')?.getAttribute('data-chip-view');
    },
  };
}

describe('the opening rule', () => {
  it('ranks a failure over a duplicate over a pending update, and falls back to what was remembered', () => {
    expect(openingChipTab({ ...clean, failedRecently: true, duplicateListener: true, updatePending: true }, 'sandbox'))
      .toBe('traffic');
    expect(openingChipTab({ ...clean, duplicateListener: true, updatePending: true }, 'sandbox')).toBe('listeners');
    expect(openingChipTab({ ...clean, updatePending: true }, 'identity')).toBe('sandbox');
    expect(openingChipTab(clean, 'listeners')).toBe('listeners');
    expect(openingChipTab(clean, null)).toBe('identity');
  });

  it('colours the same tab the opening rule would land on, and nothing on a clean page', () => {
    expect(problemTab({ ...clean, failedRecently: true })).toBe('traffic');
    expect(problemTab({ ...clean, duplicateListener: true })).toBe('listeners');
    expect(problemTab({ ...clean, updatePending: true })).toBe('sandbox');
    expect(problemTab(clean)).toBeNull();
  });

  it('opens on Identity the first time a page is opened', () => {
    const page = setup();
    expect(page.open()).toBe('identity');
    page.chip.dispose();
  });

  it('opens on Traffic when a request failed in the last minute', () => {
    const page = setup();
    page.runtime.reportError('write denied', 'sandbox');
    expect(page.open()).toBe('traffic');
    page.chip.dispose();
  });

  it('opens on Listeners when a listener is attached twice', () => {
    const page = setup({ withListeners: true });
    page.push([attach('a1', 'l1'), attach('a2', 'l2')]);
    expect(page.open()).toBe('listeners');
    page.chip.dispose();
  });

  it('opens on Sandbox when a worker update is pending', () => {
    const page = setup();
    page.runtime.setWorker({ mode: 'shared-worker', runningEpoch: 'aaaaaaaaaaaaaaaa' });
    expect(page.open()).toBe('sandbox');
    page.chip.dispose();
  });

  it('opens on the remembered view when nothing is pressing', () => {
    const page = setup({ rememberedTab: 'listeners' });
    expect(page.open()).toBe('listeners');
    page.chip.dispose();
  });

  it('opens on Identity when what was remembered is not a view', () => {
    const page = setup({ rememberedTab: 'nonsense' });
    expect(page.open()).toBe('identity');
    page.chip.dispose();
  });
});

describe('where the chosen view is remembered', () => {
  it('accepts only the four view names', () => {
    expect(isChipTab('identity')).toBe(true);
    expect(isChipTab('sandbox')).toBe(true);
    expect(isChipTab('status')).toBe(false);
    expect(isChipTab(null)).toBe(false);
  });

  it('reads and writes through a storage, and treats one that refuses as no memory', () => {
    const store = new Map<string, string>();
    const storage = {
      getItem: (key: string) => store.get(key) ?? null,
      setItem: (key: string, value: string) => {
        store.set(key, value);
      },
    };
    expect(readRememberedChipTab(storage)).toBeNull();
    writeRememberedChipTab(storage, 'traffic');
    expect(readRememberedChipTab(storage)).toBe('traffic');

    const refusing = {
      getItem: () => {
        throw new Error('blocked');
      },
      setItem: () => {
        throw new Error('blocked');
      },
    };
    expect(readRememberedChipTab(refusing)).toBeNull();
    expect(() => writeRememberedChipTab(refusing, 'traffic')).not.toThrow();
    expect(readRememberedChipTab(null)).toBeNull();
  });
});
