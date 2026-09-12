/**
 * The colour one listener is painted in, in either of the chip's painting
 * modes.
 *
 * A listener keeps its colour for as long as its id does, so the same box on
 * the page, the same flow subtree, and the same swatch in the chip's panel all
 * read as one listener. The colour is derived, not assigned: nothing has to
 * hold a registry, and two views of the same listener id agree without
 * exchanging anything.
 *
 * The palette is eight hues chosen to stay apart from each other on the dark
 * overlay chrome the overlay already draws, with the Listeners green first so
 * a page with one listener looks the way it did before there were colours.
 */

/** The hues, in degrees, the palette draws from. */
const HUES = [146, 200, 44, 280, 12, 172, 320, 96] as const;

/** How a listener's colour reads against the overlay's dark chrome. */
export interface ListenerColors {
  /** The outline stroke. */
  readonly border: string;
  /** The wash inside the outline. */
  readonly fill: string;
  /** The badge's text. */
  readonly accent: string;
  /** The swatch in the chip's panel. */
  readonly swatch: string;
}

/**
 * A stable index into the palette. The hash is the 32-bit FNV-1a of the id,
 * which spreads the sandbox's sequential subscription ids across the eight
 * hues rather than handing consecutive listeners neighbouring entries.
 */
export function listenerHueIndex(listenerId: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < listenerId.length; i += 1) {
    hash ^= listenerId.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash % HUES.length;
}

/** The hue, in degrees, this listener is painted in. */
export function listenerHue(listenerId: string): number {
  return HUES[listenerHueIndex(listenerId)];
}

/** Every colour the overlay and the panel need for one listener. */
export function listenerColors(listenerId: string): ListenerColors {
  const hue = listenerHue(listenerId);
  return {
    border: `hsl(${hue} 72% 52%)`,
    fill: `hsla(${hue}, 72%, 52%, .08)`,
    accent: `hsl(${hue} 72% 66%)`,
    swatch: `hsl(${hue} 72% 52%)`,
  };
}

/** The whole palette, in order, for a caller that wants to show it. */
export function listenerPalette(): readonly number[] {
  return HUES;
}
