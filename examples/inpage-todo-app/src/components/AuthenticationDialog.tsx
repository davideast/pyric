import React, { useState } from 'react';

interface AuthenticationDialogProps {
  isOpen: boolean;
  onClose: () => void;
  onSignInEmail: (email: string, pass: string) => Promise<void>;
  onSignInGoogle: () => Promise<void>;
  onSignInGuest: () => Promise<void>;
}

export const AuthenticationDialog: React.FC<AuthenticationDialogProps> = ({
  isOpen,
  onClose,
  onSignInEmail,
  onSignInGoogle,
  onSignInGuest,
}) => {
  const [tab, setTab] = useState<'signin' | 'signup'>('signin');
  const [email, setEmail] = useState('alice@example.com');
  const [password, setPassword] = useState('password');
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  if (!isOpen) return null;

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!email || !password) return;
    setErrorMsg(null);
    try {
      await onSignInEmail(email, password);
      onClose();
    } catch (err: any) {
      setErrorMsg(err.message || 'Authentication failed');
    }
  };

  const fillDemoLogin = (demoEmail: string, demoPass: string) => {
    setEmail(demoEmail);
    setPassword(demoPass);
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 p-4 backdrop-blur-sm select-text cursor-default">
      <div className="w-full max-w-md rounded-2xl bg-zinc-900 border border-zinc-800 p-6 shadow-2xl flex flex-col gap-6 max-h-[90vh] overflow-y-auto">
        <div className="flex items-center justify-between">
          <h2 className="text-lg font-bold text-white">Workspace Authentication</h2>
          <button
            type="button"
            onClick={onClose}
            className="text-zinc-400 hover:text-white font-bold text-xl leading-none"
          >
            &times;
          </button>
        </div>

        {/* Quick Seeded Profiles */}
        <div className="flex flex-col gap-2.5 p-4 rounded-xl bg-zinc-950 border border-zinc-800 text-xs">
          <strong className="text-zinc-300 font-bold">Quick-Login Seeded Sandbox Profiles:</strong>
          <div className="grid grid-cols-2 gap-2">
            <button
              type="button"
              onClick={() => fillDemoLogin('alice@example.com', 'password')}
              className="p-2.5 rounded-lg bg-zinc-900 hover:bg-zinc-800 border border-zinc-700 text-left transition-colors flex flex-col gap-1"
            >
              <strong className="text-white text-xs">👩‍💻 Alice</strong>
              <span className="text-[10px] text-emerald-400 font-mono">Workspace Owner</span>
            </button>
            <button
              type="button"
              onClick={() => fillDemoLogin('bob@example.com', 'password')}
              className="p-2.5 rounded-lg bg-zinc-900 hover:bg-zinc-800 border border-zinc-700 text-left transition-colors flex flex-col gap-1"
            >
              <strong className="text-white text-xs">👨‍💻 Bob</strong>
              <span className="text-[10px] text-blue-400 font-mono">Lead Collaborator</span>
            </button>
          </div>
        </div>

        <div className="flex items-center gap-2 bg-zinc-950 p-1 rounded-lg border border-zinc-800 text-xs font-semibold">
          <button
            type="button"
            onClick={() => {
              setTab('signin');
              setErrorMsg(null);
            }}
            className={`flex-1 py-1.5 rounded-md transition-all ${tab === 'signin' ? 'bg-zinc-800 text-white font-bold shadow-sm' : 'text-zinc-400 hover:text-white'}`}
          >
            Sign In
          </button>
          <button
            type="button"
            onClick={() => {
              setTab('signup');
              setErrorMsg(null);
            }}
            className={`flex-1 py-1.5 rounded-md transition-all ${tab === 'signup' ? 'bg-zinc-800 text-white font-bold shadow-sm' : 'text-zinc-400 hover:text-white'}`}
          >
            Register
          </button>
        </div>

        <form onSubmit={handleSubmit} className="flex flex-col gap-4">
          {errorMsg ? (
            <div className="p-3 rounded-lg bg-red-500/15 border border-red-500/30 text-red-400 text-xs font-semibold">
              {errorMsg}
            </div>
          ) : null}

          <div className="flex flex-col gap-1.5">
            <label className="text-xs font-semibold text-zinc-400">Email Address</label>
            <input
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="alice@example.com"
              className="h-10 rounded-lg border border-zinc-800 bg-zinc-950 px-3.5 text-xs text-white focus:outline-none focus:border-zinc-500"
              required
            />
          </div>

          <div className="flex flex-col gap-1.5">
            <label className="text-xs font-semibold text-zinc-400">Password</label>
            <input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="Password"
              className="h-10 rounded-lg border border-zinc-800 bg-zinc-950 px-3.5 text-xs text-white focus:outline-none focus:border-zinc-500"
              required
            />
          </div>

          <button
            type="submit"
            className="h-10 w-full rounded-lg bg-white text-zinc-950 hover:bg-zinc-200 font-bold text-sm transition-colors shadow-md"
          >
            {tab === 'signin' ? 'Submit Sign In' : 'Register Sandbox Profile'}
          </button>
        </form>

        <div className="flex flex-col gap-2 pt-2 border-t border-zinc-800">
          <button
            type="button"
            onClick={() => {
              onSignInGoogle().then(onClose);
            }}
            className="h-10 w-full rounded-lg bg-zinc-800 hover:bg-zinc-700 text-white font-semibold text-xs border border-zinc-700 transition-colors flex items-center justify-center gap-2"
          >
            <span>Sign In via Simulated Google OAuth</span>
          </button>
          <button
            type="button"
            onClick={() => {
              onSignInGuest().then(onClose);
            }}
            className="h-10 w-full rounded-lg bg-zinc-950 hover:bg-zinc-900 text-zinc-300 font-semibold text-xs border border-zinc-800 transition-colors"
          >
            Continue as Guest Profile
          </button>
        </div>
      </div>
    </div>
  );
};
