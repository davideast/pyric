import { JSDOM } from 'jsdom';
import { describe, expect, it, mock } from 'bun:test';
import { installPyricRuntimeChip } from '../../../src/serve/runtime/chip-install.js';
import { createPyricRuntimeStatus } from '../../../src/serve/runtime/status.js';
import type { PyricRuntimeChip } from '../../../src/serve/runtime/chip.js';

function setup(content?: string, studio = 'on') {
  const meta = content === undefined ? '' : `<meta name="pyric-runtime-chip" content="${content}" data-studio="${studio}">`;
  const dom = new JSDOM(`<!doctype html><head>${meta}</head><body></body>`, { url: 'http://localhost/' });
  const runtime = createPyricRuntimeStatus({
    studioUrl: '/__pyric/ui/',
    worker: { url: '/__pyric/sdk/worker.js', name: 'pyric-shared-worker', servedEpoch: null },
  });
  const mounted = { element: dom.window.document.createElement('div'), dispose() {} };
  const mount = mock((): PyricRuntimeChip => mounted);
  return { dom, runtime, mount, mounted };
}

describe('installPyricRuntimeChip', () => {
  it('mounts the configured chip once with its initial state', () => {
    const { dom, runtime, mount, mounted } = setup('expanded');
    const installed = installPyricRuntimeChip({ runtime, document: dom.window.document, mount });

    expect(installed).toBe(mounted);
    expect(mount).toHaveBeenCalledTimes(1);
    expect(mount.mock.calls[0]?.[0]).toMatchObject({ runtime, initiallyOpen: true });
  });

  it('does not mount without opt-in metadata or when explicitly off', () => {
    for (const content of [undefined, 'off']) {
      const { dom, runtime, mount } = setup(content);
      expect(installPyricRuntimeChip({ runtime, document: dom.window.document, mount })).toBeNull();
      expect(mount).not.toHaveBeenCalled();
    }
  });

  it('does not duplicate an existing runtime chip host', () => {
    const { dom, runtime, mount } = setup('collapsed');
    const existing = dom.window.document.createElement('div');
    existing.setAttribute('data-pyric-runtime-chip-host', '');
    dom.window.document.body.append(existing);

    expect(installPyricRuntimeChip({ runtime, document: dom.window.document, mount })).toBeNull();
    expect(mount).not.toHaveBeenCalled();
  });

  it('keeps the Studio action present but disabled when Vite UI is off', () => {
    const { dom, runtime, mount } = setup('collapsed', 'off');
    installPyricRuntimeChip({ runtime, document: dom.window.document, mount });

    expect(mount.mock.calls[0]?.[0]).toMatchObject({ studioUrl: null });
  });
});
