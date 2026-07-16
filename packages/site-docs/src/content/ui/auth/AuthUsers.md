---
title: "Auth users admin — useAuthUsers, <AuthUserList>, <AuthUserForm>"
navLabel: "Auth users admin"
group: "@pyric/ui"
section: "Auth"
order: 300
---
# Auth users admin — `useAuthUsers`, `<AuthUserList>`, `<AuthUserForm>`

Emulator-style user administration for a sandbox `Auth` handle: a live
users table, an add/edit form with emulator-grade validation, and
confirm-gated destructive actions.
```ts
import {
  useAuthUsers,
  useAuthUserEditor,
  AuthUserList,
  AuthUserForm,
  ClaimsField,
  DeleteUserWithConfirm,
  ClearUsersWithConfirm,
} from '@pyric/ui/auth';
```
Sandbox-only (drives `sandbox.listUsers` / `subscribeUsers` / CRUD, which
throw `failed-precondition` on prod-backed handles — the hook surfaces
that via `error`).

## Example
```tsx
import { getAuth } from 'pyric/auth';
import { ConfirmProvider } from '@pyric/ui/primitives';
import {
  useAuthUsers,
  AuthUserList,
  AuthUserForm,
  DeleteUserWithConfirm,
  ClearUsersWithConfirm,
} from '@pyric/ui/auth';

function AuthTab({ sandbox }) {
  const auth = getAuth(sandbox);
  const users = useAuthUsers(auth);
  const [editing, setEditing] = useState();   // AuthUserRecord | 'new' | undefined

  return (
    <ConfirmProvider>
      <input
        value={users.filter}
        onChange={(e) => users.setFilter(e.target.value)}
        placeholder="Search by email, name, uid…"
      />
      <ClearUsersWithConfirm onClear={users.clearUsers} count={users.totalCount} />

      <AuthUserList
        users={users.users}
        isLoading={users.isLoading}
        error={users.error}
        filter={users.filter}
        onSelect={setEditing}
        renderActions={(u) => (
          <DeleteUserWithConfirm user={u} onDelete={users.deleteUser} />
        )}
      />

      {editing && (
        <AuthUserForm
          initial={editing === 'new' ? undefined : editing}
          onCancel={() => setEditing(undefined)}
          onSubmit={(s) => {
            if (s.mode === 'create') users.createUser(s.request);
            else users.updateUser(s.uid, s.request);
            setEditing(undefined);
          }}
        />
      )}
    </ConfirmProvider>
  );
}
```
## `useAuthUsers(auth)`

| Returns | Type | Description |
|---|---|---|
| `users` | `AuthUserRecord[]` | Filtered view. Live — any user-DB mutation (these actions, the running app's sign-ups, agent seeding) re-lists via `subscribeUsers`. |
| `totalCount` | `number` | Unfiltered count (distinguishes "no users" from "no results"). |
| `isLoading` / `error` | | Subscription state. Mutation errors **throw to the caller** instead. |
| `filter` / `setFilter` | `string` | Case-insensitive substring over uid / email / display name / phone. |
| `createUser` | `(req: CreateUserRequest) => AuthUserRecord` | |
| `updateUser` | `(uid, update: UpdateUserRequest) => AuthUserRecord` | |
| `deleteUser` / `clearUsers` / `refresh` | | |

## `useAuthUserEditor({ initial? })`

Reducer-backed form state (like `useDocumentEditor`): `{fields, errors,
isDirty, isValid, setField, reset, toCreateRequest, toUpdateRequest}`.
Validation messages match the emulator UI ("Invalid email", "Password
should be at least 6 characters", "Email is required for password
authentication", claims messages). The pure reducer
(`authUserEditorReducer`, `initAuthUserEditorState`, …) is exported for
non-React drivers.

## `<AuthUserList>` props

| Prop | Type | Description |
|---|---|---|
| `users` | `AuthUserRecord[]` | Usually `useAuthUsers().users`. |
| `isLoading` / `error` | | Loading / `role="alert"` states. |
| `filter` | `string` | Picks the zero state: "No users for this project yet" vs "No results" (`data-pyric-no-results`). |
| `onSelect` | `(user) => void` | Identifier cell becomes a button. |
| `renderIdentifier` / `renderProviders` / `renderActions` | render props | Cell overrides; actions add a trailing column. |
| `formatCreatedAt` | `(iso \| null) => ReactNode` | Created-time formatter. Default: locale date, em dash for null. |
| `formatLastLoginAt` | `(iso \| null) => ReactNode` | Last-sign-in formatter. Kept separate so consumers can render a null login as "never". |
| `emptyState` / `noResultsState` | `ReactNode` | Copy overrides. |
| `virtualizeThreshold` / `rowHeight` / `virtualizedHeight` | | Virtualizes >100 rows via `<VirtualList>`. |

Columns mirror the emulator UI: Identifier, Provider, Created, Signed In,
User UID (+ actions). Disabled accounts carry `data-pyric-user-disabled`.

## `<AuthUserForm>` props

| Prop | Type | Description |
|---|---|---|
| `initial` | `AuthUserRecord` | Edit mode (delta payloads); omit for create. |
| `onSubmit` | `(s: AuthUserFormSubmit) => void` | `{mode:'create', request}` or `{mode:'edit', uid, request}`. |
| `onCancel` | `() => void` | Renders the cancel button when present. |
| `submitLabel` / `cancelLabel` / `children` / `className` | | `children` renders before the action row (e.g. backend errors). |
| `renderField` | `(f: AuthUserFormField) => ReactNode` | Per-field layout override. `f` carries `{name, label, input, error, kind, defaultRender}` — place `f.input` anywhere (it stays wired to the editor state) or call `f.defaultRender()` to keep the stock label wrapper for fields you don't customize. Claims is not a slot field (compose `useAuthUserEditor` to move it). |

State attrs `data-pyric-mode`, `data-pyric-is-dirty`, `data-pyric-is-valid`;
fields `[data-pyric-field="email" | "password" | "display-name" |
"phone-number" | "photo-url" | "email-verified" | "disabled" | "claims"]`;
per-field `[data-pyric-field-error]` alerts. Submit is disabled while
invalid, or pristine in edit mode.

Every field is wrapped in `label[data-pyric-field-label="<name>"]`
containing a visible `span[data-pyric-label-text]` and (for email/password)
the field's error alert — so a labeled grid layout is pure CSS:
```css
[data-pyric-ui='auth-user-form'] [data-pyric-field-label] {
  display: grid;
  gap: 0.25rem;
}
/* label-less design: hide the text, lean on the placeholders */
[data-pyric-ui='auth-user-form'] [data-pyric-label-text] {
  display: none;
}
```
For layout beyond CSS reach (two-column grids with mixed groupings, custom
label/error placement), use the `renderField` slot:
```tsx
<AuthUserForm
  onSubmit={save}
  renderField={(f) =>
    f.kind === 'checkbox' ? (
      f.defaultRender()
    ) : (
      <div className="grid grid-cols-[10rem_1fr] items-center gap-2">
        <span className="text-xs uppercase">{f.label}</span>
        {f.input}
        {f.error && <p role="alert" className="col-start-2">{f.error}</p>}
      </div>
    )
  }
/>
```
## Destructive actions

`<DeleteUserWithConfirm user onDelete>` and
`<ClearUsersWithConfirm onClear count?>` require a `<ConfirmProvider>`
ancestor; both accept `title` / `body` / `confirmLabel` / `renderTrigger`.
Default triggers carry `data-pyric-destructive`.

## Gotchas

- Mutation errors (e.g. `auth/uid-already-exists`, `auth/user-not-found`)
  throw from the action — catch at the call site; the hook's `error` is
  only for subscription setup failures.
- `updateUser`'s `customClaims` replaces the whole map
  (`setCustomUserClaims` semantics); the editor's `toUpdateRequest` emits
  `{}` when the claims textarea is cleared.
- Disabled users reject sign-in with `auth/user-disabled` (faithful) —
  the table only dims them.
