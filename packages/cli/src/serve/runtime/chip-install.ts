import {
  mountPyricRuntimeChip,
  type PyricRuntimeChip,
  type PyricRuntimeChipOptions,
} from './chip.js';
import { readPyricRuntimeChipConfig } from './chip-config.js';
import type { PyricRuntimeStatus } from './status.js';
import type { RuntimeIdentityBindings } from './identity.js';
import { listenerAttributionEnabled } from 'pyric/sandbox/internal';
import { createListenerMode } from './listener-mode.js';
import type { SandboxEventSource } from './listener-event-source.js';

export interface InstallPyricRuntimeChipOptions {
  runtime: PyricRuntimeStatus;
  document: Document;
  identity?: Partial<RuntimeIdentityBindings>;
  /** The page's sandbox event source. Omitted leaves the Listeners mode out. */
  listenerEvents?: SandboxEventSource | null;
  mount?: (options: PyricRuntimeChipOptions) => PyricRuntimeChip;
}

/** Mount once when the Vite plugin opted this page into runtime UI. */
export function installPyricRuntimeChip(
  options: InstallPyricRuntimeChipOptions,
): PyricRuntimeChip | null {
  const config = readPyricRuntimeChipConfig(options.document);
  const existing = options.document.querySelector('[data-pyric-runtime-chip-host], pyric-runtime-chip');
  if (!config || existing) return null;
  const chipOptions: PyricRuntimeChipOptions = {
    runtime: options.runtime,
    document: options.document,
    initiallyOpen: config.initiallyOpen,
    identity: options.identity,
  };
  if (!config.studioEnabled) chipOptions.studioUrl = null;
  const events = options.listenerEvents;
  if (events !== null && events !== undefined) {
    const studioUrl = config.studioEnabled
      ? options.runtime.getSnapshot().manifest.studioUrl
      : null;
    chipOptions.listeners = (onChange) => createListenerMode({
      document: options.document,
      subscribeEvents: events,
      attributionEnabled: listenerAttributionEnabled,
      studioUrl,
      onChange,
    });
  }
  const mount = options.mount ?? mountPyricRuntimeChip;
  return mount(chipOptions);
}
