/**
 * Auth surface (Pyric Studio · S-AUTH).
 *
 * The users master-detail from the design rationale, composed
 * over `@pyric/ui/auth` (NOT reimplemented):
 *   - LIST  → {@link AuthUserList} (`data-pyric-ui="auth-user-list"`), fed by
 *             {@link useAuthUsers} over the seeded sandbox `Auth` handle.
 *   - CREATE→ an "Add user" affordance in the sub-bar disclosing the same
 *             {@link AuthUserForm} in create mode (`useAuthUsers().createUser`,
 *             i.e. the adminCreateUser op over the worker).
 *   - DETAIL→ {@link AuthUserForm} (`data-pyric-ui="auth-user-form"`) +
 *             {@link ClaimsField} (`data-pyric-ui="claims-field"`) for the
 *             selected user, saved through `useAuthUsers().updateUser`, plus
 *             an EDITABLE per-user "Sign-in providers" group: linked OAuth
 *             providers are set/unset (one or several — `providerUserInfo` is
 *             an array) through `updateUser({ providerUserInfo })`. The
 *             `password` entry is credential-derived (set a password to link
 *             it) and rendered as a fact, not a toggle.
 *
 * Project-level provider ENABLEMENT (which providers this sandbox accepts at
 * all) is deliberately NOT a surface here: the backend gating + worker ops
 * (`get/set/subscribeAuthProviderConfig`) stay wired and `AuthProviderToggles`
 * stays exported from `@pyric/ui/auth`, but Studio does not mount a toggle
 * bar — invisible fidelity.
 *
 * The `Auth` handle comes from the dev-seed context ({@link useDevSeed}) so the
 * surface renders for review without a live `pyric dev`. All visual styling
 * lives in the scoped, token-only `auth.css` (imported here) and targets the
 * `data-pyric-*` contract the library emits, so the surface re-themes with the
 * shell's light/dark tokens and never restyles `@pyric/ui` itself.
 */

import { useMemo, useState } from 'react';
import {
  AuthUserList,
  AuthUserForm,
  AuthApiProvider,
  DeleteUserWithConfirm,
  providerLabel,
  useAuthUsers,
  type AuthUserFormSubmit,
} from '@pyric/ui/auth';
import { ConfirmProvider } from '@pyric/ui/primitives';
import { FEDERATED_PROVIDER_IDS } from 'pyric/auth';
import type { Auth, AuthUserRecord, CreateUserRequest, ProviderUserInfo } from 'pyric/auth';
import { useDevSeed } from '../../dev/DevSeedProvider.js';
import { useDataNav } from '../data/navigation.js';
import { useStudioDataSource } from '../../shell/studio-data.js';
import { DeleteSelectedUsers, useVisibleUserSelection } from './auth-bulk-delete.js';
import './auth.css';

/** Compact "11m ago" / "just now" relative time for the list + detail. */
function relativeTime(iso: string | null): string {
  if (!iso) return 'never';
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return 'never';
  const secs = Math.max(0, Math.round((Date.now() - then) / 1000));
  if (secs < 45) return 'just now';
  const mins = Math.round(secs / 60);
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.round(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.round(hrs / 24);
  return `${days}d ago`;
}

/** `HH:MM` created-time, matching the mock's terse created column. */
function clockTime(iso: string | null): string {
  if (!iso) return 'unknown';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return 'unknown';
  return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

/** Identifier cell: email (or anonymous) above a mono uid, per the mock. */
function renderIdentifier(user: AuthUserRecord) {
  const anon = user.isAnonymous && !user.email;
  const primary = user.email ?? user.phoneNumber ?? (anon ? 'anonymous' : user.uid);
  return (
    <span className={anon ? 'auth-ident auth-ident--anon' : 'auth-ident'}>
      <span className="auth-ident__primary" title={primary}>
        {primary}
      </span>
      <span className="auth-ident__uid" title={user.uid}>
        {user.uid}
      </span>
    </span>
  );
}

export interface AuthSurfaceProps {
  /** Override the seeded handle (tests / a wired live env). Defaults to the
   *  dev-seed context's `Auth`. */
  auth?: Auth;
}

/**
 * The Auth surface body. Mounts at `#auth` (the orchestrator wires the route).
 * Consumes the seeded `Auth` handle from {@link useDevSeed} unless one is passed.
 */
export function AuthSurface({ auth: authProp }: AuthSurfaceProps = {}) {
  const seed = useDevSeed();
  // Source the Auth handle + ops from the unified data bridge: the dev-seed Auth
  // in review, or the live worker Auth under `pyric dev --ui`. `authApi` is
  // present only in served mode (the worker auth bundle); dev-seed leaves it
  // undefined so the default in-process `pyric/auth` API is used.
  const data = useStudioDataSource();
  const auth = authProp ?? (data.status === 'ready' ? data.handles.auth : null);
  const authApi = data.status === 'ready' ? data.authApi : undefined;

  if (!auth) {
    return (
      <div className="auth-surface" data-pyric-ui="auth-surface">
        <AuthEmpty status={seed.status} />
      </div>
    );
  }
  const body = (
    <ConfirmProvider>
      <AuthSurfaceBody auth={auth} />
    </ConfirmProvider>
  );
  return authApi ? <AuthApiProvider value={authApi}>{body}</AuthApiProvider> : body;
}

function AuthSurfaceBody({ auth }: { auth: Auth }) {
  const {
    users,
    totalCount,
    isLoading,
    error,
    filter,
    setFilter,
    createUser,
    updateUser,
    deleteUser,
  } = useAuthUsers(auth);

  const nav = useDataNav();
  // The selected user IS the URL: #auth/<uid> (see navigation.tsx). Selecting or
  // clearing writes the hash via nav.navigate, so the focused user is deep-
  // linkable, reload-persistent, and follows browser back/forward.
  const selectedUid = nav.target?.view === 'auth' ? nav.target.uid : null;
  const selectUser = (uid: string | null) => nav.navigate({ view: 'auth', uid });
  const selected = useMemo(
    () => users.find((u) => u.uid === selectedUid) ?? null,
    [users, selectedUid],
  );

  // "Add user" discloses the create form in the detail pane (one create at a
  // time; selecting a user closes it).
  const [creating, setCreating] = useState(false);
  const selection = useVisibleUserSelection(users);

  return (
    <div className="auth-surface" data-pyric-ui="auth-surface">
      {/* Sub-bar: count · filter · actions (ported from the mock's `.sub`). */}
      <div className="auth-sub">
        <span className="auth-sub__h">
          users <span className="auth-sub__n">· {totalCount}</span>
        </span>
        <input
          className="auth-sub__filter"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          placeholder="filter users…"
          aria-label="Filter users"
        />
        <div className="auth-sub__right">
          {selection.selectedUsers.length > 0 ? (
            <>
              <span className="studio-selection-count">
                {selection.selectedUsers.length} selected
              </span>
              <DeleteSelectedUsers
                users={selection.selectedUsers}
                filter={filter}
                onDelete={(uid) => Promise.resolve(deleteUser(uid))}
                onComplete={(failedUids) => {
                  selection.replace(failedUids);
                  if (selectedUid && !failedUids.includes(selectedUid)) selectUser(null);
                }}
              />
              <button
                type="button"
                className="auth-sub__clear"
                onClick={selection.clear}
              >
                Clear selection
              </button>
            </>
          ) : (
            <button
              type="button"
              className="auth-sub__add"
              onClick={() => {
                setCreating(true);
                selectUser(null);
              }}
            >
              Add user
            </button>
          )}
        </div>
      </div>

      {/* Master-detail body. On mobile this drills down: the list, then the
          selected user's detail (or the create form) with a back affordance. */}
      <div className="auth-body" data-auth-level={selected || creating ? 'detail' : 'list'}>
        <div className="auth-list">
          <AuthUserList
            users={users}
            isLoading={isLoading}
            error={error}
            filter={filter}
            onSelect={(u) => {
              setCreating(false);
              selectUser(u.uid);
            }}
            renderIdentifier={renderIdentifier}
            formatCreatedAt={clockTime}
            formatLastLoginAt={relativeTime}
            renderSelectionHeader={
              <label className="auth-select" title="Select all shown users">
                <input
                  type="checkbox"
                  aria-label="Select all shown users"
                  checked={selection.allVisibleSelected}
                  onChange={(event) => selection.selectAll(event.currentTarget.checked)}
                />
              </label>
            }
            renderSelection={(user) => (
              <label className="auth-select" title={`Select ${user.uid}`}>
                <input
                  type="checkbox"
                  aria-label={`Select ${user.uid}`}
                  checked={selection.isSelected(user.uid)}
                  onChange={() => selection.toggle(user.uid)}
                />
              </label>
            )}
            emptyState={
              <p className="auth-zero">
                No users yet. Sign-ins from the app, agent-seeded users, and
                “Add user” all land here.
              </p>
            }
            noResultsState={
              <p className="auth-zero">No users match “{filter}”.</p>
            }
          />
        </div>

        <div className="auth-detail">
          {creating ? (
            <CreateUserPanel
              onCancel={() => setCreating(false)}
              onCreate={async (request) => {
                // `createUser` is sync in-process, a Promise over the worker
                // bundle — normalize, then focus the new user (the coarse
                // subscribeUsers re-list brings it into the list).
                const record = await Promise.resolve(createUser(request));
                setCreating(false);
                selectUser(record.uid);
              }}
            />
          ) : selected ? (
            <>
              <button
                type="button"
                className="auth-back"
                onClick={() => selectUser(null)}
                aria-label="Back to users"
              >
                ‹ Users
              </button>
              <UserDetail
                key={selected.uid}
                user={selected}
                onSave={(submit) => {
                  if (submit.mode === 'edit') updateUser(submit.uid, submit.request);
                }}
                onProvidersChange={async (providers) => {
                  await Promise.resolve(
                    updateUser(selected.uid, { providerUserInfo: providers }),
                  );
                }}
                onDelete={() => {
                  deleteUser(selected.uid);
                  selectUser(null);
                }}
              />
            </>
          ) : (
            <div className="auth-detail__empty">
              <p className="auth-zero">Select a user to view and edit.</p>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

/** The "Add user" disclosure: the SAME composed form in create mode —
 *  `AuthUserForm` without `initial` emits `{ mode: 'create', request }`. */
function CreateUserPanel({
  onCreate,
  onCancel,
}: {
  onCreate: (request: CreateUserRequest) => Promise<void>;
  onCancel: () => void;
}) {
  const [createError, setCreateError] = useState<Error | null>(null);

  const handleSubmit = (submit: AuthUserFormSubmit) => {
    if (submit.mode !== 'create') return;
    setCreateError(null);
    onCreate(submit.request).catch((e) => {
      setCreateError(e instanceof Error ? e : new Error(String(e)));
    });
  };

  return (
    <div className="auth-editor" data-pyric-ui="auth-create-user">
      <div className="auth-editor__head">
        <div className="auth-editor__who">New user</div>
        <div className="auth-editor__meta">
          Created without signing in — admin semantics, like the emulator’s
          add-user flow.
        </div>
      </div>
      <AuthUserForm onSubmit={handleSubmit} onCancel={onCancel} submitLabel="Create user">
        {createError ? (
          <p className="auth-save auth-save--error" role="alert">
            {createError.message}
          </p>
        ) : null}
      </AuthUserForm>
    </div>
  );
}

/** OAuth provider ids offered as toggles — the sandbox's canonical
 *  federated set (`FEDERATED_PROVIDER_IDS` from `pyric/auth`), the same
 *  list the create form's checklist enumerates. */
const OAUTH_PROVIDER_IDS: string[] = [...FEDERATED_PROVIDER_IDS];

/**
 * Per-user provider assignment: linked OAuth providers as toggles (multiple
 * providers per user are supported — the record's `providerUserInfo` is an
 * array), plus an add-custom input for provider ids outside the known set.
 * Every change round-trips through `updateUser({ providerUserInfo })`
 * (replacement semantics; the backend preserves the credential-derived
 * `password` entry).
 */
function ProvidersEditor({
  user,
  onChange,
}: {
  user: AuthUserRecord;
  onChange: (providers: ProviderUserInfo[]) => Promise<void>;
}) {
  const [providersError, setProvidersError] = useState<Error | null>(null);
  const [customId, setCustomId] = useState('');

  const linked = user.providerUserInfo.map((p) => p.providerId);
  const hasPassword = linked.includes('password');
  const oauthLinked = linked.filter((id) => id !== 'password');
  const customLinked = oauthLinked.filter((id) => !OAUTH_PROVIDER_IDS.includes(id));

  const apply = (next: string[]) => {
    setProvidersError(null);
    onChange(next.map((providerId) => ({ providerId }))).catch((e) => {
      setProvidersError(e instanceof Error ? e : new Error(String(e)));
    });
  };
  const toggle = (id: string, on: boolean) => {
    apply(on ? [...oauthLinked, id] : oauthLinked.filter((p) => p !== id));
  };
  const addCustom = () => {
    const id = customId.trim();
    if (!id) return;
    setCustomId('');
    if (oauthLinked.includes(id)) return;
    apply([...oauthLinked, id]);
  };

  return (
    <section className="auth-providers-editor" aria-label="Sign-in providers">
      <div className="auth-group">Sign-in providers</div>
      <div className="auth-providers-editor__list">
        {[...OAUTH_PROVIDER_IDS, ...customLinked].map((id) => (
          <label key={id} className="auth-provider-row" data-pyric-provider-id={id}>
            <input
              type="checkbox"
              checked={oauthLinked.includes(id)}
              onChange={(e) => toggle(id, e.target.checked)}
            />
            <span className="auth-provider-row__label">{providerLabel(id)}</span>
            <span className="auth-provider-row__id">{id}</span>
          </label>
        ))}
      </div>
      {hasPassword || user.isAnonymous ? (
        <p className="auth-providers-editor__derived">
          {hasPassword
            ? 'Password is linked by the password credential above.'
            : 'Anonymous — the provider lives on the token, not the record.'}
        </p>
      ) : null}
      <div className="auth-provider-custom">
        <label className="auth-provider-custom__field">
          <span className="auth-provider-custom__label">Custom provider ID</span>
          <span className="auth-provider-custom__row">
            <input
              type="text"
              value={customId}
              placeholder="oidc.my-provider"
              onChange={(e) => setCustomId(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault();
                  addCustom();
                }
              }}
            />
            <button type="button" onClick={addCustom} disabled={!customId.trim()}>
              Link
            </button>
          </span>
        </label>
      </div>
      {providersError ? (
        <p className="auth-save auth-save--error" role="alert">
          {providersError.message}
        </p>
      ) : null}
    </section>
  );
}

/** The selected-user editor: header (who · uid) + editable sign-in providers
 *  + the composed `AuthUserForm` (profile + access + claims). */
function UserDetail({
  user,
  onSave,
  onProvidersChange,
  onDelete,
}: {
  user: AuthUserRecord;
  onSave: (submit: AuthUserFormSubmit) => void;
  onProvidersChange: (providers: ProviderUserInfo[]) => Promise<void>;
  onDelete: () => void;
}) {
  const [saveError, setSaveError] = useState<Error | null>(null);
  const [saved, setSaved] = useState(false);

  const handleSubmit = (submit: AuthUserFormSubmit) => {
    setSaveError(null);
    setSaved(false);
    try {
      onSave(submit);
      setSaved(true);
    } catch (e) {
      setSaveError(e instanceof Error ? e : new Error(String(e)));
    }
  };

  const created = clockTime(user.createdAt);
  const lastSeen = relativeTime(user.lastLoginAt);

  return (
    <div
      className="auth-editor"
      data-pyric-user-disabled={user.disabled ? '' : undefined}
    >
      <div className="auth-editor__head">
        <div className="auth-editor__who">
          {user.email ?? (user.isAnonymous ? 'anonymous' : user.uid)}
          {user.disabled ? (
            <span className="auth-tag-off">disabled</span>
          ) : null}
        </div>
        <div className="auth-editor__uid">uid · {user.uid}</div>
        <div className="auth-editor__meta">
          created {created} · signed in {lastSeen}
        </div>
      </div>

      <ProvidersEditor user={user} onChange={onProvidersChange} />

      {/* The composed editor form (profile + access + claims). */}
      <AuthUserForm
        key={user.uid}
        initial={user}
        onSubmit={handleSubmit}
        submitLabel="Save"
      >
        {saveError ? (
          <p className="auth-save auth-save--error" role="alert">
            {saveError.message}
          </p>
        ) : null}
        {saved ? <p className="auth-save auth-save--ok">Saved.</p> : null}
      </AuthUserForm>

      <div className="auth-editor__foot">
        <DeleteUserWithConfirm
          user={user}
          onDelete={onDelete}
          className="auth-del"
        />
      </div>
    </div>
  );
}

function AuthEmpty({ status }: { status: ReturnType<typeof useDevSeed>['status'] }) {
  const label =
    status === 'pending'
      ? 'Seeding the sandbox…'
      : status === 'error'
        ? 'The dev-seed failed. Check the console.'
        : 'No sandbox Auth handle. Run with the dev-seed (DEV) or a live env.';
  return (
    <div className="auth-detail__empty" data-pyric-ui="auth-surface-empty">
      <p className="auth-zero">{label}</p>
    </div>
  );
}
