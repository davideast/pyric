/**
 * Small clipboard button used inline on prompts / replies / tool
 * drill-ins. Copies the passed value verbatim — no transformation,
 * just `navigator.clipboard.writeText(value)`. The icon swaps to a
 * check for ~1.4s after a successful copy as visual confirmation.
 *
 * Falls back silently when the Clipboard API is unavailable (rare
 * outside of `file://` and old browsers); the button click becomes
 * a no-op rather than throwing.
 */
import { useCallback, useState } from 'react';

export interface CopyButtonProps {
  value: string;
  /** Accessible label + tooltip. Default 'Copy'. */
  label?: string;
  /** Optional visible text next to the icon (e.g. "Copy all"). When
   *  absent the button is icon-only. The text swaps to "Copied" for
   *  the same 1.4s confirmation window the icon uses. */
  text?: string;
  /** Material-symbols icon name. Default `content_copy`; e.g. pass
   *  `copy_all` for a copy-the-whole-thing button. */
  icon?: string;
  /** Icon size in px. Default 14. */
  size?: number;
  className?: string;
}

export function CopyButton({
  value,
  label = 'Copy',
  text,
  icon = 'content_copy',
  size = 14,
  className,
}: CopyButtonProps) {
  const [copied, setCopied] = useState(false);

  const handleClick = useCallback(
    (e: React.MouseEvent) => {
      // Stop bubble + cancel default so the button works correctly
      // inside `<summary>` (where a child click otherwise toggles the
      // parent fold) and inside any other clickable ancestor.
      e.stopPropagation();
      e.preventDefault();
      if (!navigator.clipboard?.writeText) return;
      void navigator.clipboard.writeText(value).then(
        () => {
          setCopied(true);
          setTimeout(() => setCopied(false), 1400);
        },
        () => {
          /* permission denied / insecure context — silent */
        },
      );
    },
    [value],
  );

  return (
    <button
      type="button"
      onClick={handleClick}
      aria-label={copied ? 'Copied' : label}
      title={copied ? 'Copied' : label}
      className={[
        'inline-flex items-center gap-1 text-slate-gray hover:text-soft-white transition-colors p-1 rounded shrink-0',
        className ?? '',
      ].join(' ')}
    >
      <span
        className="material-symbols-outlined block leading-none"
        style={{ fontSize: size }}
      >
        {copied ? 'check' : icon}
      </span>
      {text ? (
        <span className="text-[10px] uppercase tracking-wider">
          {copied ? 'Copied' : text}
        </span>
      ) : null}
    </button>
  );
}
