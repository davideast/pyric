/**
 * OpenRouter provider-routing settings — defaults + write-time
 * clamping. The store runs windowless here (bun test has no DOM), so
 * initial state IS the defaults path; setter clamping covers the same
 * helpers the read-time path uses on persisted values.
 */
import { describe, test, expect, afterEach } from 'bun:test';
import {
  defaultMaxTurnsForLane,
  resolveMaxTurns,
  MAX_TURNS_DEFAULT,
  MAX_TURNS_DEFAULT_HOSTED,
  MAX_TURNS_MAX,
  MAX_TURNS_MIN,
  OPENROUTER_PRICE_MAX,
  OPENROUTER_SORT_DEFAULT,
  useSettingsStore,
} from './settings';

afterEach(() => {
  // The store is a module singleton shared with other test files —
  // restore the routing knobs to their defaults.
  const s = useSettingsStore.getState();
  s.setOpenrouterSort(OPENROUTER_SORT_DEFAULT);
  s.setOpenrouterMaxPromptPrice(undefined);
  s.setOpenrouterMaxCompletionPrice(undefined);
});

describe('settings — OpenRouter routing defaults', () => {
  test('sort defaults to throughput (preserves the 2026-06-11 routing fix); caps unset', () => {
    expect(OPENROUTER_SORT_DEFAULT).toBe('throughput');
    const s = useSettingsStore.getState();
    expect(s.openrouterSort).toBe('throughput');
    expect(s.openrouterMaxPromptPrice).toBeUndefined();
    expect(s.openrouterMaxCompletionPrice).toBeUndefined();
  });
});

describe('settings — OpenRouter routing clamping', () => {
  test('all four sort modes are accepted; junk falls back to the default', () => {
    const s = useSettingsStore.getState();
    for (const mode of ['price', 'latency', 'default', 'throughput'] as const) {
      s.setOpenrouterSort(mode);
      expect(useSettingsStore.getState().openrouterSort).toBe(mode);
    }
    s.setOpenrouterSort('cheapest' as never);
    expect(useSettingsStore.getState().openrouterSort).toBe(OPENROUTER_SORT_DEFAULT);
  });

  test('price caps: in-range values stick (fractional $/M allowed)', () => {
    const s = useSettingsStore.getState();
    s.setOpenrouterMaxPromptPrice(2.5);
    s.setOpenrouterMaxCompletionPrice(15);
    expect(useSettingsStore.getState().openrouterMaxPromptPrice).toBe(2.5);
    expect(useSettingsStore.getState().openrouterMaxCompletionPrice).toBe(15);
  });

  test('price caps: non-positive / non-finite collapse to unset (no ceiling)', () => {
    const s = useSettingsStore.getState();
    for (const bad of [0, -3, Number.NaN, Number.POSITIVE_INFINITY, undefined]) {
      s.setOpenrouterMaxPromptPrice(bad as number | undefined);
      expect(useSettingsStore.getState().openrouterMaxPromptPrice).toBeUndefined();
    }
  });

  test('price caps: values above the generous max clamp down to it', () => {
    const s = useSettingsStore.getState();
    s.setOpenrouterMaxCompletionPrice(999999);
    expect(useSettingsStore.getState().openrouterMaxCompletionPrice).toBe(OPENROUTER_PRICE_MAX);
  });
});

describe('settings — lane-aware maxTurns default (LIVE economics)', () => {
  afterEach(() => {
    // Restore "no explicit choice" for the other test files sharing
    // the singleton store.
    useSettingsStore.getState().setMaxTurns(undefined);
  });

  test('hosted reasoning lanes default to 16; local/stub lanes keep 32', () => {
    expect(MAX_TURNS_DEFAULT_HOSTED).toBe(16);
    expect(MAX_TURNS_DEFAULT).toBe(32);
    expect(defaultMaxTurnsForLane('openrouter')).toBe(MAX_TURNS_DEFAULT_HOSTED);
    expect(defaultMaxTurnsForLane('gemini')).toBe(MAX_TURNS_DEFAULT);
    expect(defaultMaxTurnsForLane('ollama')).toBe(MAX_TURNS_DEFAULT);
  });

  test('resolveMaxTurns: unset → lane default; explicit setting ALWAYS wins', () => {
    expect(resolveMaxTurns(undefined, 'openrouter')).toBe(MAX_TURNS_DEFAULT_HOSTED);
    expect(resolveMaxTurns(undefined, 'ollama')).toBe(MAX_TURNS_DEFAULT);
    expect(resolveMaxTurns(48, 'openrouter')).toBe(48); // above the hosted default
    expect(resolveMaxTurns(8, 'ollama')).toBe(8); // below the local default
  });

  test('store: unset by default; setMaxTurns clamps to [4, 64]; undefined clears back to lane default', () => {
    const s = useSettingsStore.getState();
    expect(s.maxTurns).toBeUndefined();
    s.setMaxTurns(20);
    expect(useSettingsStore.getState().maxTurns).toBe(20);
    s.setMaxTurns(MAX_TURNS_MAX + 100);
    expect(useSettingsStore.getState().maxTurns).toBe(MAX_TURNS_MAX);
    s.setMaxTurns(1);
    expect(useSettingsStore.getState().maxTurns).toBe(MAX_TURNS_MIN);
    s.setMaxTurns(undefined);
    expect(useSettingsStore.getState().maxTurns).toBeUndefined();
  });
});
