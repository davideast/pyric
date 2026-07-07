/**
 * Preview sign-in helper — the emulator-style account picker + add-account
 * form that opens when an app in the preview calls `signInWithPopup` /
 * `signInWithRedirect`. Thin playground skin over `@pyric/ui/auth`:
 * `useAuthFlowHelper` installs the resolver on the sandbox auth handle
 * (paired effect, StrictMode-safe) and `<AuthSignInHelper>` renders the
 * headless picker/form. The dark styling lives in `styles/global.css`
 * under `[data-pyric-ui='auth-signin-helper']` — the library ships none.
 * Backdrop/Escape cancel the flow with the faithful
 * `auth/popup-closed-by-user`.
 */
import type { Auth } from 'pyric/auth';
import { AuthSignInHelper, providerLabel, useAuthFlowHelper } from '@pyric/ui/auth';
import { Modal } from './Modal';

export function PreviewAuthHelper({ auth }: { auth: Auth }) {
  const { state, pick, add, cancel } = useAuthFlowHelper(auth);
  if (!state.request) return null;

  return (
    <Modal
      open
      onClose={cancel}
      ariaLabel={`Sign in with ${providerLabel(state.request.providerId)}`}
    >
      <AuthSignInHelper
        state={state}
        onPick={pick}
        onAdd={add}
        onCancel={cancel}
        description={
          <>
            Preview sign-in helper — pick a test account or add one. Custom claims let you
            exercise rules gated on <code>request.auth.token.*</code>.
          </>
        }
        renderAccount={(id) => (
          <>
            <span className="flex h-8 w-8 items-center justify-center rounded-full bg-[#3a3a4a] text-xs">
              {(id.displayName || id.email || id.uid).slice(0, 1).toUpperCase()}
            </span>
            <span className="flex flex-col">
              <span>{id.displayName || id.email || id.uid}</span>
              {id.email && id.displayName && (
                <span className="text-xs text-[#9a9aa8]">{id.email}</span>
              )}
            </span>
          </>
        )}
      />
    </Modal>
  );
}
