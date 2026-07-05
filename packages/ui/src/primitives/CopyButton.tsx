import { useState, type ReactNode } from 'react';

export interface CopyButtonProps {
  /** Text to copy to the clipboard on click. */
  text: string;
  /** Optional content to render inside the button. Defaults to a
   *  short text label that toggles between "Copy" and "Copied". */
  children?: ReactNode;
  /** Milliseconds before the `data-copied` state attribute clears.
   *  Defaults to 2000. */
  resetMs?: number;
  /** Forwarded to the underlying `<button>`. Consumers compose
   *  Tailwind classes, CSS-module classes, or whatever they want. */
  className?: string;
  /** Forwarded as the button's accessible label when in the idle
   *  state. Defaults to "Copy to clipboard". The copied state uses
   *  a hard-coded "Copied" label so screen readers announce the
   *  state change consistently. */
  ariaLabel?: string;
}

/**
 * Headless copy-to-clipboard button. Exposes its `copied` state via
 * the `data-copied` attribute on the underlying `<button>` so
 * consumers can style the success state with `[data-copied]` (or
 * `data-[copied]:bg-green-500` in Tailwind's arbitrary-variant
 * syntax). Ships no visual styling of its own.
 */
export function CopyButton({
  text,
  children,
  resetMs = 2000,
  className,
  ariaLabel = 'Copy to clipboard',
}: CopyButtonProps) {
  const [copied, setCopied] = useState(false);

  async function handleClick() {
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      // Clipboard write can fail (insecure context, denied permission).
      // The library doesn't surface this here — callers wrap in a
      // toast / callout if they want feedback.
      return;
    }
    setCopied(true);
    window.setTimeout(() => setCopied(false), resetMs);
  }

  return (
    <button
      type="button"
      onClick={handleClick}
      className={className}
      data-copied={copied ? '' : undefined}
      aria-label={copied ? 'Copied' : ariaLabel}
    >
      {children ?? (copied ? 'Copied' : 'Copy')}
    </button>
  );
}
