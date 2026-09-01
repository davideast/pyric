import {
  mountPyricRuntimeChip,
  type PyricRuntimeChip,
  type PyricRuntimeChipOptions,
} from './chip.js';
import { readPyricRuntimeChipConfig } from './chip-config.js';
import type { PyricRuntimeStatus } from './status.js';
import type { RuntimeIdentityBindings } from './identity.js';

export interface InstallPyricRuntimeChipOptions {
  runtime: PyricRuntimeStatus;
  document: Document;
  identity?: Partial<RuntimeIdentityBindings>;
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
  const mount = options.mount ?? mountPyricRuntimeChip;
  return mount(chipOptions);
}
