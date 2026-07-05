/**
 * Auth surface (Pyric Studio · S-AUTH).
 *
 * The users master-detail from the design rationale, composed
 * over `@pyric/ui/auth` (NOT reimplemented):
 *   - LIST  → {@link AuthUserList} (`data-pyric-ui="auth-user-list"`), fed by
 *             {@link useAuthUsers} over the seeded sandbox `Auth` handle.
 *   - DETAIL→ {@link AuthUserForm} (`data-pyric-ui="auth-user-form"`) +
 *             {@link ClaimsField} (`data-pyric-ui="claims-field"`) for the
 *             selected user, saved through `useAuthUsers().updateUser`.
 *
 * The `Auth` handle comes from the dev-seed context ({@link useDevSeed}) so the
 * surface renders for review without a live `pyric serve`. All visual styling
 * lives in the scoped, token-only `auth.css` (imported here) and targets the
 * `data-pyric-*` contract the library emits, so the surface re-themes with the
 * shell's light/dark tokens and never restyles `@pyric/ui` itself.
 *
 * Scope note (honest): the "Sign-in methods" block is read-only: it reflects
 * `providerUserInfo` from the record. Account linking / unlink has no headless
 * seam on `AuthUserForm` today, so those affordances are presentational. The
 * filled-deny "disabled" treatment is driven by the record's `disabled` flag.
 */

import { useMemo, useState } from 'react';
import {
  AuthUserList,
  AuthUserForm,
  AuthApiProvider,
  providerLabel,
  useAuthUsers,
  type AuthUserFormSubmit,
} from '@pyric/ui/auth';
import type { Auth, AuthUserRecord } from 'pyric/auth';
import { useDevSeed } from '../../dev/DevSeedProvider.js';
import { useDataNav } from '../data/navigation.js';
import { useStudioDataSource } from '../../shell/studio-data.js';
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
  // in review, or the live worker Auth under `pyric serve --ui`. `authApi` is
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
  const body = <AuthSurfaceBody auth={auth} />;
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
    updateUser,
    deleteUser,
    clearUsers,
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
          <button
            type="button"
            className="auth-sub__clear"
            onClick={() => {
              clearUsers();
              selectUser(null);
            }}
            disabled={totalCount === 0}
          >
            Clear all
          </button>
        </div>
      </div>

      {/* Master-detail body. On mobile this drills down: the list, then the
          selected user's detail with a back affordance. */}
      <div className="auth-body" data-auth-level={selected ? 'detail' : 'list'}>
        <div className="auth-list">
          <AuthUserList
            users={users}
            isLoading={isLoading}
            error={error}
            filter={filter}
            onSelect={(u) => selectUser(u.uid)}
            renderIdentifier={renderIdentifier}
            formatDate={clockTime}
            emptyState={
              <p className="auth-zero">
                No users yet. Sign-ins from the app and agent-seeded users appear
                here.
              </p>
            }
            noResultsState={
              <p className="auth-zero">No users match “{filter}”.</p>
            }
          />
        </div>

        <div className="auth-detail">
          {selected ? (
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

/** The selected-user editor: header (who · uid) + sign-in methods + the
 *  composed `AuthUserForm` (which carries the claims/disabled/profile fields). */
function UserDetail({
  user,
  onSave,
  onDelete,
}: {
  user: AuthUserRecord;
  onSave: (submit: AuthUserFormSubmit) => void;
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

  const methods = user.providerUserInfo;
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

      {/* Sign-in methods (read-only reflection of providerUserInfo). */}
      {methods.length > 0 || user.isAnonymous ? (
        <section className="auth-methods" aria-label="Sign-in methods">
          <div className="auth-group">Sign-in methods</div>
          {methods.length === 0 && user.isAnonymous ? (
            <div className="auth-method" data-pyric-provider-id="anonymous">
              <span className="auth-method__label">Anonymous</span>
              <span className="auth-method__id">anonymous</span>
              <span className="auth-method__note">no credential</span>
            </div>
          ) : (
            methods.map((p) => (
              <div
                key={p.providerId}
                className="auth-method"
                data-pyric-provider-id={p.providerId}
              >
                <span className="auth-method__label">
                  {providerLabel(p.providerId)}
                </span>
                <span className="auth-method__id">{p.providerId}</span>
                <span className="auth-method__note">
                  {p.providerId === 'password' ? 'password set' : 'federated'}
                </span>
              </div>
            ))
          )}
        </section>
      ) : null}

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
        <button type="button" className="auth-del" onClick={onDelete}>
          Delete user
        </button>
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
