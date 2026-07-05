import { useState, type FormEvent, type ReactNode } from 'react';
import type { HelperState, NewIdentitySpec, SandboxIdentity } from '../controller.js';
import { validateSerializedClaims } from '../claims.js';
import { providerLabel } from '../providers.js';

export interface AuthSignInHelperProps {
  /** Snapshot from `useAuthFlowHelper`. Renders nothing while
   *  `state.request` is null. */
  state: HelperState;
  /** Settle with an existing identity (wire to the hook's `pick`). */
  onPick: (uid: string) => void;
  /** Create + sign in as a new identity (wire to the hook's `add`). */
  onAdd: (spec: NewIdentitySpec) => void;
  /** Dismiss the flow (wire to the hook's `cancel`). Rejects the app's
   *  sign-in promise with `auth/popup-closed-by-user`. */
  onCancel: () => void;
  /**
   * Optional renderer for an account row's content. Default renders
   * the display name (or email, or uid) plus the email when both
   * exist. The row button + data attributes stay owned by the
   * component; this slot only fills the button's children.
   */
  renderAccount?: (identity: SandboxIdentity) => ReactNode;
  /** Heading text. Default: `Sign in with <provider label>`. */
  title?: ReactNode;
  /** Optional helper text rendered under the title
   *  (`[data-pyric-helper-description]`). Default: none. */
  description?: ReactNode;
  /** Prefill for the add-account form (e.g. a host-suggested email).
   *  Read once on mount; `claims` is the raw textarea JSON text. */
  initialValues?: { email?: string; displayName?: string; claims?: string };
  className?: string;
}

/**
 * Headless emulator-style sign-in helper: an account picker over the
 * sandbox's known identities plus an add-account form (email, display
 * name, custom-claims JSON with emulator-grade validation messages).
 *
 * Ships zero styling. Structure is addressable via the
 * `data-pyric-*` contract:
 *
 * - root: `[data-pyric-ui="auth-signin-helper"]`,
 *   `[data-pyric-provider-id]`, `[data-pyric-auth-type]`
 * - picker: `[data-pyric-account-list]` > `[data-pyric-account-entry]`
 *   > `button[data-pyric-account-pick]`
 * - form: `form[data-pyric-add-account-form]`, fields
 *   `[data-pyric-field="email" | "display-name" | "claims"]`,
 *   `[data-pyric-claims-error]` (role=alert),
 *   `button[data-pyric-cancel]`, `button[data-pyric-submit]`
 *
 * Positioning is the consumer's job — render it inside your own modal
 * or panel (the flow is host-UI-agnostic; only `onCancel` carries the
 * popup-closed semantics).
 */
export function AuthSignInHelper({
  state,
  onPick,
  onAdd,
  onCancel,
  renderAccount,
  title,
  description,
  initialValues,
  className,
}: AuthSignInHelperProps) {
  const [email, setEmail] = useState(initialValues?.email ?? '');
  const [displayName, setDisplayName] = useState(initialValues?.displayName ?? '');
  const [claims, setClaims] = useState(initialValues?.claims ?? '');
  const [claimsError, setClaimsError] = useState<string | null>(null);

  if (!state.request) return null;
  const { providerId, authType } = state.request;
  const label = providerLabel(providerId);

  const reset = () => {
    setEmail('');
    setDisplayName('');
    setClaims('');
    setClaimsError(null);
  };

  const cancel = () => {
    onCancel();
    reset();
  };

  const submit = (e: FormEvent) => {
    e.preventDefault();
    const result = validateSerializedClaims(claims);
    if (!result.ok) {
      setClaimsError(result.message);
      return;
    }
    if (!email.trim()) return;
    onAdd({
      email: email.trim(),
      displayName: displayName.trim() || undefined,
      customClaims: result.claims,
    });
    reset();
  };

  return (
    <section
      className={className}
      data-pyric-ui="auth-signin-helper"
      data-pyric-provider-id={providerId}
      data-pyric-auth-type={authType}
      aria-label={`Sign in with ${label}`}
    >
      <header data-pyric-helper-header>
        <h2 data-pyric-helper-title>{title ?? `Sign in with ${label}`}</h2>
        {description != null && <p data-pyric-helper-description>{description}</p>}
      </header>

      {state.identities.length > 0 && (
        <ul data-pyric-account-list>
          {state.identities.map((identity) => (
            <li
              key={identity.uid}
              data-pyric-account-entry
              data-pyric-account-uid={identity.uid}
              data-pyric-provider-id={identity.providerId}
            >
              <button
                type="button"
                data-pyric-account-pick
                onClick={() => {
                  onPick(identity.uid);
                  reset();
                }}
              >
                {renderAccount ? (
                  renderAccount(identity)
                ) : (
                  <>
                    <span data-pyric-account-name>
                      {identity.displayName || identity.email || identity.uid}
                    </span>
                    {identity.email && identity.displayName ? (
                      <span data-pyric-account-email>{identity.email}</span>
                    ) : null}
                  </>
                )}
              </button>
            </li>
          ))}
        </ul>
      )}

      <form data-pyric-add-account-form onSubmit={submit}>
        <input
          type="email"
          data-pyric-field="email"
          aria-label="Email"
          placeholder="email@example.com"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
        />
        <input
          type="text"
          data-pyric-field="display-name"
          aria-label="Display name (optional)"
          placeholder="Display name (optional)"
          value={displayName}
          onChange={(e) => setDisplayName(e.target.value)}
        />
        <textarea
          data-pyric-field="claims"
          data-pyric-claims-invalid={claimsError != null ? '' : undefined}
          aria-label="Custom claims (optional)"
          aria-invalid={claimsError != null || undefined}
          placeholder={'Enter valid json, e.g. {"role":"admin"}'}
          value={claims}
          onChange={(e) => {
            setClaims(e.target.value);
            setClaimsError(null);
          }}
        />
        {claimsError != null && (
          <p role="alert" data-pyric-claims-error>
            {claimsError}
          </p>
        )}
        <footer data-pyric-helper-actions>
          <button type="button" data-pyric-cancel onClick={cancel}>
            Cancel
          </button>
          <button type="submit" data-pyric-submit disabled={!email.trim()}>
            Sign in
          </button>
        </footer>
      </form>
    </section>
  );
}
