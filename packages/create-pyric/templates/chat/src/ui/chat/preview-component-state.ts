import type { Dispatch, SetStateAction } from 'react';

/** Store the generated preview export for React to render later. */
export function storePreviewComponent(
  setComponent: Dispatch<SetStateAction<unknown>>,
  component: unknown,
): void {
  // React treats a function passed directly to a state setter as an updater.
  // Preview exports are often function components, so wrap the value to keep
  // React from executing the generated component against the host's hook list.
  setComponent(() => component);
}
