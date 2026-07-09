/**
 * Pure layout policy for the Firestore miller-column stack: given how many
 * panels the drill path produces and the browser surface's width class,
 * decide WHICH panels render and how many placeholder slots pad the frame.
 *
 * Width classes come from `useContainerSize` on the fs-browser root — a
 * CONTAINER measure (the house rule: intrinsic, not viewport media queries),
 * so the same policy holds whether Studio is full-screen or embedded in a
 * split view. Breakpoints (see `PANEL_BREAKPOINTS`) are chosen from content,
 * not device sizes: a context column needs ~240px before its header row
 * ("collection name + ⋮ + New + Import JSON") stops wrapping/clipping, and
 * the detail column carries a 1.7x flex share — three readable panels
 * therefore need ≈ 240×3.7/1 ≈ 900px, two need ≈ 240×2.7 ≈ 650px.
 *
 *   wide   (≥ 920px): 3 slots — the existing Console-style 3-panel window.
 *   medium (≥ 640px): 2 slots — the deepest two levels side by side.
 *   narrow (< 640px): 1 slot  — ONLY the current level, full width; the
 *                      breadcrumb (always visible above) is the way back up.
 */

import type { ContainerSize } from '@pyric/ui/primitives';

export const PANEL_BREAKPOINTS = {
  /** Below this the surface is `narrow` (single panel). */
  narrowBreakpoint: 640,
  /** Below this (and ≥ narrow) the surface is `medium` (two panels);
   *  at/above it, `wide` (the unchanged three-panel layout). */
  mediumBreakpoint: 920,
} as const;

/** Panels-at-once per width class. */
export function slotsForSize(size: ContainerSize): number {
  switch (size) {
    case 'narrow':
      return 1;
    case 'medium':
      return 2;
    case 'wide':
      return 3;
  }
}

export interface PanelWindow {
  /** Index of the first REAL panel to render (into the ordered panel
   *  stack: root collections at 0, then one panel per path segment). */
  startIndex: number;
  /** How many real panels render (`stack.slice(startIndex)`). */
  visibleCount: number;
  /** Placeholder columns appended after the real panels so the frame
   *  keeps a stable slot count. Zero in narrow mode — a single panel
   *  should own the full width, not share it with a hint card. */
  emptySlots: number;
}

/**
 * The deepest `slots` panels win (Console behavior: drilling SHIFTS the
 * window). `totalPanels` is `path.length + 1` (the root collections panel
 * plus one per path segment) and is always ≥ 1.
 */
export function panelWindow(totalPanels: number, size: ContainerSize): PanelWindow {
  const slots = slotsForSize(size);
  const visibleCount = Math.min(Math.max(totalPanels, 1), slots);
  const startIndex = Math.max(totalPanels - visibleCount, 0);
  const emptySlots = size === 'narrow' ? 0 : slots - visibleCount;
  return { startIndex, visibleCount, emptySlots };
}
