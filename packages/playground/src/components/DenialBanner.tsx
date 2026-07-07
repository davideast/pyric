/**
 * Slim status strip above the App preview — surfaces denials without
 * eating the preview's vertical space. One line, one click:
 *
 *   ⊘  1 unexpected denial    [open denials →]
 *   ⊘  3 denials (2 expected) [open denials →]
 *
 * The full inspector (request shapes, classifications, per-row copy,
 * Fix-all-unexpected, clear) lives in the right-panel `Denials` tab.
 * `onOpenDenials` switches that tab from the parent.
 *
 * Tone follows the worst denial classification in the batch — if any
 * are `unexpected` the banner reads red, otherwise amber. Pure
 * informational; no destructive actions on the banner itself.
 */
import { useRuntimeStore } from '~/lib/store/runtime';

interface DenialBannerProps {
  /** Switch the right-panel tab to `Denials` so the user can inspect
   *  / copy / fix. The slim banner is intentionally action-light;
   *  everything substantive happens in the panel. */
  onOpenDenials?: () => void;
}

export function DenialBanner({ onOpenDenials }: DenialBannerProps = {}) {
  const denials = useRuntimeStore((s) => s.liveDenials);
  // Banner counts *unacknowledged* denials only. Once the user clicks
  // into a denial in the Denials panel (running Analyze), it's marked
  // acknowledged and drops off the banner — but stays in the panel.
  const unread = denials.filter((d) => !d.acknowledged);
  if (unread.length === 0) return null;

  const counts = unread.reduce(
    (acc, d) => {
      acc[d.classification] += 1;
      return acc;
    },
    { expected: 0, ambiguous: 0, unexpected: 0 },
  );
  const hasUnexpected = counts.unexpected > 0;

  // Banner tone: red if any unexpected, amber if only expected/ambiguous.
  const tone = hasUnexpected
    ? { bg: 'bg-[#2a1a1a]/95', border: 'border-[#3a2a2a]', text: 'text-[#f0a0a0]' }
    : { bg: 'bg-[#2a241a]/95', border: 'border-[#3a3225]', text: 'text-[#e6c79c]' };

  // Headline picks the most actionable number. Unexpected wins;
  // otherwise total count with a quiet classification breakdown.
  let headline: string;
  if (hasUnexpected) {
    headline =
      counts.unexpected === unread.length
        ? `${counts.unexpected} unexpected denial${counts.unexpected === 1 ? '' : 's'}`
        : `${unread.length} denials · ${counts.unexpected} unexpected`;
  } else {
    headline = `${unread.length} denial${unread.length === 1 ? '' : 's'} · all anticipated`;
  }

  return (
    <div
      className={[
        'shrink-0 border-b backdrop-blur-sm',
        tone.bg,
        tone.border,
      ].join(' ')}
    >
      <div className="flex items-center gap-2 px-4 py-2">
        <span className={`material-symbols-outlined text-[16px] ${tone.text}`}>
          block
        </span>
        <span className={`text-[12px] font-medium ${tone.text}`}>{headline}</span>
        {onOpenDenials ? (
          <button
            type="button"
            onClick={onOpenDenials}
            title="Open the Denials panel"
            className="ml-auto flex items-center gap-1 text-[11px] font-mono text-slate-gray hover:text-soft-white transition-colors"
          >
            <span>open denials</span>
            <span className="material-symbols-outlined text-[14px]">arrow_forward</span>
          </button>
        ) : null}
      </div>
    </div>
  );
}
