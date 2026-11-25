import { afterEach, describe, expect, it } from 'bun:test';
import { JSDOM } from 'jsdom';
import type { LiveHostStatus } from 'pyric/sandbox/internal';
import { mountPyricRuntimeChip } from '../../../src/serve/runtime/chip.js';
import {
  chipTitleFor,
  chipToneFor,
  openingChipTab,
  problemTab,
  type ChipTabSignals,
} from '../../../src/serve/runtime/chip-tab.js';
import {
  extractUnlockUrl,
  sanitizeUnlockUrl,
  unlockSessionHeaderLinkHtml,
  unlockSessionRowHtml,
  unlockSessionSectionHtml,
} from '../../../src/serve/runtime/chip-unlock.js';
import type { PyricRuntimeManifest } from '../../../src/serve/runtime/manifest.js';
import { createPyricRuntimeStatus } from '../../../src/serve/runtime/status.js';

const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
});

const manifest: PyricRuntimeManifest = {
  studioUrl: '/__pyric/ui/studio',
  worker: { url: '/__pyric/sdk/worker.js', name: 'pyric-shared-worker', servedEpoch: 'bbbbbbbbbbbbbbbb' },
};

const cleanSignals: ChipTabSignals = {
  failedRecently: false,
  duplicateListener: false,
  updatePending: false,
};

function setupChip(options: {
  initiallyOpen?: boolean;
  liveStatus?: () => Promise<LiveHostStatus | null>;
} = {}) {
  const dom = new JSDOM('<!doctype html><body></body>', { url: 'https://dev.example.test/app' });
  const runtime = createPyricRuntimeStatus(manifest);
  const chip = mountPyricRuntimeChip({
    runtime,
    document: dom.window.document,
    initiallyOpen: options.initiallyOpen,
    indexConfig: null,
    thresholdConfig: null,
    sandboxEvents: null,
    liveStatus: options.liveStatus ?? (async () => null),
    getLens: () => undefined,
    setLens: () => {},
    subscribeLens: () => () => {},
    identity: {
      listUsers: async () => [],
      getCurrentUser: () => null,
      subscribeAuth: () => () => {},
      switchUser: () => {},
      signOut: () => {},
    },
  });
  cleanups.push(() => {
    chip.dispose();
    dom.window.close();
  });
  const root = chip.element.shadowRoot;
  if (root === null) {
    throw new Error('Expected runtime chip shadowRoot');
  }
  const showTab = (tab: 'identity' | 'listeners' | 'traffic' | 'sandbox'): void => {
    const button = root.querySelector<HTMLButtonElement>(`[data-chip-tab="${tab}"]`);
    if (button === null) {
      throw new Error(`Expected tab button for ${tab}`);
    }
    button.click();
  };
  return { runtime, root, showTab };
}

describe('chip unlock URL sanitization and extraction', () => {
  it('accepts relative /__pyric/unlock paths with safe next query', () => {
    expect(sanitizeUnlockUrl('/__pyric/unlock')).toBe('/__pyric/unlock');
    expect(sanitizeUnlockUrl('/__pyric/unlock?next=%2F')).toBe('/__pyric/unlock?next=%2F');
    expect(sanitizeUnlockUrl('/__pyric/unlock?next=%2Froom%3Fid%3D7')).toBe('/__pyric/unlock?next=%2Froom%3Fid%3D7');
  });

  it('rejects cross-origin, fragment, scheme, path-spoofed, and control-char URLs', () => {
    const unsafeValues: unknown[] = [
      '',
      'javascript:alert(1)',
      'https://evil.example/__pyric/unlock',
      '//evil.example/__pyric/unlock',
      '/__pyric/unlock.evil',
      '/__pyric/unlock/extra',
      '/__pyric/unlock#code=secret',
      '/__pyric/unlock?next=//evil.example/phish',
      '/__pyric/unlock?next=https://evil.example',
      '/__pyric/unlock?next=%2F\nSet-Cookie:x=1',
      '/__pyric/unlock?next=/foo bar',
      null,
      undefined,
      42,
    ];
    for (const candidate of unsafeValues) {
      expect(sanitizeUnlockUrl(candidate)).toBeNull();
    }
    expect(unlockSessionHeaderLinkHtml('https://evil.example/__pyric/unlock')).toBe('');
    expect(unlockSessionRowHtml('javascript:alert(1)')).toBe('');
    expect(unlockSessionSectionHtml('/__pyric/unlock.evil')).toBe('');
  });

  it('extracts unlockUrl directly and through nested cause chains without cycling', () => {
    const rootCause = Object.assign(new Error('unlock required'), {
      unlockUrl: '/__pyric/unlock?next=%2Fdashboard',
    });
    const wrapped = new Error('Hosted sandbox initialization failed', { cause: rootCause });
    expect(extractUnlockUrl(rootCause)).toBe('/__pyric/unlock?next=%2Fdashboard');
    expect(extractUnlockUrl(wrapped)).toBe('/__pyric/unlock?next=%2Fdashboard');

    const cyclic: { cause?: unknown } = {};
    cyclic.cause = cyclic;
    expect(extractUnlockUrl(cyclic)).toBeNull();

    const unsafeCause = Object.assign(new Error('bad'), {
      unlockUrl: 'https://evil.example/__pyric/unlock',
    });
    expect(extractUnlockUrl(unsafeCause)).toBeNull();
  });
});

describe('runtime status and chip tab unlock signals', () => {
  it('stores validated unlockUrl idempotently and ignores invalid values', () => {
    const runtime = createPyricRuntimeStatus(manifest);
    const updates: Array<string | null | undefined> = [];
    const unsubscribe = runtime.subscribe((snapshot) => {
      updates.push(snapshot.unlockUrl);
    });
    cleanups.push(unsubscribe);

    runtime.reportUnlockRequired('https://evil.example/__pyric/unlock');
    expect(runtime.getSnapshot().unlockUrl).toBeUndefined();

    runtime.reportUnlockRequired('/__pyric/unlock?next=%2F');
    runtime.reportUnlockRequired('/__pyric/unlock?next=%2F');
    expect(runtime.getSnapshot().unlockUrl).toBe('/__pyric/unlock?next=%2F');
    expect(updates).toEqual([undefined, '/__pyric/unlock?next=%2F']);
  });

  it('surfaces unlockRequired in pill tone, title, and tab selection', () => {
    expect(chipToneFor({ ...cleanSignals, unlockRequired: true })).toBe(' error');
    expect(chipTitleFor({ ...cleanSignals, unlockRequired: true, failedRecently: true })).toContain(
      'Session unlock required',
    );
    expect(openingChipTab({ ...cleanSignals, unlockRequired: true }, 'identity')).toBe('sandbox');
    expect(problemTab({ ...cleanSignals, unlockRequired: true })).toBe('sandbox');
    expect(openingChipTab({ ...cleanSignals, unlockRequired: true, failedRecently: true }, 'identity')).toBe('traffic');
  });
});

describe('runtime chip unlock action UI', () => {
  it('turns the collapsed chip red with an unlock tooltip and opens with clickable links', () => {
    const page = setupChip();
    page.runtime.setWorker({ mode: 'hosted' });
    page.runtime.reportUnlockRequired('/__pyric/unlock?next=%2Fapp');
    page.runtime.reportError(new Error('Pyric session unlock required (401).'), 'runtime');

    const expand = page.root.querySelector<HTMLButtonElement>('[data-expand]');
    expect(expand).not.toBeNull();
    if (expand === null) return;
    expect(expand.classList.contains('error')).toBe(true);
    expect(expand.getAttribute('title')).toContain('Session unlock required');

    expand.click();

    const headerLink = page.root.querySelector<HTMLAnchorElement>('[data-unlock-session="header"]');
    expect(headerLink).not.toBeNull();
    expect(headerLink?.getAttribute('href')).toBe('/__pyric/unlock?next=%2Fapp');
    expect(headerLink?.getAttribute('target')).toBeNull();
    expect(headerLink?.textContent).toContain('Unlock');

    const trafficRow = page.root.querySelector('[data-chip-view="traffic"] [data-unlock-required-row]');
    expect(trafficRow).not.toBeNull();
    const trafficLink = trafficRow?.querySelector<HTMLAnchorElement>('[data-unlock-session="row"]');
    expect(trafficLink?.getAttribute('href')).toBe('/__pyric/unlock?next=%2Fapp');

    page.showTab('sandbox');
    const sandboxRow = page.root.querySelector('[data-chip-view="sandbox"] [data-unlock-required-row]');
    expect(sandboxRow).not.toBeNull();
    const sandboxLink = sandboxRow?.querySelector<HTMLAnchorElement>('[data-unlock-session="row"]');
    expect(sandboxLink?.getAttribute('href')).toBe('/__pyric/unlock?next=%2Fapp');

    const announcer = page.root.querySelector('.announcer');
    expect(announcer?.textContent).toContain('Session unlock required.');
  });

  it('shows the unlock section on the Live view when pairing is required', async () => {
    const liveStatus: LiveHostStatus = {
      projectId: 'demo-live',
      configProjectId: 'demo-live',
      configSource: '.firebaserc',
      appProjectIds: ['demo-live'],
      billed: { reads: 0, writes: 0, deliveries: 0 },
    };
    const page = setupChip({ initiallyOpen: true, liveStatus: async () => liveStatus });
    page.runtime.setWorker({ mode: 'hosted' });
    page.runtime.reportUnlockRequired('/__pyric/unlock?next=%2F');
    for (let i = 0; i < 5; i += 1) await Promise.resolve();

    page.showTab('sandbox');
    const liveUnlock = page.root.querySelector<HTMLAnchorElement>(
      '[data-live-view] [data-live-section="unlock"] [data-unlock-session="row"]',
    );
    expect(liveUnlock).not.toBeNull();
    expect(liveUnlock?.getAttribute('href')).toBe('/__pyric/unlock?next=%2F');
  });

  it('does not render unlock controls when no unlockUrl has been reported', () => {
    const page = setupChip({ initiallyOpen: true });
    page.runtime.setWorker({ mode: 'hosted' });
    expect(page.root.querySelector('[data-unlock-session]')).toBeNull();
    expect(page.root.querySelector('[data-unlock-required-row]')).toBeNull();
  });
});
