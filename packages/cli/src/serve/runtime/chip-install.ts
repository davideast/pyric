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
  switchUser?: (uid: string) => Promise<void> | void;
  signOut?: () => Promise<void> | void;
  openCreateUser?: () => void;
  getCurrentUser?: () => { uid: string; email?: string | null; displayName?: string | null } | null;
  subscribeAuth?: (listener: (user: { uid: string; email?: string | null; displayName?: string | null } | null) => void) => () => void;
  mount?: (options: PyricRuntimeChipOptions) => PyricRuntimeChip;
}

/** Mount once when the Vite plugin opted this page into runtime UI. */
export function installPyricRuntimeChip(
  options: InstallPyricRuntimeChipOptions,
): PyricRuntimeChip | null {
  const config = readPyricRuntimeChipConfig(options.document);
  const existing = options.document.querySelector('[data-pyric-runtime-chip-host], pyric-runtime-chip');
  if (!config || existing) return null;
  return (options.mount ?? mountPyricRuntimeChip)({
    runtime: options.runtime,
    document: options.document,
    initiallyOpen: config.initiallyOpen,
    listUsers: options.listUsers,
    switchUser: options.switchUser,
    signOut: options.signOut,
    openCreateUser: options.openCreateUser,
    getCurrentUser: options.getCurrentUser,
    subscribeAuth: options.subscribeAuth,
    ...(config.studioEnabled ? {} : { studioUrl: null }),
  });
}
