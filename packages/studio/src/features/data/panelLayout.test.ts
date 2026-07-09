import { describe, expect, it } from 'bun:test';
import { panelWindow, slotsForSize, PANEL_BREAKPOINTS } from './panelLayout.js';

describe('slotsForSize', () => {
  it('maps the width classes to 1/2/3 panels', () => {
    expect(slotsForSize('narrow')).toBe(1);
    expect(slotsForSize('medium')).toBe(2);
    expect(slotsForSize('wide')).toBe(3);
  });
});

describe('panelWindow', () => {
  // totalPanels = path.length + 1 (root collections panel + one per segment).

  it('wide keeps the existing 3-slot behavior: all panels + hint padding at root', () => {
    // Root (collections only): 1 real panel + 2 placeholder slots.
    expect(panelWindow(1, 'wide')).toEqual({ startIndex: 0, visibleCount: 1, emptySlots: 2 });
    // collection selected: 2 real + 1 placeholder.
    expect(panelWindow(2, 'wide')).toEqual({ startIndex: 0, visibleCount: 2, emptySlots: 1 });
    // document selected: full window, no padding.
    expect(panelWindow(3, 'wide')).toEqual({ startIndex: 0, visibleCount: 3, emptySlots: 0 });
  });

  it('wide shifts the window as the drill goes deeper than 3 levels', () => {
    // subcollection under a document: show the deepest 3 of 4.
    expect(panelWindow(4, 'wide')).toEqual({ startIndex: 1, visibleCount: 3, emptySlots: 0 });
    expect(panelWindow(6, 'wide')).toEqual({ startIndex: 3, visibleCount: 3, emptySlots: 0 });
  });

  it('narrow renders ONLY the current level, full width (no padding slots)', () => {
    expect(panelWindow(1, 'narrow')).toEqual({ startIndex: 0, visibleCount: 1, emptySlots: 0 });
    expect(panelWindow(2, 'narrow')).toEqual({ startIndex: 1, visibleCount: 1, emptySlots: 0 });
    expect(panelWindow(3, 'narrow')).toEqual({ startIndex: 2, visibleCount: 1, emptySlots: 0 });
    expect(panelWindow(5, 'narrow')).toEqual({ startIndex: 4, visibleCount: 1, emptySlots: 0 });
  });

  it('medium renders the deepest two levels, hint-padded only at root', () => {
    expect(panelWindow(1, 'medium')).toEqual({ startIndex: 0, visibleCount: 1, emptySlots: 1 });
    expect(panelWindow(2, 'medium')).toEqual({ startIndex: 0, visibleCount: 2, emptySlots: 0 });
    expect(panelWindow(3, 'medium')).toEqual({ startIndex: 1, visibleCount: 2, emptySlots: 0 });
    expect(panelWindow(4, 'medium')).toEqual({ startIndex: 2, visibleCount: 2, emptySlots: 0 });
  });

  it('tolerates a zero-panel input (defensive: never renders an empty frame)', () => {
    expect(panelWindow(0, 'narrow')).toEqual({ startIndex: 0, visibleCount: 1, emptySlots: 0 });
  });

  it('breakpoints are content-derived, ordered, and container-scoped', () => {
    // Guard the invariant, not the specific numbers: narrow < medium, and
    // both leave a context column at least ~240px (see panelLayout.ts).
    expect(PANEL_BREAKPOINTS.narrowBreakpoint).toBeLessThan(PANEL_BREAKPOINTS.mediumBreakpoint);
    expect(PANEL_BREAKPOINTS.narrowBreakpoint).toBeGreaterThanOrEqual(480);
  });
});
