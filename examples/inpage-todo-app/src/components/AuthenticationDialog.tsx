import React, { useState } from 'react';

interface AuthenticationDialogProps {
  isOpen: boolean;
  onClose: () => void;
  onSignInEmail: (email: string, pass: string) => Promise<void>;
  onSignUpEmail: (email: string, pass: string, name?: string) => Promise<void>;
  onSignInGoogle: () => Promise<void>;
  onSignInGuest: () => Promise<void>;
}

export const AuthenticationDialog: React.FC<AuthenticationDialogProps> = ({
  isOpen,
  onClose,
  onSignInEmail,
  onSignUpEmail,
  onSignInGoogle,
  onSignInGuest,
}) => {
  const [tab, setTab] = useState<'signin' | 'signup'>('signin');

  // Sign In Form State
  const [signinEmail, setSigninEmail] = useState('alice@example.com');
  const [signinPassword, setSigninPassword] = useState('password');
  const [signinError, setSigninError] = useState<string | null>(null);

  // Sign Up Form State
  const [signupName, setSignupName] = useState('');
  const [signupEmail, setSignupEmail] = useState('');
  const [signupPassword, setSignupPassword] = useState('');
  const [signupError, setSignupError] = useState<string | null>(null);

  if (!isOpen) return null;

  const handleSignInSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!signinEmail || !signinPassword) return;
    setSigninError(null);
    try {
      await onSignInEmail(signinEmail, signinPassword);
      onClose();
    } catch (err: any) {
      setSigninError(err.message || err.code || 'Sign in failed');
    }
  };

  const handleSignUpSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!signupEmail || !signupPassword) return;
    setSignupError(null);
    try {
      await onSignUpEmail(signupEmail, signupPassword, signupName);
      onClose();
    } catch (err: any) {
      setSignupError(err.message || err.code || 'Account creation failed');
    }
  };

  const handleGoogleClick = async () => {
    try {
      await onSignInGoogle();
      onClose();
    } catch (err: any) {
      if (err.code !== 'auth/popup-closed-by-user') {
        setSigninError(err.message || 'Google OAuth sign-in failed');
      }
    }
  };

  const handleGuestClick = async () => {
    try {
      await onSignInGuest();
      onClose();
    } catch (err: any) {
      setSigninError(err.message || 'Guest sign-in failed');
    }
  };

  const fillDemoAccount = (demoEmail: string, demoPass: string) => {
    setSigninEmail(demoEmail);
    setSigninPassword(demoPass);
    setSigninError(null);
  };

  return (
    <div
      id="signin-modal"
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm p-4 select-text cursor-default"
    >
      <div className="bg-[var(--app-card)] text-[var(--app-foreground)] border border-[var(--app-border)] rounded-xl max-w-md w-full p-6 shadow-lg flex flex-col gap-5 max-h-[90vh] overflow-y-auto">
        {/* Modal Header */}
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <div className="w-2.5 h-2.5 rounded-full bg-emerald-500"></div>
            <h2 className="font-semibold text-base text-[var(--app-foreground)]">Account Authentication</h2>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="text-[var(--app-muted-foreground)] hover:text-[var(--app-foreground)] p-1 rounded-md cursor-pointer"
          >
            <svg
              className="w-4 h-4"
              xmlns="http://www.w3.org/2000/svg"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <path d="M18 6 6 18" />
              <path d="m6 6 12 12" />
            </svg>
          </button>
        </div>

        {/* Auth Tab Switcher ("Sign In" vs "Create Account") */}
        <div className="grid grid-cols-2 p-1 rounded-lg bg-[var(--app-muted)] text-[var(--app-muted-foreground)] border border-[var(--app-border)] text-xs font-medium">
          <button
            type="button"
            id="auth-tab-btn-signin"
            onClick={() => {
              setTab('signin');
              setSigninError(null);
              setSignupError(null);
            }}
            className={`py-1.5 rounded-md transition-all cursor-pointer ${
              tab === 'signin'
                ? 'bg-[var(--app-card)] text-[var(--app-foreground)] shadow-sm'
                : 'text-[var(--app-muted-foreground)] hover:text-[var(--app-foreground)]'
            }`}
          >
            Sign In
          </button>
          <button
            type="button"
            id="auth-tab-btn-signup"
            onClick={() => {
              setTab('signup');
              setSigninError(null);
              setSignupError(null);
            }}
            className={`py-1.5 rounded-md transition-all cursor-pointer ${
              tab === 'signup'
                ? 'bg-[var(--app-card)] text-[var(--app-foreground)] shadow-sm'
                : 'text-[var(--app-muted-foreground)] hover:text-[var(--app-foreground)]'
            }`}
          >
            Create Account
          </button>
        </div>

        {/* TAB PANEL 1: Traditional Sign In Form */}
        {tab === 'signin' && (
          <div id="auth-panel-signin" className="flex flex-col gap-4">
            <form id="signin-form" className="flex flex-col gap-3" onSubmit={handleSignInSubmit}>
              <div className="flex flex-col gap-1.5">
                <label htmlFor="signin-email" className="text-xs font-medium text-[var(--app-foreground)]">
                  Email Address
                </label>
                <input
                  id="signin-email"
                  type="email"
                  placeholder="name@example.com"
                  value={signinEmail}
                  onChange={(e) => setSigninEmail(e.target.value)}
                  required
                  className="h-9 w-full rounded-md border border-[var(--app-border)] bg-transparent px-3 py-1 text-xs shadow-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-[var(--app-foreground)] text-[var(--app-foreground)]"
                />
              </div>
              <div className="flex flex-col gap-1.5">
                <label htmlFor="signin-password" className="text-xs font-medium text-[var(--app-foreground)]">
                  Password
                </label>
                <input
                  id="signin-password"
                  type="password"
                  placeholder="••••••••"
                  value={signinPassword}
                  onChange={(e) => setSigninPassword(e.target.value)}
                  required
                  className="h-9 w-full rounded-md border border-[var(--app-border)] bg-transparent px-3 py-1 text-xs shadow-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-[var(--app-foreground)] text-[var(--app-foreground)]"
                />
              </div>

              {signinError ? (
                <div
                  id="signin-error"
                  className="p-2.5 rounded border border-red-500/30 bg-red-500/10 text-red-600 dark:text-red-400 text-xs"
                >
                  {signinError}
                </div>
              ) : null}

              <button
                type="submit"
                className="w-full h-9 rounded-md bg-[var(--app-foreground)] text-[var(--app-background)] font-medium text-xs hover:opacity-90 transition-opacity shadow-sm cursor-pointer"
              >
                Sign In with Email
              </button>
            </form>

            {/* Quick autofill shortcuts for testing pre-seeded demo accounts */}
            <div className="pt-1 flex items-center justify-between text-[11px] text-[var(--app-muted-foreground)]">
              <span>Demo account autofill:</span>
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={() => fillDemoAccount('alice@example.com', 'password')}
                  className="underline hover:text-[var(--app-foreground)] cursor-pointer"
                >
                  Alice (Owner)
                </button>
                <span>&bull;</span>
                <button
                  type="button"
                  onClick={() => fillDemoAccount('bob@example.com', 'password')}
                  className="underline hover:text-[var(--app-foreground)] cursor-pointer"
                >
                  Bob (Collaborator)
                </button>
              </div>
            </div>
          </div>
        )}

        {/* TAB PANEL 2: Traditional Create Account Form (Registration) */}
        {tab === 'signup' && (
          <div id="auth-panel-signup" className="flex flex-col gap-4">
            <form id="signup-form" className="flex flex-col gap-3" onSubmit={handleSignUpSubmit}>
              <div className="flex flex-col gap-1.5">
                <label htmlFor="signup-name" className="text-xs font-medium text-[var(--app-foreground)]">
                  Display Name
                </label>
                <input
                  id="signup-name"
                  type="text"
                  placeholder="Jane Doe"
                  value={signupName}
                  onChange={(e) => setSignupName(e.target.value)}
                  required
                  className="h-9 w-full rounded-md border border-[var(--app-border)] bg-transparent px-3 py-1 text-xs shadow-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-[var(--app-foreground)] text-[var(--app-foreground)]"
                />
              </div>
              <div className="flex flex-col gap-1.5">
                <label htmlFor="signup-email" className="text-xs font-medium text-[var(--app-foreground)]">
                  Email Address
                </label>
                <input
                  id="signup-email"
                  type="email"
                  placeholder="name@example.com"
                  value={signupEmail}
                  onChange={(e) => setSignupEmail(e.target.value)}
                  required
                  className="h-9 w-full rounded-md border border-[var(--app-border)] bg-transparent px-3 py-1 text-xs shadow-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-[var(--app-foreground)] text-[var(--app-foreground)]"
                />
              </div>
              <div className="flex flex-col gap-1.5">
                <label htmlFor="signup-password" className="text-xs font-medium text-[var(--app-foreground)]">
                  Password
                </label>
                <input
                  id="signup-password"
                  type="password"
                  placeholder="At least 6 characters"
                  minLength={6}
                  value={signupPassword}
                  onChange={(e) => setSignupPassword(e.target.value)}
                  required
                  className="h-9 w-full rounded-md border border-[var(--app-border)] bg-transparent px-3 py-1 text-xs shadow-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-[var(--app-foreground)] text-[var(--app-foreground)]"
                />
              </div>

              {signupError ? (
                <div
                  id="signup-error"
                  className="p-2.5 rounded border border-red-500/30 bg-red-500/10 text-red-600 dark:text-red-400 text-xs"
                >
                  {signupError}
                </div>
              ) : null}

              <button
                type="submit"
                className="w-full h-9 rounded-md bg-[var(--app-foreground)] text-[var(--app-background)] font-medium text-xs hover:opacity-90 transition-opacity shadow-sm cursor-pointer"
              >
                Create Account
              </button>
            </form>
          </div>
        )}

        {/* Divider */}
        <div className="relative flex items-center justify-center">
          <div className="absolute inset-0 flex items-center">
            <div className="w-full border-t border-[var(--app-border)]"></div>
          </div>
          <span className="relative bg-[var(--app-card)] px-2 text-[10px] uppercase text-[var(--app-muted-foreground)] font-semibold">
            Or continue with
          </span>
        </div>

        {/* Alternative Swappable Auth Options (Google OAuth & Guest Anonymous) */}
        <div className="grid grid-cols-2 gap-2.5">
          <button
            type="button"
            onClick={handleGoogleClick}
            className="flex items-center justify-center gap-2 h-9 px-3 rounded-md border border-[var(--app-border)] bg-[var(--app-card)] hover:bg-[var(--app-muted)] text-xs font-medium transition-colors cursor-pointer text-[var(--app-foreground)]"
          >
            <svg className="w-3.5 h-3.5 shrink-0" viewBox="0 0 24 24">
              <path
                fill="#4285F4"
                d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z"
              />
              <path
                fill="#34A853"
                d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"
              />
              <path
                fill="#FBBC05"
                d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.06H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.94l2.85-2.22.81-.63z"
              />
              <path
                fill="#EA4335"
                d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.06l3.66 2.84c.87-2.6 3.3-4.52 6.16-4.52z"
              />
            </svg>
            Google
          </button>
          <button
            type="button"
            onClick={handleGuestClick}
            className="flex items-center justify-center gap-2 h-9 px-3 rounded-md border border-[var(--app-border)] bg-[var(--app-card)] hover:bg-[var(--app-muted)] text-xs font-medium transition-colors cursor-pointer text-[var(--app-foreground)]"
          >
            <svg
              className="w-3.5 h-3.5 text-[var(--app-muted-foreground)]"
              xmlns="http://www.w3.org/2000/svg"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <path d="M19 21v-2a4 4 0 0 0-4-4H9a4 4 0 0 0-4 4v2" />
              <circle cx="12" cy="7" r="4" />
            </svg>
            Guest
          </button>
        </div>

        <div className="flex justify-end pt-2 border-t border-[var(--app-border)]">
          <button
            type="button"
            onClick={onClose}
            className="px-4 py-1.5 rounded-md border border-[var(--app-border)] bg-[var(--app-muted)] hover:bg-[var(--app-card)] text-xs font-medium transition-colors cursor-pointer text-[var(--app-foreground)]"
          >
            Close
          </button>
        </div>
      </div>
    </div>
  );
};
