/**
 * A tiny module store for "is the AI settings page open", so any surface (the
 * model selector's "Set key", an assist's "no API key" prompt) can open it
 * without threading props through the shell. Mirrors the `navigation.tsx`
 * module-store + `useSyncExternalStore` pattern.
 */

import { useSyncExternalStore } from 'react';

let open = false;
const listeners = new Set<() => void>();

function emit(): void {
  for (const l of listeners) l();
}

export function openSettings(): void {
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
