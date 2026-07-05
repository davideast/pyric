/**
 * Live Auth viewer/editor (F2).
 *
 * Reuses `@pyric/ui/auth`'s `AuthUserList` over the Studio sandbox's `Auth`
 * handle (`useAuthUsers`: live `listUsers` + `subscribeUsers`). Selecting a
 * user (or arriving via a uid cross-reference) opens an inline editor backed by
 * `useAuthUserEditor`, saved through `useAuthUsers().updateUser`. Auth mutations
 * are admin operations on the sandbox by nature, so they don't need the
 * Firestore lens; the displayed uid is what Firestore docs cross-link to.
 */

import { useEffect, useState } from 'react';
import { AuthUserList, useAuthUsers, useAuthUserEditor } from '@pyric/ui/auth';
import type { Auth, AuthUserRecord } from 'pyric/auth';

const ROW = 'block w-full text-sm text-soft-white';

export interface AuthPaneProps {
  auth: Auth;
  /** A uid to focus (from a Firestore cross-reference jump). */
  focusUid: string | null;
}

export function LiveAuthPane({ auth, focusUid }: AuthPaneProps) {
  const { users, totalCount, isLoading, error, filter, setFilter, updateUser } =
    useAuthUsers(auth);
  const [selectedUid, setSelectedUid] = useState<string | null>(null);

  // Honor a cross-ref jump to a specific uid.
  useEffect(() => {
    if (focusUid) {
      setSelectedUid(focusUid);
      setFilter(focusUid);
    }
  }, [focusUid, setFilter]);

  const selected = users.find((u) => u.uid === selectedUid) ?? null;

  return (
    <div className="grid grid-cols-[1fr_320px] gap-4">
      <section className="min-w-0">
        <input
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          placeholder="Filter users…"
          className="mb-3 w-full rounded border border-border bg-content-bg px-3 py-1.5 text-sm text-soft-white placeholder:text-slate-gray"
        />
        <AuthUserList
          users={users}
          isLoading={isLoading}
          error={error}
          filter={filter}
          onSelect={(u) => setSelectedUid(u.uid)}
          className={ROW}
          emptyState={
            <p className="py-6 text-sm text-slate-gray">
              No users yet. Sign in from the app, or the agent seeds them, and they appear here.
            </p>
          }
          noResultsState={<p className="py-6 text-sm text-slate-gray">No users match the filter.</p>}
        />
        <p className="mt-2 text-xs text-slate-gray">{totalCount} user(s) total</p>
      </section>

      <section className="min-w-0 border-l border-border pl-4">
        {selected ? (
          <UserEditor
            key={selected.uid}
            user={selected}
            onSave={(update) => updateUser(selected.uid, update)}
          />
        ) : (
          <p className="py-6 text-sm text-slate-gray">Select a user to view and edit.</p>
        )}
      </section>
    </div>
  );
}

function UserEditor({
  user,
  onSave,
}: {
  user: AuthUserRecord;
  onSave: (update: ReturnType<ReturnType<typeof useAuthUserEditor>['toUpdateRequest']>) => void;
}) {
  const editor = useAuthUserEditor({ initial: user });
  const [saveError, setSaveError] = useState<Error | null>(null);
  const [saved, setSaved] = useState(false);

  const save = () => {
    setSaveError(null);
    setSaved(false);
    try {
      onSave(editor.toUpdateRequest());
      setSaved(true);
    } catch (e) {
      setSaveError(e instanceof Error ? e : new Error(String(e)));
    }
  };

  return (
    <div data-pyric-ui="auth-editor">
      <h3 className="mb-3 truncate font-mono text-xs text-slate-gray" title={user.uid}>
        {user.uid}
      </h3>
      <label className="mb-3 block text-xs text-slate-gray">
        Display name
        <input
          value={editor.fields.displayName}
          onChange={(e) => editor.setField('displayName', e.target.value)}
          className="mt-1 w-full rounded border border-border bg-content-bg px-2 py-1 text-sm text-soft-white"
        />
      </label>
      <label className="mb-3 block text-xs text-slate-gray">
        Custom claims (JSON)
        <textarea
          value={editor.fields.claimsText}
          onChange={(e) => editor.setField('claimsText', e.target.value)}
          rows={6}
          spellCheck={false}
          className="mt-1 w-full rounded border border-border bg-content-bg p-2 font-mono text-xs text-soft-white"
        />
        {editor.errors.claims ? (
          <span className="text-danger">{editor.errors.claims}</span>
        ) : null}
      </label>
      <label className="mb-3 flex items-center gap-2 text-xs text-slate-gray">
        <input
          type="checkbox"
          checked={editor.fields.disabled}
          onChange={(e) => editor.setField('disabled', e.target.checked)}
        />
        Disabled
      </label>
      {saveError ? <p className="mb-2 text-xs text-danger">{saveError.message}</p> : null}
      {saved ? <p className="mb-2 text-xs text-primary">Saved.</p> : null}
      <div className="flex gap-2">
        <button
          type="button"
          onClick={save}
          disabled={!editor.isValid || !editor.isDirty}
          className="rounded bg-primary/15 px-3 py-1 text-xs font-medium text-primary hover:bg-primary/25 disabled:opacity-40"
        >
          Save
        </button>
        <button
          type="button"
          onClick={editor.reset}
          disabled={!editor.isDirty}
          className="rounded border border-border px-3 py-1 text-xs text-slate-gray hover:text-soft-white disabled:opacity-40"
        >
          Reset
        </button>
      </div>
    </div>
  );
}
