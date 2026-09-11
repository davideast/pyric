/**
 * The overlay's theme contract: every CSS custom property the painted boxes
 * read, what each one defaults to, and how an override reaches the page.
 *
 * The painters put structure in the DOM and nothing else. A box says what it
 * is (`data-pyric-role`), which listener it belongs to, which hue that
 * listener draws in (`data-hue`), whether an incident is on it, and whether
 * its flow is retained. Everything visible about it comes from one stylesheet
 * injected into the overlay container, which reads the properties below off
 * that container. Geometry stays inline on each box, because it is measured
 * from the page rather than chosen.
 *
 * Three layers set those properties, later layers winning:
 *
 * 1. the defaults in {@link OVERLAY_THEME_DEFAULTS}, which reproduce what the
 *    overlay drew before there was a stylesheet;
 * 2. the `overlayTheme` option the served page passes to the runtime chip;
 * 3. the JSON object under {@link OVERLAY_THEME_KEY} in `localStorage`, which
 *    the chip's Theme dialog writes and a `storage` event re-applies live.
 *
 * A theme is a flat object of property name to property value. Names that are
 * not in this contract are ignored. Values are applied verbatim, so the page
 * decides what a valid value is: a property the browser rejects leaves that
 * part of the drawing at whatever the cascade already had.
 *
 * The names follow the chip's own host properties (`--pyric-bg`,
 * `--pyric-accent`, `--pyric-warning`, and the rest): the hues are
 * `--pyric-hue-N`, and everything specific to the painted overlay is
 * `--pyric-overlay-*`.
 */
import { listenerPalette } from './listener-palette.js';

/** A flat set of overrides: custom property name to custom property value. */
export type OverlayTheme = Readonly<Record<string, string>>;

/** Where the page's own overrides are kept. */
export const OVERLAY_THEME_KEY = 'pyric:overlay-theme';

/** The part of `localStorage` this module uses. */
export interface OverlayThemeStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

/**
 * The hue a listener is painted in, and the lighter tone its badge text takes.
 * One pair per palette entry, so a theme can repaint the palette without
 * knowing how a listener is assigned to it.
 */
function hueDefaults(): Record<string, string> {
  const defaults: Record<string, string> = {};
  listenerPalette().forEach((hue, index) => {
    defaults[`--pyric-hue-${index}`] = `hsl(${hue} 72% 52%)`;
    defaults[`--pyric-hue-${index}-text`] = `hsl(${hue} 72% 66%)`;
  });
  return defaults;
}

/**
 * Every property the overlay stylesheet reads, with the value that reproduces
 * what the overlay drew before the stylesheet existed.
 *
 * An empty default means the property is left unset, and the stylesheet falls
 * back to something it derives per box. `--pyric-overlay-badge-fg` is the one
 * such property: unset, a badge takes its listener's own hue text tone, and a
 * theme that sets it paints every badge the same colour.
 */
export const OVERLAY_THEME_DEFAULTS: OverlayTheme = Object.freeze({
  ...hueDefaults(),
  '--pyric-overlay-outline-width': '1px',
  '--pyric-overlay-outline-style': 'solid',
  '--pyric-overlay-radius': '4px',
  '--pyric-overlay-fill-opacity': '8%',
  '--pyric-overlay-incident': '#e6c79c',
  '--pyric-overlay-badge-bg': '#16161a',
  '--pyric-overlay-badge-fg': '',
  '--pyric-overlay-badge-font-family': '"JetBrains Mono", ui-monospace, monospace',
  '--pyric-overlay-badge-font-size': '10px',
  '--pyric-overlay-badge-padding': '1px 6px',
  '--pyric-overlay-leaf-badge-font-size': '9px',
  '--pyric-overlay-leaf-badge-padding': '0 4px',
  '--pyric-overlay-fade-duration': '3000ms',
  '--pyric-overlay-retained-opacity': '0.3',
});

/** Every property name a theme may set, in contract order. */
export const OVERLAY_THEME_VARIABLES: readonly string[] = Object.freeze(
  Object.keys(OVERLAY_THEME_DEFAULTS),
);

/** `true` when this name is part of the contract. */
export function isOverlayThemeVariable(name: string): boolean {
  return Object.prototype.hasOwnProperty.call(OVERLAY_THEME_DEFAULTS, name);
}

/** The contract's names and values only, in the order the layers were given. */
export function resolveOverlayTheme(
  ...layers: readonly (OverlayTheme | null | undefined)[]
): Record<string, string> {
  const resolved: Record<string, string> = { ...OVERLAY_THEME_DEFAULTS };
  for (const layer of layers) {
    if (layer === null || layer === undefined) continue;
    for (const [name, value] of Object.entries(layer)) {
      if (!isOverlayThemeVariable(name)) continue;
      if (typeof value !== 'string') continue;
      resolved[name] = value;
    }
  }
  return resolved;
}

/**
 * Put a resolved theme on the container. A property resolved to the empty
 * string is removed rather than set, so the stylesheet's own fallback applies
 * and a Reset takes an override away instead of pinning it.
 */
export function applyOverlayTheme(
  container: HTMLElement,
  ...layers: readonly (OverlayTheme | null | undefined)[]
): void {
  const resolved = resolveOverlayTheme(...layers);
  for (const name of OVERLAY_THEME_VARIABLES) {
    const value = resolved[name] ?? '';
    if (value === '') container.style.removeProperty(name);
    else container.style.setProperty(name, value);
  }
}

/** A theme object out of a JSON string, or `null` when it is not one. */
export function parseOverlayTheme(text: string): Record<string, string> | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null;
  const theme: Record<string, string> = {};
  for (const [name, value] of Object.entries(parsed as Record<string, unknown>)) {
    if (typeof value === 'string') theme[name] = value;
  }
  return theme;
}

/** The overrides the page kept, or `null` when there are none to read. */
export function readStoredOverlayTheme(
  storage: OverlayThemeStorage | null | undefined,
): Record<string, string> | null {
  if (storage === null || storage === undefined) return null;
  try {
    const stored = storage.getItem(OVERLAY_THEME_KEY);
    return stored === null ? null : parseOverlayTheme(stored);
  } catch {
    return null;
  }
}

/** Keep these overrides for the page. A storage that refuses is not an error. */
export function writeStoredOverlayTheme(
  storage: OverlayThemeStorage | null | undefined,
  theme: OverlayTheme,
): void {
  if (storage === null || storage === undefined) return;
  try {
    storage.setItem(OVERLAY_THEME_KEY, JSON.stringify(theme));
  } catch {
    /* a page that cannot keep the overrides still draws with them this session */
  }
}

/** Take the page's overrides away. */
export function clearStoredOverlayTheme(
  storage: OverlayThemeStorage | null | undefined,
): void {
  if (storage === null || storage === undefined) return;
  try {
    storage.removeItem(OVERLAY_THEME_KEY);
  } catch {
    /* nothing was kept, which is the state a clear was asking for */
  }
}

/** The page's own storage, when it has one this module can use. */
export function pageOverlayThemeStorage(
  documentLike: Document | null | undefined,
): OverlayThemeStorage | null {
  try {
    const storage = documentLike?.defaultView?.localStorage;
    return storage ?? null;
  } catch {
    return null;
  }
}

/** The attribute the injected stylesheet carries, so it is injected once. */
export const OVERLAY_STYLE_ATTRIBUTE = 'data-pyric-overlay-style';

function hueRules(): string {
  return listenerPalette()
    .map((_hue, index) => `[data-pyric-listener-overlay] [data-hue="${index}"] {
    --pyric-overlay-hue: var(--pyric-hue-${index});
    --pyric-overlay-hue-text: var(--pyric-hue-${index}-text);
  }`)
    .join('\n  ');
}

/**
 * Everything the overlay draws, off the container's properties.
 *
 * The fade is two states rather than one: the painter marks a group fading on
 * the frame after it draws, which is what starts the transition, and marks it
 * retained when the fade is over. Both land on the same opacity, so a page
 * that runs no transitions still shows the retained state.
 */
export function overlayStyleSheetText(): string {
  return `
  ${hueRules()}
  [data-pyric-listener-overlay] [data-pyric-listener-box],
  [data-pyric-listener-overlay] [data-pyric-flow-box] {
    position: absolute;
    pointer-events: none;
    border: var(--pyric-overlay-outline-width) var(--pyric-overlay-outline-style) var(--pyric-overlay-hue);
    border-radius: var(--pyric-overlay-radius);
    background: color-mix(in srgb, var(--pyric-overlay-hue) var(--pyric-overlay-fill-opacity), transparent);
  }
  [data-pyric-listener-overlay] [data-pyric-listener-box][data-incident],
  [data-pyric-listener-overlay] [data-pyric-flow-box][data-incident] {
    border-color: var(--pyric-overlay-incident);
  }
  [data-pyric-listener-overlay] [data-pyric-flow-box] {
    opacity: 1;
    transition: opacity var(--pyric-overlay-fade-duration) linear;
  }
  [data-pyric-listener-overlay] [data-pyric-flow-box][data-flow-fading],
  [data-pyric-listener-overlay] [data-pyric-flow-box][data-flow-retained] {
    opacity: var(--pyric-overlay-retained-opacity);
  }
  [data-pyric-listener-overlay] [data-pyric-role="badge"],
  [data-pyric-listener-overlay] [data-pyric-role="leaf-badge"] {
    position: absolute;
    background: var(--pyric-overlay-badge-bg);
    border: var(--pyric-overlay-outline-width) var(--pyric-overlay-outline-style) var(--pyric-overlay-hue);
    border-radius: var(--pyric-overlay-radius);
    color: var(--pyric-overlay-badge-fg, var(--pyric-overlay-hue-text));
    font-family: var(--pyric-overlay-badge-font-family);
    font-size: var(--pyric-overlay-badge-font-size);
    line-height: 1.6;
    padding: var(--pyric-overlay-badge-padding);
    pointer-events: none;
    white-space: nowrap;
  }
  [data-pyric-listener-overlay] [data-pyric-role="badge"] {
    top: -9px;
    left: 0;
  }
  [data-pyric-listener-overlay] [data-pyric-role="leaf-badge"] {
    bottom: -9px;
    right: 0;
    font-size: var(--pyric-overlay-leaf-badge-font-size);
    padding: var(--pyric-overlay-leaf-badge-padding);
  }
  [data-pyric-listener-overlay] [data-pyric-listener-badge] {
    cursor: pointer;
    pointer-events: auto;
  }
  [data-pyric-listener-overlay] [data-pyric-role="badge"][data-incident],
  [data-pyric-listener-overlay] [data-pyric-role="leaf-badge"][data-incident] {
    border-color: var(--pyric-overlay-incident);
  }
`;
}

/**
 * Put the stylesheet in the container, once. Both painters call this, so a
 * painter drawing into a container the other one made still has the rules.
 */
export function ensureOverlayStyleSheet(
  documentLike: Document,
  container: HTMLElement,
): HTMLStyleElement {
  // Every rule is scoped to the overlay container, so the container a painter
  // was handed has to be marked as one before the rules can reach its boxes.
  if (!container.hasAttribute('data-pyric-listener-overlay')) {
    container.setAttribute('data-pyric-listener-overlay', '');
  }
  const existing = container.querySelector<HTMLStyleElement>(`[${OVERLAY_STYLE_ATTRIBUTE}]`);
  if (existing !== null) return existing;
  const style = documentLike.createElement('style');
  style.setAttribute(OVERLAY_STYLE_ATTRIBUTE, '');
  style.textContent = overlayStyleSheetText();
  container.prepend(style);
  return style;
}
