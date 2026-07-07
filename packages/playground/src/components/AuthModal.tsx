/**
 * Auth modal — opens from the TopBar account icon and from the
 * "Sign in for deploys" step in the autosave popover. Surface is
 * intentionally narrow: sign in with Google, or sign out. No project
 * picker, no session list — sessions live locally in the sandbox now
 * (see `~/lib/sessions/`), and deploy uses a separate project picker
 * on the Deploy tab.
 *
 * The same icon serves both pages (home + playground). One sign-in
 * covers everything that needs a `cloud-platform` access token
 * (Hosting deploy, Firestore rules deploy, IAM, future promote).
 */
import { useCallback, useEffect, useState } from 'react';
import {
  signInWithGoogle,
  signOutCurrentUser,
  useSignedInUser,
} from '~/lib/firebase/auth';
import { LOCAL_AUTH_ENABLED, probeLocalAuth } from '~/lib/auth/access-strategy';
import { Modal } from './Modal';

interface AuthModalProps {
  open: boolean;
  onClose: () => void;
}

type LocalAuth = { email: string | null; source: string };

export function AuthModal({ open, onClose }: AuthModalProps) {
  const { user, loading } = useSignedInUser();
  // When local-credential auth is enabled (dev, or a local prod preview built
  // with PUBLIC_ENABLE_LOCAL_AUTH), deploys authenticate with the machine's own
  // credentials (pyric login / ADC / service account) — no Google sign-in
  // needed. Probe for that when the modal opens; when present, show it instead
  // of the GIS sign-in button (which fails with origin_mismatch anyway).
  // `undefined` = still checking; `null` = no local credential / deployed.
  const [localAuth, setLocalAuth] = useState<LocalAuth | null | undefined>(
    LOCAL_AUTH_ENABLED ? undefined : null,
  );
  useEffect(() => {
    if (!open || !LOCAL_AUTH_ENABLED) return;
    let cancelled = false;
    void probeLocalAuth().then((id) => {
      if (!cancelled) setLocalAuth(id);
    });
    return () => {
      cancelled = true;
    };
  }, [open]);

  const checkingLocal = LOCAL_AUTH_ENABLED && localAuth === undefined;

  return (
    <Modal open={open} onClose={onClose} ariaLabel="Sign in">
      <div className="space-y-4 max-w-md">
        <header>
          <h2 className="text-[14px] font-semibold text-soft-white">
            Account
          </h2>
          <p className="mt-1 text-[12px] text-slate-gray leading-relaxed">
            {localAuth
              ? 'Local development authenticates deploys with your machine’s own credentials. Sessions are stored locally in your browser.'
              : 'Sign in with Google to deploy your app to your own Firebase project. Sessions are stored locally in your browser — no sign-in required for save.'}
          </p>
        </header>
        {checkingLocal ? (
          <p className="text-[12px] text-slate-gray">Checking local credentials…</p>
        ) : localAuth ? (
          <LocalAuthPanel email={localAuth.email} source={localAuth.source} />
        ) : loading ? (
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

function sourceLabel(source: string): string {
  if (source === 'login') return 'pyric login';
  if (source === 'adc') return 'gcloud ADC';
  if (source === 'service-account') return 'service account';
  return source;
}

function LocalAuthPanel({ email, source }: LocalAuth) {
  const label = sourceLabel(source);
  return (
    <div className="space-y-3">
      <div className="flex items-center gap-3 rounded-md border border-[#2a2a35] bg-[#0f0f17] px-3 py-2.5">
        <span className="material-symbols-outlined text-[26px] text-[#a4d4a8]">
          verified_user
        </span>
        <div className="min-w-0">
          <div className="text-[13px] text-soft-white truncate">
            Authenticated locally
          </div>
          <div className="text-[11px] font-mono text-slate-gray truncate">
            {email ? `${email} · ${label}` : label}
          </div>
        </div>
      </div>
      <p className="text-[11px] text-slate-gray leading-relaxed">
        Deploys use your machine&rsquo;s credentials ({label}) — no Google
        sign-in needed. To switch accounts: <code>pyric login</code> or{' '}
        <code>gcloud auth application-default login</code>.
      </p>
    </div>
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
