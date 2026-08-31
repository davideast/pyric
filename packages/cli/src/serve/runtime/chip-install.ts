import {
  mountPyricRuntimeChip,
  type PyricRuntimeChip,
  type PyricRuntimeChipOptions,
} from './chip.js';
import { readPyricRuntimeChipConfig } from './chip-config.js';
import type { PyricRuntimeStatus } from './status.js';

import type { AuthUserRecord } from 'pyric/auth';

export interface InstallPyricRuntimeChipOptions {
  runtime: PyricRuntimeStatus;
  document: Document;
  listUsers?: () => Promise<AuthUserRecord[]> | AuthUserRecord[];
  mount?: (options: PyricRuntimeChipOptions) => PyricRuntimeChip;
}

/** Mount once when the Vite plugin opted this page into runtime UI. */
export function installPyricRuntimeChip(
  options: InstallPyricRuntimeChipOptions,
): PyricRuntimeChip | null {
  const config = readPyricRuntimeChipConfig(options.document);
  if (!config || options.document.querySelector('[data-pyric-runtime-chip-host]')) return null;
  return (options.mount ?? mountPyricRuntimeChip)({
    runtime: options.runtime,
    document: options.document,
    initiallyOpen: config.initiallyOpen,
    listUsers: options.listUsers,
    ...(config.studioEnabled ? {} : { studioUrl: null }),
  });
}
