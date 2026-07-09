/**
 * Pure helpers for the settings modal's disclosure affordance — any
 * parent setting with a child group (e.g. "Enable pyric diagnostics"
 * → its per-tool checkboxes) gets a caret that reveals/hides the
 * children. Kept separate from `SettingsModal.tsx` so the state
 * machine and the collapsed-row summary text are unit-testable
 * without rendering React.
 *
 * Expansion state is UI-only and keyed by an arbitrary section id
 * (e.g. `'diagnostics'`) so one `DisclosureState` map can back every
 * collapsible section in the modal. Default is collapsed — an id
 * absent from the map reads as collapsed, matching the modal's
 * "dense by default, open what you want to inspect" convention (see
 * `Fold.tsx`).
 */

/** `{ [sectionId]: expanded }`. Absent key = collapsed. */
export type DisclosureState = Record<string, boolean>;

/** Absent key defaults to collapsed. */
export function isDisclosureExpanded(state: DisclosureState, id: string): boolean {
  return state[id] === true;
}

/** Returns a new state with `id` flipped; does not mutate `state`. */
export function toggleDisclosure(state: DisclosureState, id: string): DisclosureState {
  return { ...state, [id]: !isDisclosureExpanded(state, id) };
}

/**
 * Count how many items satisfy `isEnabled`. Generic over the item
 * shape so it works for the diagnostic-tool manifest today and any
 * future parent-with-children setting without a new counting
 * function.
 */
export function countEnabled<T>(
  items: readonly T[],
  isEnabled: (item: T) => boolean,
): number {
  let count = 0;
  for (const item of items) {
    if (isEnabled(item)) count += 1;
  }
  return count;
}

/**
 * Collapsed-row summary text, derived rather than hardcoded — e.g.
 * `summarizeOnCount(6, 5, 'tools')` → "5 of 6 tools on".
 */
export function summarizeOnCount(total: number, onCount: number, noun: string): string {
  return `${onCount} of ${total} ${noun} on`;
}
