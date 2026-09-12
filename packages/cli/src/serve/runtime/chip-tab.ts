/**
 * Which of the chip panel's four views is showing, and which one it opens on.
 *
 * A developer opens the chip for a reason, and the reason is usually a signal
 * the collapsed pill just turned a colour: a denial, a duplicate listener, a
 * worker update waiting. The panel opens on the view that holds the strongest
 * of those signals, so the first thing on screen is the thing that prompted
 * the click. With nothing pressing, it opens where the developer left off, and
 * on Identity the first time.
 *
 * The last view is remembered per page origin in `localStorage`. Storage is a
 * page capability that can be absent, full, or blocked, so every read and
 * write is guarded and a failure leaves the default rather than an error.
 */

/** The panel's four views. */
export type ChipTab = 'identity' | 'listeners' | 'traffic' | 'sandbox';

/** The view a page with no remembered choice and no signal opens on. */
export const DEFAULT_CHIP_TAB: ChipTab = 'identity';

/** Where the last view is kept. */
export const CHIP_TAB_KEY = 'pyric:chip-tab';

/** The views in strip order. */
export const CHIP_TABS: readonly ChipTab[] = ['identity', 'listeners', 'traffic', 'sandbox'];

/** The label each view carries in the strip. */
export const CHIP_TAB_LABELS: Readonly<Record<ChipTab, string>> = {
  identity: 'Identity',
  listeners: 'Listeners',
  traffic: 'Traffic',
  sandbox: 'Sandbox',
};

/** The part of `localStorage` this module uses. */
export interface ChipTabStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

/** The problems the four views can be holding right now. */
export interface ChipTabSignals {
  /** A request was denied, or a sandbox error raised, within the last minute. */
  failedRecently: boolean;
  /** Two or more listeners are attached to one target. */
  duplicateListener: boolean;
  /** A newer worker is served than the one running. */
  updatePending: boolean;
}

/** `true` when this string names a view. */
export function isChipTab(value: unknown): value is ChipTab {
  return value === 'identity' || value === 'listeners' || value === 'traffic' || value === 'sandbox';
}

/**
 * The view an open should land on. A fresh failure outranks a duplicate
 * listener, which outranks a pending update, because a failure is the page
 * failing now, a duplicate is the page wasting work, and an update is only an
 * offer. With none of the three, the remembered view wins, and Identity is the
 * first-time default.
 */
export function openingChipTab(
  signals: ChipTabSignals,
  remembered: ChipTab | null,
): ChipTab {
  if (signals.failedRecently) return 'traffic';
  if (signals.duplicateListener) return 'listeners';
  if (signals.updatePending) return 'identity';
  return remembered ?? DEFAULT_CHIP_TAB;
}

/** The view each signal colours in the strip, or `null` for a clean strip. */
export function problemTab(signals: ChipTabSignals): ChipTab | null {
  if (signals.failedRecently) return 'traffic';
  if (signals.duplicateListener) return 'listeners';
  if (signals.updatePending) return 'identity';
  return null;
}

/** The remembered view, or `null` when nothing readable was kept. */
export function readRememberedChipTab(
  storage: ChipTabStorage | null | undefined,
): ChipTab | null {
  if (storage === null || storage === undefined) return null;
  try {
    const stored = storage.getItem(CHIP_TAB_KEY);
    return isChipTab(stored) ? stored : null;
  } catch {
    return null;
  }
}

/** Remember this view for the page. A storage that refuses is not an error. */
export function writeRememberedChipTab(
  storage: ChipTabStorage | null | undefined,
  tab: ChipTab,
): void {
  if (storage === null || storage === undefined) return;
  try {
    storage.setItem(CHIP_TAB_KEY, tab);
  } catch {
    /* a page that cannot remember the view still shows the one just chosen */
  }
}

/** The page's own storage, when it has one this module can use. */
export function pageChipTabStorage(
  documentLike: Document | null | undefined,
): ChipTabStorage | null {
  try {
    const storage = documentLike?.defaultView?.localStorage;
    return storage ?? null;
  } catch {
    return null;
  }
}
