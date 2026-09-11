/**
 * Which of the chip's two painting modes a page is in, and where that choice
 * is kept.
 *
 * Overview paints one box per attached listener and leaves it there. Flow
 * paints, for each delivery, the component subtree that rendered after it and
 * fades it away. The two share the listener fold, the owners, the colours, the
 * overlay container, and the per-listener toggles; only the painting differs.
 *
 * The choice is remembered per page origin in `localStorage`, so a developer
 * who works in Flow keeps Flow across reloads. Storage is a page capability
 * that can be absent, full, or blocked by the browser's settings, so every
 * read and write is guarded and a failure leaves the default mode rather than
 * an error.
 */

/** The painting modes the chip offers. */
export type ListenerPaintMode = 'overview' | 'flow';

/** The mode a page starts in when nothing was remembered. */
export const DEFAULT_LISTENER_PAINT_MODE: ListenerPaintMode = 'overview';

/** Where the choice is kept. */
export const LISTENER_PAINT_MODE_KEY = 'pyric:listener-paint-mode';

/** The part of `localStorage` this module uses. */
export interface PaintModeStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

/** `true` when this string names a mode. */
export function isListenerPaintMode(value: unknown): value is ListenerPaintMode {
  return value === 'overview' || value === 'flow';
}

/** The remembered mode, or the default when nothing readable was kept. */
export function readListenerPaintMode(
  storage: PaintModeStorage | null | undefined,
): ListenerPaintMode {
  if (storage === null || storage === undefined) return DEFAULT_LISTENER_PAINT_MODE;
  try {
    const stored = storage.getItem(LISTENER_PAINT_MODE_KEY);
    return isListenerPaintMode(stored) ? stored : DEFAULT_LISTENER_PAINT_MODE;
  } catch {
    return DEFAULT_LISTENER_PAINT_MODE;
  }
}

/** Remember this mode for the page. A storage that refuses is not an error. */
export function writeListenerPaintMode(
  storage: PaintModeStorage | null | undefined,
  mode: ListenerPaintMode,
): void {
  if (storage === null || storage === undefined) return;
  try {
    storage.setItem(LISTENER_PAINT_MODE_KEY, mode);
  } catch {
    /* a page that cannot remember the choice still honours it for this session */
  }
}

/** The page's own storage, when it has one this module can use. */
export function pagePaintModeStorage(
  documentLike: Document | null | undefined,
): PaintModeStorage | null {
  try {
    const storage = documentLike?.defaultView?.localStorage;
    return storage ?? null;
  } catch {
    return null;
  }
}
