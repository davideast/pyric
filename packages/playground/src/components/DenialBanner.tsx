/**
 * Slim status strip above the App preview — surfaces denials without
 * eating the preview's vertical space. One line, one click:
 *
 *   ⊘  1 denied request    [open traffic →]
 *   ⊘  3 denied requests   [open traffic →]
 *
 * The full inspector lives in the Traffic panel.
 * `onOpenDenials` switches that tab from the parent.
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

  const tone = { bg: 'bg-[#2a241a]/95', border: 'border-[#3a3225]', text: 'text-[#e6c79c]' };
  const headline = `${unread.length} denied request${unread.length === 1 ? '' : 's'}`;

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
            title="Open Traffic"
            className="ml-auto flex items-center gap-1 text-[11px] font-mono text-slate-gray hover:text-soft-white transition-colors"
          >
            <span>open traffic</span>
            <span className="material-symbols-outlined text-[14px]">arrow_forward</span>
          </button>
        ) : null}
      </div>
    </div>
  );
}
