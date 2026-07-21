import { JSDOM } from 'jsdom';
import { describe, expect, it, mock } from 'bun:test';
import { mountPyricRuntimeChip } from '../../../src/serve/runtime/chip.js';
import { createPyricRuntimeStatus } from '../../../src/serve/runtime/status.js';
import type { PyricRuntimeManifest } from '../../../src/serve/runtime/manifest.js';

const manifest: PyricRuntimeManifest = {
  studioUrl: '/__pyric/ui/',
  worker: { url: '/__pyric/sdk/worker.js', name: 'pyric-shared-worker', servedEpoch: 'bbbbbbbbbbbbbbbb' },
};

function setup(options: {
  initiallyOpen?: boolean;
  clipboard?: Pick<Clipboard, 'writeText'> | null;
  studioUrl?: string | null;
} = {}) {
  const dom = new JSDOM('<!doctype html><body></body>', { url: 'http://localhost/' });
  const runtime = createPyricRuntimeStatus(manifest);
  const writeText = mock(() => Promise.resolve());
  const clipboard = options.clipboard === null
    ? undefined
    : options.clipboard ?? { writeText };
  const chip = mountPyricRuntimeChip({
    runtime,
    document: dom.window.document,
    ...(clipboard ? { clipboard } : {}),
    ...(options.initiallyOpen === undefined ? {} : { initiallyOpen: options.initiallyOpen }),
    ...('studioUrl' in options ? { studioUrl: options.studioUrl } : {}),
  });
  const root = chip.element.shadowRoot!;
  return { dom, runtime, chip, root, writeText };
}

describe('PyricRuntimeChip', () => {
  it('is collapsed by default and surfaces errors and worker updates compactly', () => {
    const { runtime, root } = setup();
    expect(root.querySelector('[data-expand]')).not.toBeNull();
    expect(root.textContent).toContain('ready');

    runtime.reportError('write denied', 'sandbox');
    runtime.setWorker({ mode: 'shared-worker', runningEpoch: 'aaaaaaaaaaaaaaaa' });

    expect(root.textContent).toContain('update');
    expect(root.textContent).toContain('1 error');
  });

  it('keeps worker and Studio controls stable while update availability changes', () => {
    const { runtime, root } = setup({ initiallyOpen: true });
    const initialUpdate = root.querySelector<HTMLButtonElement>('[data-update-worker]')!;
    expect(initialUpdate.disabled).toBe(true);
    expect(root.querySelector('[data-open-studio]')?.getAttribute('href')).toBe('/__pyric/ui/');
    expect(root.querySelector('[data-open-studio]')?.getAttribute('target')).toBe('_blank');

    runtime.setWorker({ mode: 'shared-worker', runningEpoch: 'aaaaaaaaaaaaaaaa' });
    expect(root.querySelector<HTMLButtonElement>('[data-update-worker]')!.disabled).toBe(false);
  });

  it('keeps a disabled Studio action in place when Studio is unavailable', () => {
    const { root } = setup({ initiallyOpen: true, studioUrl: null });
    const studio = root.querySelector('[data-open-studio]');
    expect(studio?.tagName).toBe('SPAN');
    expect(studio?.getAttribute('aria-disabled')).toBe('true');
  });

  it('moves focus with the compact and expanded controls', () => {
    const { root } = setup();
    root.querySelector<HTMLButtonElement>('[data-expand]')!.click();
    expect(root.activeElement?.hasAttribute('data-collapse')).toBe(true);

    root.querySelector<HTMLButtonElement>('[data-collapse]')!.click();
    expect(root.activeElement?.hasAttribute('data-expand')).toBe(true);
  });

  it('preserves the focused control across runtime publications', () => {
    const { runtime, root } = setup({ initiallyOpen: true });
    runtime.setWorker({ mode: 'shared-worker', runningEpoch: 'aaaaaaaaaaaaaaaa' });
    const announcer = root.querySelector('.announcer');
    const update = root.querySelector<HTMLButtonElement>('[data-update-worker]')!;
    update.focus();

    runtime.reportError('a new sandbox error', 'sandbox');

    expect(root.activeElement?.hasAttribute('data-update-worker')).toBe(true);
    expect(root.querySelector('.announcer')).toBe(announcer);
    expect(announcer?.textContent).toContain('1 runtime error');
  });

  it('preserves the error viewport position across runtime publications', () => {
    const { runtime, root } = setup({ initiallyOpen: true });
    runtime.reportError('first', 'sandbox');
    const viewport = root.querySelector<HTMLElement>('[data-error-viewport]')!;
    Object.defineProperties(viewport, {
      scrollHeight: { value: 300 },
      clientHeight: { value: 100 },
    });
    viewport.scrollTop = 40;

    runtime.reportError('second', 'sandbox');

    expect(root.querySelector<HTMLElement>('[data-error-viewport]')!.scrollTop).toBe(40);
  });

  it('renders a scrollable error viewport and copies the selected error', async () => {
    const { runtime, root, writeText } = setup({ initiallyOpen: true });
    runtime.reportError(Object.assign(new Error('listener failed'), { code: 'permission-denied' }), 'sandbox');

    expect(root.querySelector('[data-error-viewport]')).not.toBeNull();
    expect(root.querySelector('.error-body')?.textContent).toContain('listener failed');
    root.querySelector<HTMLButtonElement>('[data-copy-error]')!.click();
    await Promise.resolve();

    expect(writeText).toHaveBeenCalledTimes(1);
    expect(writeText.mock.calls[0]?.[0]).toContain('listener failed');
    expect(writeText.mock.calls[0]?.[0]).toContain('permission-denied');
  });

  it('disables copy when the Clipboard API is unavailable', () => {
    const { runtime, root } = setup({ initiallyOpen: true, clipboard: null });
    runtime.reportError('listener failed', 'sandbox');

    const copy = root.querySelector<HTMLButtonElement>('[data-copy-error]')!;
    expect(copy.disabled).toBe(true);
    expect(copy.getAttribute('aria-label')).toBe('Copy unavailable');
  });

  it('handles a rejected clipboard write and exposes failure on the control', async () => {
    const writeText = mock(() => Promise.reject(new Error('permission denied')));
    const { runtime, root } = setup({ initiallyOpen: true, clipboard: { writeText } });
    runtime.reportError('listener failed', 'sandbox');
    const copy = root.querySelector<HTMLButtonElement>('[data-copy-error]')!;
    copy.click();
    await Promise.resolve();
    await Promise.resolve();

    expect(copy.hasAttribute('data-copy-failed')).toBe(true);
    expect(copy.getAttribute('aria-label')).toBe('Copy failed');
  });

  it('invokes the runtime updater and disposes its host', async () => {
    const { runtime, root, chip, dom } = setup({ initiallyOpen: true });
    const update = mock(() => Promise.resolve());
    runtime.setWorkerUpdater(update);
    runtime.setWorker({ mode: 'shared-worker', runningEpoch: 'aaaaaaaaaaaaaaaa' });
    const button = root.querySelector<HTMLButtonElement>('[data-update-worker]')!;
    button.focus();
    button.click();
    await Promise.resolve();

    expect(update).toHaveBeenCalledTimes(1);
    expect(root.activeElement?.hasAttribute('data-update-worker')).toBe(true);
    expect(root.querySelector('[data-update-worker]')?.getAttribute('aria-disabled')).toBe('true');
    chip.dispose();
    expect(dom.window.document.querySelector('[data-pyric-runtime-chip-host]')).toBeNull();
  });
});
