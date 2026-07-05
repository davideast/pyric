/**
 * Theme switching (Phase 0, F-THEME runtime).
 *
 * The token contract (`styles/tokens.css`) is adaptive and DARK by default:
 * dark under `:root`, light under `prefers-color-scheme: light` (when no explicit
 * choice) and under `[data-theme="light"]`, with `[data-theme="dark"]` falling
 * through to the `:root` dark values. This module owns the runtime side: it maps
 * the user's CHOICE onto `<html data-theme>`:
 *
 *   - choice `'system'` → REMOVE `data-theme` so the OS preference drives it,
 *   - choice `'light'`  → `data-theme="light"`,
 *   - choice `'dark'`   → `data-theme="dark"`.
 *
 * The choice is persisted to `localStorage` so a reload restores it. Components
 * read/set it via {@link useTheme}; the `<ThemeSwitcher>` control is the UI.
 *
 * `resolvedTheme` is the EFFECTIVE light/dark after the OS pref is applied,
 * handy for any component that needs to branch on the concrete palette.
 */

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';

/** The user's theme CHOICE. `system` follows the OS. */
export type ThemeChoice = 'system' | 'light' | 'dark';
/** The EFFECTIVE palette after resolving `system` against the OS pref. */
export type ResolvedTheme = 'light' | 'dark';

const STORAGE_KEY = 'pyric-studio:theme';
// Dark is the product default: a fresh load (no stored choice) is dark
// regardless of the OS preference. The switcher still offers light / system.
const DEFAULT_CHOICE: ThemeChoice = 'dark';

/** Read the persisted choice, falling back to `system`. */
function readStoredChoice(): ThemeChoice {
  if (typeof localStorage === 'undefined') return DEFAULT_CHOICE;
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    return stored === 'light' || stored === 'dark' || stored === 'system'
      ? stored
      : DEFAULT_CHOICE;
  } catch {
    return DEFAULT_CHOICE;
  }
}

/** Does the OS currently prefer dark? */
function systemPrefersDark(): boolean {
  if (typeof window === 'undefined' || !window.matchMedia) return false;
  return window.matchMedia('(prefers-color-scheme: dark)').matches;
}

/**
 * Reflect the choice onto `<html>`: explicit choices set `data-theme`, `system`
 * removes it so the CSS `prefers-color-scheme` rules take over.
 */
function applyChoice(choice: ThemeChoice): void {
  if (typeof document === 'undefined') return;
  const html = document.documentElement;
  if (choice === 'system') html.removeAttribute('data-theme');
  else html.setAttribute('data-theme', choice);
}

interface ThemeContextValue {
  /** The user's choice (`system` | `light` | `dark`). */
  choice: ThemeChoice;
  /** The effective palette after resolving `system`. */
  resolvedTheme: ResolvedTheme;
  setChoice: (choice: ThemeChoice) => void;
  /** Cycle light → dark → system → light (used by a single-button affordance). */
  cycleChoice: () => void;
}

const ThemeContext = createContext<ThemeContextValue | null>(null);

const CYCLE: ThemeChoice[] = ['light', 'dark', 'system'];

export function ThemeProvider({ children }: { children: ReactNode }) {
  const [choice, setChoiceState] = useState<ThemeChoice>(readStoredChoice);
  const [systemDark, setSystemDark] = useState<boolean>(systemPrefersDark);

  // Apply + persist on every choice change.
  useEffect(() => {
    applyChoice(choice);
    try {
      localStorage.setItem(STORAGE_KEY, choice);
    } catch {
      /* private mode / disabled storage: non-fatal, theme still applies */
    }
  }, [choice]);

  // Track the OS preference so `resolvedTheme` stays correct in `system` mode
  // (and the switch's "system" label reflects reality live).
  useEffect(() => {
    if (typeof window === 'undefined' || !window.matchMedia) return;
    const mq = window.matchMedia('(prefers-color-scheme: dark)');
    const onChange = () => setSystemDark(mq.matches);
    mq.addEventListener('change', onChange);
    return () => mq.removeEventListener('change', onChange);
  }, []);

  const resolvedTheme: ResolvedTheme = useMemo(() => {
    if (choice === 'light') return 'light';
    if (choice === 'dark') return 'dark';
    return systemDark ? 'dark' : 'light';
  }, [choice, systemDark]);

  const setChoice = useCallback((next: ThemeChoice) => setChoiceState(next), []);
  const cycleChoice = useCallback(
    () => setChoiceState((c) => CYCLE[(CYCLE.indexOf(c) + 1) % CYCLE.length]),
    [],
  );

  const value = useMemo<ThemeContextValue>(
    () => ({ choice, resolvedTheme, setChoice, cycleChoice }),
    [choice, resolvedTheme, setChoice, cycleChoice],
  );

  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

export function useTheme(): ThemeContextValue {
  const ctx = useContext(ThemeContext);
  if (!ctx) throw new Error('useTheme must be used within a <ThemeProvider>');
  return ctx;
}
