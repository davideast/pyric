import { JSDOM } from 'jsdom';
import { describe, expect, it, mock } from 'bun:test';
import { installPyricRuntimeChip } from '../../../src/serve/runtime/chip-install.js';
import { createPyricRuntimeStatus } from '../../../src/serve/runtime/status.js';
import type { PyricRuntimeChip } from '../../../src/serve/runtime/chip.js';

function setup(content?: string, studio = 'on') {
  const meta = content === undefined ? '' : `<meta name="pyric-runtime-chip" content="${content}" data-studio="${studio}">`;
  const dom = new JSDOM(`<!doctype html><head>${meta}</head><body></body>`, { url: 'http://localhost/' });
  const runtime = createPyricRuntimeStatus({
    studioUrl: '/__pyric/ui/studio',
    worker: { url: '/__pyric/sdk/worker.js', name: 'pyric-shared-worker', servedEpoch: null },
  });
  const mounted = { element: dom.window.document.createElement('div'), dispose() {} };
  const mount = mock((): PyricRuntimeChip => mounted);
  return { dom, runtime, mount, mounted };
}

describe('installPyricRuntimeChip', () => {
  it('mounts the configured chip once with its initial state', () => {
    const { dom, runtime, mount, mounted } = setup('expanded');
    const identity = {
      listUsers: () => [],
      switchUser: () => {},
      signOut: () => {},
      openCreateUser: () => {},
      getCurrentUser: () => null,
      subscribeAuth: () => () => {},
    };
    const installed = installPyricRuntimeChip({
      runtime,
      document: dom.window.document,
      identity,
      mount,
    });

    expect(installed).toBe(mounted);
    expect(mount).toHaveBeenCalledTimes(1);
    const mountedOptions = mount.mock.calls[0]?.[0] as unknown as Record<string, unknown>;
    expect(mountedOptions).toMatchObject({ runtime, initiallyOpen: true, identity });
    expect(mountedOptions).not.toHaveProperty('listUsers');
    expect(mountedOptions).not.toHaveProperty('switchUser');
  });

  it('does not mount when explicitly configured off via metadata', () => {
    const { dom, runtime, mount } = setup('off');
    expect(installPyricRuntimeChip({ runtime, document: dom.window.document, mount })).toBeNull();
    expect(mount).not.toHaveBeenCalled();
  });

  it('mounts by default when metadata is omitted (e.g. in Next.js app bundles)', () => {
    const { dom, runtime, mount, mounted } = setup(undefined);
    const installed = installPyricRuntimeChip({ runtime, document: dom.window.document, mount });
    expect(installed).toBe(mounted);
    expect(mount).toHaveBeenCalledTimes(1);
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
