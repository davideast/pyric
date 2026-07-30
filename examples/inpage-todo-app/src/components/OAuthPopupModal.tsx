import React, { useState } from 'react';

export interface OAuthUserItem {
  uid: string;
  email: string | null;
  displayName: string | null;
}

interface OAuthPopupModalProps {
  isOpen: boolean;
  users: OAuthUserItem[];
  onSelectUser: (uid: string) => void;
  onCreateUser: (name: string, email: string, customUid?: string) => Promise<void>;
  onDeleteUser: (uid: string) => void;
  onCancel: () => void;
}

export const OAuthPopupModal: React.FC<OAuthPopupModalProps> = ({
  isOpen,
  users,
  onSelectUser,
  onCreateUser,
  onDeleteUser,
  onCancel,
}) => {
  const [tab, setTab] = useState<'existing' | 'create'>('existing');
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [customUid, setCustomUid] = useState('');
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  if (!isOpen) return null;

  const handleCreateSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!name || !email) return;
    setErrorMsg(null);
    try {
      await onCreateUser(name, email, customUid.trim() || undefined);
    } catch (err: any) {
      setErrorMsg(err.message || err.code || 'Failed to create test user');
    }
  };

  return (
    <div
      id="oauth-popup-modal"
      className="fixed inset-0 z-[60] flex items-center justify-center bg-black/60 backdrop-blur-sm p-4 select-text cursor-default"
    >
      <div className="bg-[var(--app-card)] text-[var(--app-foreground)] border border-[var(--app-border)] rounded-xl max-w-sm w-full p-6 shadow-xl flex flex-col gap-4 max-h-[90vh] overflow-y-auto">
        {/* Header */}
        <div className="flex items-center justify-between border-b border-[var(--app-border)] pb-3">
          <div className="flex items-center gap-2.5">
            <div className="inline-flex items-center justify-center w-7 h-7 rounded-full bg-white shadow-sm border border-zinc-200 shrink-0">
              <svg className="w-4 h-4" viewBox="0 0 24 24">
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
            </div>
            <div>
              <h3 className="font-semibold text-sm text-[var(--app-foreground)]">Sign in with Google</h3>
              <p className="text-[11px] text-[var(--app-muted-foreground)]">Sandbox OAuth Provider Console</p>
            </div>
          </div>
          <button
            type="button"
            onClick={onCancel}
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

        {/* OAuth View Tab Bar: Existing Accounts vs Create Test User */}
        <div className="grid grid-cols-2 p-1 rounded-lg bg-[var(--app-muted)] text-[var(--app-muted-foreground)] border border-[var(--app-border)] text-xs font-medium">
          <button
            type="button"
            id="oauth-tab-btn-existing"
            onClick={() => {
              setTab('existing');
              setErrorMsg(null);
            }}
            className={`py-1.5 rounded-md transition-all cursor-pointer ${
              tab === 'existing'
                ? 'bg-[var(--app-card)] text-[var(--app-foreground)] shadow-sm'
                : 'text-[var(--app-muted-foreground)] hover:text-[var(--app-foreground)]'
            }`}
          >
            Existing Accounts
          </button>
          <button
            type="button"
            id="oauth-tab-btn-create"
            onClick={() => {
              setTab('create');
              setErrorMsg(null);
            }}
            className={`py-1.5 rounded-md transition-all cursor-pointer ${
              tab === 'create'
                ? 'bg-[var(--app-card)] text-[var(--app-foreground)] shadow-sm'
                : 'text-[var(--app-muted-foreground)] hover:text-[var(--app-foreground)]'
            }`}
          >
            Create Test User
          </button>
        </div>

        {/* OAuth Tab 1: Existing Users List */}
        {tab === 'existing' && (
          <div id="oauth-panel-existing" className="flex flex-col gap-3">
            <div id="oauth-users-list" className="flex flex-col gap-2 max-h-56 overflow-y-auto pr-1">
              {users.length === 0 ? (
                <div className="p-6 text-center text-xs text-[var(--app-muted-foreground)] flex flex-col gap-1">
                  <p className="font-medium">No test accounts in sandbox</p>
                  <p className="text-[11px]">Click "Create Test User" above to add one.</p>
                </div>
              ) : (
                users.map((u) => (
                  <div
                    key={u.uid}
                    className="flex items-center justify-between gap-3 p-2.5 rounded-lg border border-[var(--app-border)] bg-[var(--app-card)] hover:bg-[var(--app-muted)]/50 transition-colors"
                  >
                    <div className="flex items-center gap-2.5 min-w-0 flex-1">
                      <div className="w-7 h-7 rounded-full bg-blue-600 text-white flex items-center justify-center font-bold text-xs shrink-0">
                        {(u.displayName || u.email || 'U')[0].toUpperCase()}
                      </div>
                      <div className="min-w-0 flex-1 flex flex-col gap-0.5">
                        <div className="font-medium text-xs truncate text-[var(--app-foreground)]">
                          {u.displayName || u.email || u.uid}
                        </div>
                        <div className="text-[10px] text-[var(--app-muted-foreground)] font-mono truncate">
                          {u.email || 'no-email'} &bull; uid: {u.uid}
                        </div>
                      </div>
                    </div>
                    <div className="flex items-center gap-1.5 shrink-0">
                      <button
                        type="button"
                        onClick={() => onSelectUser(u.uid)}
                        className="px-2.5 py-1 rounded bg-blue-600 hover:bg-blue-700 text-white text-[11px] font-medium transition-colors cursor-pointer"
                      >
                        Select
                      </button>
                      <button
                        type="button"
                        onClick={() => onDeleteUser(u.uid)}
                        title="Delete test user from sandbox"
                        className="p-1.5 rounded hover:bg-red-500/15 text-[var(--app-muted-foreground)] hover:text-red-600 dark:hover:text-red-400 transition-colors cursor-pointer"
                      >
                        <svg
                          className="w-3.5 h-3.5"
                          xmlns="http://www.w3.org/2000/svg"
                          viewBox="0 0 24 24"
                          fill="none"
                          stroke="currentColor"
                          strokeWidth="2"
                          strokeLinecap="round"
                          strokeLinejoin="round"
                        >
                          <path d="M3 6h18" />
                          <path d="M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6" />
                          <path d="M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2" />
                        </svg>
                      </button>
                    </div>
                  </div>
                ))
              )}
            </div>
          </div>
        )}

        {/* OAuth Tab 2: Create New Test User Form */}
        {tab === 'create' && (
          <div id="oauth-panel-create" className="flex flex-col gap-3">
            <form id="oauth-create-form" className="flex flex-col gap-2.5" onSubmit={handleCreateSubmit}>
              <div className="flex flex-col gap-1.5">
                <label htmlFor="oauth-create-name" className="text-xs font-medium text-[var(--app-foreground)]">
                  Display Name
                </label>
                <input
                  id="oauth-create-name"
                  type="text"
                  placeholder="Jane Google"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  required
                  className="h-8 w-full rounded-md border border-[var(--app-border)] bg-transparent px-2.5 text-xs shadow-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-[var(--app-foreground)] text-[var(--app-foreground)]"
                />
              </div>
              <div className="flex flex-col gap-1.5">
                <label htmlFor="oauth-create-email" className="text-xs font-medium text-[var(--app-foreground)]">
                  Google Email
                </label>
                <input
                  id="oauth-create-email"
                  type="email"
                  placeholder="jane.developer@google.com"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  required
                  className="h-8 w-full rounded-md border border-[var(--app-border)] bg-transparent px-2.5 text-xs shadow-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-[var(--app-foreground)] text-[var(--app-foreground)]"
                />
              </div>
              <div className="flex flex-col gap-1.5">
                <label htmlFor="oauth-create-uid" className="text-xs font-medium text-[var(--app-foreground)]">
                  Custom UID (Optional)
                </label>
                <input
                  id="oauth-create-uid"
                  type="text"
                  placeholder="e.g. alice (to test Owner rules)"
                  value={customUid}
                  onChange={(e) => setCustomUid(e.target.value)}
                  className="h-8 w-full rounded-md border border-[var(--app-border)] bg-transparent px-2.5 text-xs shadow-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-[var(--app-foreground)] text-[var(--app-foreground)]"
                />
              </div>

              {errorMsg ? (
                <div
                  id="oauth-create-error"
                  className="p-2 rounded border border-red-500/30 bg-red-500/10 text-red-600 dark:text-red-400 text-xs"
                >
                  {errorMsg}
                </div>
              ) : null}

              <button
                type="submit"
                className="w-full h-8 rounded-md bg-blue-600 hover:bg-blue-700 text-white font-medium text-xs transition-colors shadow-sm cursor-pointer"
              >
                Create &amp; Sign In
              </button>
            </form>
          </div>
        )}

        {/* Footer */}
        <div className="pt-2 border-t border-[var(--app-border)] flex justify-between items-center text-[10px] text-[var(--app-muted-foreground)]">
          <span>Pyric Pluggable OAuth (`AuthFlowResolver.openPopup`)</span>
          <button
            type="button"
            onClick={onCancel}
            className="px-3 py-1 rounded border border-[var(--app-border)] hover:bg-[var(--app-muted)] font-medium text-[var(--app-foreground)] cursor-pointer"
          >
            Cancel
          </button>
        </div>
      </div>
    </div>
  );
};
