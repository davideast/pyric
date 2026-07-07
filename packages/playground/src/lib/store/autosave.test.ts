/**
 * Autosave status derivation — the pure label/tone logic behind the
 * TopBar indicator, plus the store's report() transitions (the seam
 * `useSessionRouting` writes into around the real save promise).
 */
import { describe, test, expect, beforeEach } from 'bun:test';
import {
  AUTOSAVE_TRUTH_COPY,
  describeAutosave,
  reportAutosave,
  useAutosaveStore,
} from './autosave';

const NOW = 1_750_000_000_000;

describe('describeAutosave', () => {
  test('idle → "Autosave on" (armed, nothing saved this visit)', () => {
    expect(describeAutosave({ status: 'idle' }, NOW)).toEqual({
      label: 'Autosave on',
      tone: 'muted',
    });
  });

  test('saving → "Saving…"', () => {
    expect(describeAutosave({ status: 'saving' }, NOW)).toEqual({
      label: 'Saving…',
      tone: 'busy',
    });
  });

  test('saved <10s ago → "just now"', () => {
    expect(describeAutosave({ status: 'saved', at: NOW - 3_000 }, NOW)).toEqual({
      label: 'Saved · just now',
      tone: 'ok',
    });
  });

  test('saved bucket boundaries: seconds → minutes → hours', () => {
    const at = (msAgo: number) =>
      describeAutosave({ status: 'saved', at: NOW - msAgo }, NOW).label;
    expect(at(10_000)).toBe('Saved · 10s ago');
    expect(at(59_999)).toBe('Saved · 59s ago');
    expect(at(60_000)).toBe('Saved · 1m ago');
    expect(at(3_599_999)).toBe('Saved · 59m ago');
    expect(at(3_600_000)).toBe('Saved · 1h ago');
    expect(at(7_200_000)).toBe('Saved · 2h ago');
  });

  test('clock skew (saved timestamp in the future) clamps to "just now"', () => {
    expect(describeAutosave({ status: 'saved', at: NOW + 60_000 }, NOW).label).toBe(
      'Saved · just now',
    );
  });

  test('error → "Save failed" with error tone', () => {
    expect(describeAutosave({ status: 'error', message: 'boom' }, NOW)).toEqual({
      label: 'Save failed',
      tone: 'error',
    });
  });
});

describe('autosave store', () => {
  beforeEach(() => {
    useAutosaveStore.setState({ state: { status: 'idle' } });
  });

  test('starts idle', () => {
    expect(useAutosaveStore.getState().state).toEqual({ status: 'idle' });
  });

  test('report() walks the real lifecycle: saving → saved → saving → error', () => {
    reportAutosave({ status: 'saving' });
    expect(useAutosaveStore.getState().state.status).toBe('saving');
    reportAutosave({ status: 'saved', at: NOW });
    expect(useAutosaveStore.getState().state).toEqual({ status: 'saved', at: NOW });
    reportAutosave({ status: 'saving' });
    reportAutosave({ status: 'error', message: 'quota exceeded' });
    expect(useAutosaveStore.getState().state).toEqual({
      status: 'error',
      message: 'quota exceeded',
    });
  });
});

describe('truth copy', () => {
  // The exported constant is the single source of the persistence
  // claim. Pin the load-bearing facts so a copy edit that changes the
  // CLAIM (not just the wording) fails loudly — and so the parallel
  // sandbox-persistence track knows exactly which assertion to update
  // alongside the one-line copy change.
  test('claims session-local autosave, instant shared files, no sandbox data', () => {
    expect(AUTOSAVE_TRUTH_COPY).toContain('autosaves');
    expect(AUTOSAVE_TRUTH_COPY).toContain('rules');
    expect(AUTOSAVE_TRUTH_COPY).toContain('chat');
    expect(AUTOSAVE_TRUTH_COPY).toContain('sandbox data is not yet saved');
  });
});
