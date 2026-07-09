/**
 * Editable path-bar logic (pure): parse what a user TYPES OR PASTES into the
 * path input, and derive the clickable crumb list for display mode. The
 * interaction form follows the Firebase console / firebase-tools-ui database
 * viewer's editable breadcrumb bar (clean-room adaptation — behavior only).
 */

import { normalizeRtdbPath, rtdbPathSegments } from './values.js';

/**
 * Normalize raw path-input text to a database path. Tolerant of what people
 * paste into a database URL bar:
 *   - a plain path, with or without the leading slash (`rooms/r1`, `/rooms`)
 *   - a full URL (`https://x.firebaseio.com/rooms/r1` → `/rooms/r1`)
 *   - repeated/trailing slashes, surrounding whitespace
 *   - a `?query` / `#hash` tail (dropped)
 * Empty input is the root.
 */
export function parseRtdbPathInput(raw: string): string {
  let text = raw.trim();
  if (text.length === 0) return '/';
  // A pasted absolute URL: strip `scheme://host[:port]`.
  const url = /^[a-z][a-z0-9+.-]*:\/\/[^/?#]+/i.exec(text);
  if (url) text = text.slice(url[0].length);
  // Drop a query/hash tail (URL bars carry them; database paths do not).
  text = text.replace(/[?#].*$/, '');
  return normalizeRtdbPath(text);
}

export interface RtdbCrumb {
  /** The path segment to display. */
  label: string;
  /** Absolute database path this crumb navigates to. */
  path: string;
}

/**
 * The non-root crumbs for a path, in order. `'/'` yields `[]` — the root crumb
 * is the caller's (it carries the database/instance label, not a segment).
 */
export function rtdbCrumbs(path: string): RtdbCrumb[] {
  const segments = rtdbPathSegments(path);
  return segments.map((label, i) => ({
    label,
    path: `/${segments.slice(0, i + 1).join('/')}`,
  }));
}
