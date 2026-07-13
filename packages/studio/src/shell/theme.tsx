/**
 * Studio theme runtime.
 *
 * Studio is dark-only for V1. The context shape stays in place so existing
 * components do not need a broad rewrite, but old persisted light/system
 * choices are ignored.
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
const DEFAULT_CHOICE: ThemeChoice = 'dark';

/** Studio V1 is dark-only; ignore older persisted choices. */
function readStoredChoice(): ThemeChoice {
  return DEFAULT_CHOICE;
}

/** Reflect the V1 dark-only theme onto `<html>`. */
function applyChoice(): void {
  if (typeof document === 'undefined') return;
  document.documentElement.setAttribute('data-theme', 'dark');
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

export function ThemeProvider({ children }: { children: ReactNode }) {
  const [choice, setChoiceState] = useState<ThemeChoice>(readStoredChoice);

  // Apply + persist dark on every choice change. This overwrites older light or
  // system choices from earlier Studio builds.
  useEffect(() => {
    applyChoice();
    try {
      localStorage.setItem(STORAGE_KEY, DEFAULT_CHOICE);
    } catch {
      /* private mode / disabled storage: non-fatal, theme still applies */
    }
  }, [choice]);

  const resolvedTheme: ResolvedTheme = 'dark';
  const setChoice = useCallback((_next: ThemeChoice) => setChoiceState(DEFAULT_CHOICE), []);
  const cycleChoice = useCallback(() => setChoiceState(DEFAULT_CHOICE), []);

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
