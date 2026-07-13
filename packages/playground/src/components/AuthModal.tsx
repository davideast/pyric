/**
 * Auth modal — opens from the TopBar account icon and from the
 * account button. Surface is intentionally narrow: sign in with
 * Google, or sign out. Sessions live locally in the sandbox (see
 * `~/lib/sessions/`).
 *
 * The same icon serves both pages (home + playground). Google sign-in
 * supplies the account used by connected Firebase workflows.
 */
import { useCallback, useState } from 'react';
import {
  signInWithGoogle,
  signOutCurrentUser,
  useSignedInUser,
} from '~/lib/firebase/auth';
import { Modal } from './Modal';

interface AuthModalProps {
  open: boolean;
  onClose: () => void;
}

export function AuthModal({ open, onClose }: AuthModalProps) {
  const { user, loading } = useSignedInUser();

  return (
    <Modal open={open} onClose={onClose} ariaLabel="Sign in">
      <div className="space-y-4 max-w-md">
        <header>
          <h2 className="text-[14px] font-semibold text-soft-white">
            Account
          </h2>
          <p className="mt-1 text-[12px] text-slate-gray leading-relaxed">
            Sign in with Google to connect external workflows. Sessions are stored
            locally in your browser — no sign-in is required to save.
          </p>
        </header>
        {loading ? (
          <p className="text-[12px] text-slate-gray">Loading…</p>
        ) : user ? (
          <SignedInPanel
            email={user.email}
            name={user.name}
            picture={user.picture}
          />
        ) : (
          <SignedOutPanel />
        )}
      </div>
    </Modal>
  );
}

function SignedOutPanel() {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const handleSignIn = useCallback(async () => {
    setPending(true);
    setError(null);
    try {
      await signInWithGoogle();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setPending(false);
    }
  }, []);

  return (
    <div className="space-y-3">
      <button
        type="button"
        onClick={handleSignIn}
        disabled={pending}
        className={[
          'w-full px-4 py-2 rounded-full text-[12px] font-semibold',
          'bg-soft-white text-content-bg hover:bg-soft-white/90',
          'transition-colors disabled:opacity-60 disabled:cursor-not-allowed',
        ].join(' ')}
      >
        {pending ? 'Signing in…' : 'Sign in with Google'}
      </button>
      {error ? (
        <p className="text-[11px] font-mono text-[#f0a0a0]">{error}</p>
      ) : null}
    </div>
  );
}

interface SignedInPanelProps {
  email: string;
  name: string | null;
  picture: string | null;
}

function SignedInPanel({ email, name, picture }: SignedInPanelProps) {
  const [pending, setPending] = useState(false);
  const handleSignOut = useCallback(async () => {
    setPending(true);
    try {
      await signOutCurrentUser();
    } finally {
      setPending(false);
    }
  }, []);

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-3 rounded-md border border-[#2a2a35] bg-[#0f0f17] px-3 py-2.5">
        {picture ? (
          <img
            src={picture}
            alt=""
            className="w-9 h-9 rounded-full border border-[#2a2a35]"
            referrerPolicy="no-referrer"
          />
        ) : (
          <span className="material-symbols-outlined text-[28px] text-slate-gray">
            account_circle
          </span>
        )}
        <div className="min-w-0">
          {name ? (
            <div className="text-[13px] text-soft-white truncate">{name}</div>
          ) : null}
          <div className="text-[11px] font-mono text-slate-gray truncate">
            {email}
          </div>
        </div>
      </div>
      <button
        type="button"
        onClick={handleSignOut}
        disabled={pending}
        className={[
          'w-full px-3 py-1.5 rounded text-[11px] font-mono uppercase tracking-wider',
          'bg-[#2a2a35] hover:bg-[#3a3a48] text-soft-white',
          'transition-colors disabled:opacity-60',
        ].join(' ')}
      >
        {pending ? 'Signing out…' : 'Sign out'}
      </button>
    </div>
  );
}
