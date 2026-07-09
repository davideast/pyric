/**
 * "Sign in with OpenRouter" — rendered as the OpenRouter row's `extra`
 * slot in the BYOK modal (see `byok-field.tsx`), alongside the manual
 * paste input. Two states:
 *
 *   - No session-backed key: a button that starts the OAuth (PKCE)
 *     redirect (`beginSignIn` in `lib/llm/openrouter-oauth.ts`). The
 *     button click is the only thing this component does before the
 *     full-page navigation away — completion happens on the NEXT page
 *     load, handled by `PlaygroundPage`'s mount effect.
 *   - A session-backed key exists (`openrouterByok.hasSessionKey()`):
 *     a "Remember on this device" checkbox that promotes it to
 *     `localStorage` via `promoteToLocal()`. One-way — unchecking does
 *     not demote a promoted key back to session-only.
 *
 * `signInError` is passed down from `PlaygroundPage` because the
 * exchange that can fail (`completeSignInIfPending`) runs in a mount
 * effect, not from this button — the button only fires the redirect
 * half of the flow, which effectively never "fails" client-side (it's
 * a network call for the authorize URL, then a navigation).
 */
import { useState } from 'react';
import { beginSignIn } from '~/lib/llm/openrouter-oauth';
import { openrouterByok } from '~/lib/llm/byok';

export interface OpenRouterSignInProps {
  /** Bumps the modal's re-read of `byok.hasKey()` after a promote. */
  onKeyChanged: () => void;
  /** Surfaced from the OAuth callback exchange (see PlaygroundPage's
   *  mount effect), not from this component's own button click. */
  signInError?: string | null;
  /** Called when the user starts a fresh attempt — lets the parent
   *  clear a stale `signInError` from a previous denied/expired code
   *  before the new redirect happens. */
  onRetry?: () => void;
}

export function OpenRouterSignIn({ onKeyChanged, signInError, onRetry }: OpenRouterSignInProps) {
  const [starting, setStarting] = useState(false);
  const [startError, setStartError] = useState<string | null>(null);
  const hasSessionKey = openrouterByok.hasSessionKey();

  const handleSignIn = async () => {
    setStarting(true);
    setStartError(null);
    onRetry?.();
    try {
      // Redirects the page away on success — this call does not
      // resolve in the normal case. It only returns (and rethrows)
      // when minting the authorize URL itself fails, e.g. offline.
      await beginSignIn();
    } catch (e) {
      setStarting(false);
      setStartError(
        e instanceof Error ? e.message : 'Could not start OpenRouter sign-in.',
      );
    }
  };

  const handleRemember = (checked: boolean) => {
    if (!checked) return; // one-way promote; unchecking is a no-op
    openrouterByok.promoteToLocal();
    onKeyChanged();
  };

  const error = startError ?? signInError ?? null;

  return (
    <div className="flex flex-col gap-2 pt-1">
      <button
        type="button"
        onClick={() => void handleSignIn()}
        disabled={starting}
        className={`rounded-md border border-[#2a2a35] px-3 py-2 text-[13px] font-medium text-soft-white transition-colors ${
          starting ? 'opacity-50 cursor-not-allowed' : 'hover:border-slate-gray cursor-pointer'
        }`}
      >
        {starting ? 'Redirecting to OpenRouter…' : 'Sign in with OpenRouter'}
      </button>
      {error ? <span className="text-[12px] text-red-400">{error}</span> : null}
      {hasSessionKey ? (
        <label className="flex items-center gap-2 text-[12px] text-slate-gray">
          <input
            type="checkbox"
            className="accent-soft-white"
            onChange={(e) => handleRemember(e.target.checked)}
          />
          Remember on this device (stores the key in localStorage instead of
          just this session)
        </label>
      ) : null}
    </div>
  );
}
