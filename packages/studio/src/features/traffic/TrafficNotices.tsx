import { defaultFormatTime, type TimeWindow } from '@pyric/ui/traffic';
import { STUDIO_EVENT_CAP } from '../../shell/studio-events.js';

const capNumberFormatter = new Intl.NumberFormat();

export interface TrafficFocusedInterval {
  readonly window: TimeWindow;
  readonly finding: string;
  readonly onClear: () => void;
}

export function formatTrafficWindowRange(window: TimeWindow): string {
  return `${defaultFormatTime(window.start)}–${defaultFormatTime(window.end)}`;
}

/**
 * Unfocused views disclose rolling retention when an affected lane has evicted
 * traffic (`unfocusedCapped`). Focused intervals disclose rolling retention only
 * when the brushed window starts before the oldest retained row of an affected
 * capped lane (`uncoveredBeforeAt`).
 */
export function shouldShowCapNotice(
  unfocusedCapped: boolean,
  uncoveredBeforeAt: number | null,
  focusedWindow: TimeWindow | null,
): boolean {
  if (focusedWindow === null) return unfocusedCapped;
  if (uncoveredBeforeAt === null) return false;
  return focusedWindow.start < uncoveredBeforeAt;
}

export function TrafficTimeFocusBanner({ focus }: { focus: TrafficFocusedInterval }) {
  return (
    <section
      className="traffic__time-focus"
      aria-label="Selected traffic interval"
      aria-live="polite"
    >
      <div className="traffic__time-focus-story">
        <p className="traffic__time-focus-eyebrow">Selected interval</p>
        <h3>{formatTrafficWindowRange(focus.window)}</h3>
        <p>{focus.finding}</p>
      </div>
      <button type="button" onClick={focus.onClear}>
        Show all traffic
      </button>
    </section>
  );
}

export function TrafficCapNotice({
  capped,
  scope,
}: {
  capped: boolean;
  scope: 'all' | 'rules';
}) {
  if (!capped) return null;
  const formattedCap = capNumberFormatter.format(STUDIO_EVENT_CAP);
  let message = `Showing latest ${formattedCap} retained requests per traffic lane — older session events aged out of the live buffer.`;
  if (scope === 'rules') {
    message = `Showing latest ${formattedCap} retained client requests — older session evaluations aged out of the live buffer.`;
  }
  return (
    <p className="traffic__cap-notice" data-pyric-traffic-capped="">
      {message}
    </p>
  );
}
