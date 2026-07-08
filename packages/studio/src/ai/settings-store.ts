/**
 * Compatibility navigation hook for AI settings. Settings is a first-class tab
 * in Studio V1; callers that previously opened the modal now route there.
 */

import { useSyncExternalStore } from 'react';
import { pushPath } from '../shell/router.js';

let open = false;
const listeners = new Set<() => void>();

function emit(): void {
  for (const l of listeners) l();
}

export function openSettings(): void {
  pushPath({ tab: 'settings' });
  if (open) return;
  open = true;
  emit();
}

export function closeSettings(): void {
  if (!open) return;
  open = false;
  emit();
}

export function useSettingsOpen(): boolean {
  return useSyncExternalStore(
    (cb) => {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    () => open,
    () => open,
  );
}
