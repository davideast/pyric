/**
 * Auth sub-tab of the Firebase panel (epic plan §8 B3.1) — the
 * emulator-style user-admin view over the SANDBOX's auth user database,
 * composed from `@pyric/ui/auth` (B1/B2) against
 * the active playground runtime — SharedWorker in shared sessions,
 * in-process runner in isolated sessions — so identities created by the
 * running app, the sign-in helper, or the agent's `seed_auth_users`
 * all appear here live (coarse `subscribeUsers` re-list).
 *
 * Styling follows the house split:
 *   - The user TABLE is the headless `<AuthUserList>` skinned via its
 *     `data-pyric-*` contract in `styles/global.css` — same pattern as
 *     the Data tab's CollectionList/DocumentList.
 *   - The add/edit FORM is composed locally from `useAuthUserEditor` +
 *     `<ClaimsField>` because the canned `<AuthUserForm>` renders
 *     placeholder-only inputs with no per-field label/grouping hooks,
 *     and this panel wants visible labels (emulator-style). Submit
 *     payloads and validation come from the hook unchanged.
 */
import { useCallback, useEffect, useMemo, useState, type FormEvent, type ReactNode } from 'react';
import {
  AuthUserList,
  ClaimsField,
  ClearUsersWithConfirm,
  DeleteUserWithConfirm,
  providerLabel,
  useAuthUserEditor,
  type AuthUserFormSubmit,
} from '@pyric/ui/auth';
import type { AuthUserRecord, CreateUserRequest, UpdateUserRequest } from 'pyric/auth';
import { ConfirmProvider } from '@pyric/ui/primitives';
import { getPlaygroundRuntime } from '~/lib/sandbox/runtime';

type PanelState =
  | { kind: 'list' }
  | { kind: 'add' }
  | { kind: 'edit'; user: AuthUserRecord };

/** House input skin — mirrors PreviewAuthHelper's sign-in helper fields. */
const INPUT_CLS =
  'w-full min-w-0 rounded-lg border border-[#2a2a35] bg-transparent px-3 py-2 ' +
  'text-[13px] text-soft-white placeholder:text-slate-gray/70 outline-none ' +
  'focus:border-[#4a4a5a] transition-colors';

export function AuthTab() {
  const [users, setUsers] = useState<AuthUserRecord[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<Error | null>(null);
  const [filter, setFilter] = useState('');
  const [tick, setTick] = useState(0);
  const refresh = useCallback(() => setTick((n) => n + 1), []);
  useEffect(() => {
    let disposed = false;
    setIsLoading(true);
    void getPlaygroundRuntime().listAuthUsers()
      .then((next) => {
        if (disposed) return;
        setUsers(next);
        setError(null);
      })
      .catch((e) => {
        if (!disposed) setError(e instanceof Error ? e : new Error(String(e)));
      })
      .finally(() => {
        if (!disposed) setIsLoading(false);
      });
    const id = window.setInterval(refresh, 1000);
    return () => {
      disposed = true;
      window.clearInterval(id);
    };
  }, [refresh, tick]);

  const {
    createUser,
    updateUser,
    deleteUser,
    clearUsers,
  } = useMemo(() => ({
    createUser: async (request: CreateUserRequest) => {
      await getPlaygroundRuntime().adminCreateUser(request);
      refresh();
    },
    updateUser: async (uid: string, request: UpdateUserRequest) => {
      await getPlaygroundRuntime().adminUpdateUser(uid, request);
      refresh();
    },
    deleteUser: async (uid: string) => {
      await getPlaygroundRuntime().adminDeleteUser(uid);
      refresh();
    },
    clearUsers: async () => {
      await getPlaygroundRuntime().adminClearUsers();
      refresh();
    },
  }), [refresh]);
  const [panel, setPanel] = useState<PanelState>({ kind: 'list' });
  const [formError, setFormError] = useState<string | null>(null);

  const submit = (s: AuthUserFormSubmit): void => {
    void (async () => {
      try {
        if (s.mode === 'create') await createUser(s.request);
        else await updateUser(s.uid, s.request);
        setFormError(null);
        setPanel({ kind: 'list' });
      } catch (e) {
        // e.g. auth/uid-already-exists — keep the form open with the reason.
        setFormError(e instanceof Error ? e.message : String(e));
      }
    })();
  };
  const closeForm = (): void => {
    setFormError(null);
    setPanel({ kind: 'list' });
  };

  return (
    <ConfirmProvider>
      <div className="auth-tab flex h-full min-h-0 flex-col gap-3 overflow-y-auto custom-scrollbar bg-content-bg p-4 text-[13px] text-soft-white">
        <div className="flex items-center gap-2">
          <input
            type="search"
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            placeholder="Filter by email, uid, name…"
            className={`h-8 flex-1 py-0 ${INPUT_CLS}`}
          />
          <button
            type="button"
            onClick={() => setPanel({ kind: 'add' })}
            className="h-8 shrink-0 rounded-lg bg-[#5b5bd6] px-3 text-[12px] font-medium text-white transition-opacity hover:opacity-90"
          >
            Add user
          </button>
          <ClearUsersWithConfirm
            count={users.length}
            onClear={clearUsers}
            renderTrigger={({ onClick }) => (
              <button
                type="button"
                onClick={onClick}
                disabled={users.length === 0}
                className="h-8 shrink-0 rounded-lg border border-[#2a2a35] px-3 text-[12px] text-slate-gray transition-colors hover:border-[#3a2a2a] hover:text-[#f0a0a0] disabled:opacity-40 disabled:hover:border-[#2a2a35] disabled:hover:text-slate-gray"
              >
                Clear all
              </button>
            )}
          />
        </div>

        {error ? (
          <p className="rounded-lg border border-[#3a2a2a]/60 bg-[#3a2a2a]/20 p-3 text-[12px] text-[#f0a0a0]">
            {error.message}
          </p>
        ) : null}

        {panel.kind !== 'list' ? (
          <section className="rounded-lg border border-[#2a2a35] bg-sidebar-bg p-4">
            <h3 className="mb-3 text-[11px] font-semibold uppercase tracking-wide text-slate-gray">
              {panel.kind === 'add' ? (
                'Add user'
              ) : (
                <>
                  Edit user{' '}
                  <span className="font-mono normal-case tracking-normal text-soft-white">
                    {panel.user.uid}
                  </span>
                </>
              )}
            </h3>
            <UserEditorPanel
              key={panel.kind === 'edit' ? panel.user.uid : 'add'}
              initial={panel.kind === 'edit' ? panel.user : undefined}
              onSubmit={submit}
              onCancel={closeForm}
              submitLabel={panel.kind === 'add' ? 'Create' : 'Save'}
              error={formError}
            />
          </section>
        ) : null}

        <AuthUserList
          users={users}
          isLoading={isLoading}
          filter={filter}
          onSelect={(u) => setPanel({ kind: 'edit', user: u })}
          renderProviders={(u) => <ProviderBadges user={u} />}
          renderActions={(u) => (
            <DeleteUserWithConfirm
              user={u}
              onDelete={deleteUser}
              renderTrigger={({ onClick }) => (
                <button
                  type="button"
                  onClick={onClick}
                  className="inline-flex h-7 w-7 items-center justify-center rounded border border-transparent text-slate-gray transition-colors hover:border-[#3a2a2a] hover:text-[#f0a0a0]"
                  title={`Delete ${u.uid}`}
                >
                  ✕
                </button>
              )}
            />
          )}
          emptyState={
            <span>
              No identities yet. The list fills as the preview app signs users in,
              the sign-in helper adds accounts, or the agent seeds test users.
            </span>
          }
          noResultsState={<span>No users match this filter.</span>}
        />
      </div>
    </ConfirmProvider>
  );
}

// ---------------------------------------------------------------------------

/**
 * Provider column — federated providers as small badges, em dash for
 * password-only / anonymous accounts (emulator convention).
 */
function ProviderBadges({ user }: { user: AuthUserRecord }) {
  const federated = user.providerUserInfo.filter(
    (p) => p.providerId !== 'password' && p.providerId !== 'anonymous',
  );
  if (federated.length === 0) {
    return <span className="text-slate-gray/60">—</span>;
  }
  return (
    <span className="flex min-w-0 flex-wrap gap-1">
      {federated.map((p) => (
        <span
          key={p.providerId}
          className="inline-flex max-w-full items-center truncate rounded border border-[#2a2a35] bg-content-bg px-1.5 py-0.5 text-[11px] text-soft-white/90"
        >
          {providerLabel(p.providerId)}
        </span>
      ))}
    </span>
  );
}

// ---------------------------------------------------------------------------

interface UserEditorPanelProps {
  /** Existing record → edit mode (delta payloads); omit → create mode. */
  initial?: AuthUserRecord;
  onSubmit: (submit: AuthUserFormSubmit) => void;
  onCancel: () => void;
  submitLabel: string;
  /** Error from a failed create/update call, rendered above the actions. */
  error: string | null;
}

/**
 * Labeled add/edit-user form over `useAuthUserEditor` — same fields,
 * validation, and payload builders as `<AuthUserForm>`, but with the
 * playground's visible labels + dark-theme skin (the canned component
 * is placeholder-labeled only).
 */
function UserEditorPanel({
  initial,
  onSubmit,
  onCancel,
  submitLabel,
  error,
}: UserEditorPanelProps) {
  const editor = useAuthUserEditor(initial ? { initial } : {});
  const mode = initial ? 'edit' : 'create';
  const submittable = editor.isValid && (mode === 'create' || editor.isDirty);

  const submit = (e: FormEvent): void => {
    e.preventDefault();
    if (!submittable) return;
    if (mode === 'edit') {
      onSubmit({ mode, uid: initial!.uid, request: editor.toUpdateRequest() });
    } else {
      onSubmit({ mode, request: editor.toCreateRequest() });
    }
  };

  return (
    <form className="flex flex-col gap-3" onSubmit={submit}>
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Email" error={editor.errors.email}>
          <input
            type="email"
            className={INPUT_CLS}
            placeholder="email@example.com"
            value={editor.fields.email}
            onChange={(e) => editor.setField('email', e.target.value)}
          />
        </Field>
        <Field
          label={mode === 'edit' ? 'New password' : 'Password'}
          error={editor.errors.password}
        >
          <input
            type="password"
            className={INPUT_CLS}
            placeholder={mode === 'edit' ? 'Unchanged if empty' : 'Password'}
            value={editor.fields.password}
            onChange={(e) => editor.setField('password', e.target.value)}
          />
        </Field>
        <Field label="Display name">
          <input
            type="text"
            className={INPUT_CLS}
            placeholder="Optional"
            value={editor.fields.displayName}
            onChange={(e) => editor.setField('displayName', e.target.value)}
          />
        </Field>
        <Field label="Phone number">
          <input
            type="tel"
            className={INPUT_CLS}
            placeholder="+1 555 555 0100"
            value={editor.fields.phoneNumber}
            onChange={(e) => editor.setField('phoneNumber', e.target.value)}
          />
        </Field>
      </div>
      <Field label="Photo URL">
        <input
          type="url"
          className={INPUT_CLS}
          placeholder="https://example.com/avatar.png"
          value={editor.fields.photoUrl}
          onChange={(e) => editor.setField('photoUrl', e.target.value)}
        />
      </Field>

      <div className="flex flex-col gap-2 py-1">
        <label className="flex cursor-pointer select-none items-center gap-2 text-[13px] text-soft-white">
          <input
            type="checkbox"
            className="h-4 w-4 shrink-0 accent-[#5b5bd6]"
            checked={editor.fields.emailVerified}
            onChange={(e) => editor.setField('emailVerified', e.target.checked)}
          />
          Verified email
        </label>
        <label className="flex cursor-pointer select-none items-center gap-2 text-[13px] text-soft-white">
          <input
            type="checkbox"
            className="h-4 w-4 shrink-0 accent-[#5b5bd6]"
            checked={editor.fields.disabled}
            onChange={(e) => editor.setField('disabled', e.target.checked)}
          />
          <span>
            Disabled{' '}
            <span className="text-slate-gray">(sign-in attempts are rejected)</span>
          </span>
        </label>
      </div>

      {/* div, not <Field>'s <label>: ClaimsField's root is a <div>, which
          isn't valid label content. */}
      <div className="flex min-w-0 flex-col gap-1">
        <span className="text-[11px] uppercase tracking-wide text-slate-gray">
          Custom claims (JSON)
        </span>
        <ClaimsField
          value={editor.fields.claimsText}
          onChange={(text) => editor.setField('claimsText', text)}
          {...(editor.errors.claims != null ? { error: editor.errors.claims } : {})}
        />
      </div>

      {error ? <p className="text-[12px] text-[#f0a0a0]">{error}</p> : null}

      <footer className="flex justify-end gap-2 pt-1">
        <button
          type="button"
          onClick={onCancel}
          className="rounded-lg border border-[#2a2a35] px-4 py-2 text-[12px] text-slate-gray transition-colors hover:bg-content-bg/60 hover:text-soft-white"
        >
          Cancel
        </button>
        <button
          type="submit"
          disabled={!submittable}
          className="rounded-lg bg-[#5b5bd6] px-4 py-2 text-[12px] font-medium text-white transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-40"
        >
          {submitLabel}
        </button>
      </footer>
    </form>
  );
}

function Field({
  label,
  error,
  children,
}: {
  label: string;
  error?: string | undefined;
  children: ReactNode;
}) {
  return (
    <label className="flex min-w-0 flex-col gap-1">
      <span className="text-[11px] uppercase tracking-wide text-slate-gray">
        {label}
      </span>
      {children}
      {error != null ? (
        <span role="alert" className="text-[11px] text-[#f0a0a0]">
          {error}
        </span>
      ) : null}
    </label>
  );
}
