/**
 * Theme toggle (F-SHELL): a single icon button that cycles
 * Light -> Dark -> System, wired to {@link useTheme}. The old three-segment
 * control was busy chrome; this is one load-bearing affordance. The glyph + the
 * label reflect the persisted CHOICE (not the resolved palette), so "System"
 * reads as System even when it currently resolves to dark.
 */

import { useTheme, type ThemeChoice } from './theme.js';
import { IconSun, IconMoon, IconAuto } from './icons.js';

const NEXT: Record<ThemeChoice, ThemeChoice> = {
  dark: 'light',
  light: 'system',
  system: 'dark',
};
const LABEL: Record<ThemeChoice, string> = {
  light: 'Light',
  dark: 'Dark',
  system: 'System',
};

export function ThemeSwitcher() {
  const { choice, setChoice } = useTheme();
  const Icon = choice === 'light' ? IconSun : choice === 'dark' ? IconMoon : IconAuto;

  return (
    <button
      type="button"
      className="studio__iconbtn"
      data-testid="theme-switch"
      data-theme-choice={choice}
      aria-label={`Theme: ${LABEL[choice]}. Click to change.`}
      title={`Theme: ${LABEL[choice]}`}
      onClick={() => setChoice(NEXT[choice])}
    >
      <Icon />
    </button>
  );
}
