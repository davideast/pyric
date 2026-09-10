/**
 * CSS Custom Property token contract for @pyric/ui.
 *
 * Provides a standardized CSS variable contract for colors, surfaces,
 * borders, text, and focus states:
 * - `--pyric-color`: base accent / primary brand color
 * - `--pyric-bg`: background surface color
 * - `--pyric-fg`: foreground element color
 * - `--pyric-focus`: focus indicator outline color
 * - `--pyric-border`: border and hairline color
 * - `--pyric-text`: primary text ink color
 *
 * Accessibility and forced-colors contract:
 * - Supports Windows High Contrast / forced-colors mode (`@media (forced-colors: active)`)
 *   using System Colors (Canvas, CanvasText, Highlight, ButtonBorder, etc.).
 * - Supports high-contrast preferences (`@media (prefers-contrast: more)`).
 * - Implements keyboard navigation focus rings with `:focus-visible` and `outline:`.
 */
export const PYRIC_THEME_TOKENS = {
  color: '--pyric-color',
  bg: '--pyric-bg',
  fg: '--pyric-fg',
  focus: '--pyric-focus',
  border: '--pyric-border',
  text: '--pyric-text',
} as const;

export type PyricThemeToken = (typeof PYRIC_THEME_TOKENS)[keyof typeof PYRIC_THEME_TOKENS];

/**
 * Accessibility and focus-visible contract styles.
 */
export const ACCESSIBILITY_CONTRACT = {
  focusVisible: ':focus-visible',
  focusOutline: 'outline: 2px solid var(--pyric-focus, Highlight)',
  forcedColorsQuery: '@media (forced-colors: active)',
  prefersContrastQuery: '@media (prefers-contrast: more)',
} as const;
