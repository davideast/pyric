---
title: "<AuthSignInHelper> + useAuthFlowHelper"
navLabel: "AuthSignInHelper"
group: "@pyric/ui"
section: "Auth"
order: 290
---
# `<AuthSignInHelper>` + `useAuthFlowHelper`

Emulator-style sign-in helper for sandbox auth: when an app calls
`signInWithPopup` / `signInWithRedirect` against a sandbox `Auth` handle, the
flow parks on a helper request; this pair renders an account picker +
add-account form and settles the app's promise.

```ts
import { AuthSignInHelper, useAuthFlowHelper } from '@pyric/ui/auth';
// hook-only entry:
import { useAuthFlowHelper } from '@pyric/ui/auth/hooks';
```

Sandbox-only: the underlying controller drives `pyric/auth`'s
`sandbox.setAuthFlowResolver` seam, which throws `failed-precondition` on a
prod-backed handle.

## Example

```tsx
import { getAuth } from 'pyric/auth';
import { AuthSignInHelper, useAuthFlowHelper } from '@pyric/ui/auth';

function SignInHelper({ sandbox }) {
  const auth = getAuth(sandbox);
  const { state, pick, add, cancel } = useAuthFlowHelper(auth);
  if (!state.request) return null; // nothing in flight

  return (
    <MyModal open onClose={cancel}>
      <AuthSignInHelper
        state={state}
        onPick={pick}
        onAdd={add}
        onCancel={cancel}
        description="Pick a test account or add one."
      />
    </MyModal>
  );
}
```

The component is positioning-agnostic — wrap it in your own modal/panel.
`onCancel` rejects the app's promise with the faithful
`auth/popup-closed-by-user`.

## `useAuthFlowHelper(auth)`

Installs the resolver for the lifetime of the calling component (paired
effect; StrictMode-safe; re-targets when the `auth` handle identity changes).

| Returns | Type | Description |
|---|---|---|
| `state` | `HelperState` | `{ request, identities }` — the in-flight `AuthFlowRequest` (or `null`) + pickable sandbox identities. |
| `pick` | `(uid: string) => void` | Settle with an existing identity. |
| `add` | `(spec: NewIdentitySpec) => void` | Seed + sign in a new identity (`{email, displayName?, customClaims?}`). |
| `cancel` | `() => void` | Dismiss; rejects with `auth/popup-closed-by-user`. |

Non-React hosts can use the exported `AuthFlowController` class directly
(`install`/`uninstall`, `subscribe`/`snapshot`, `pick`/`add`/`cancel`).

## `<AuthSignInHelper>` props

| Prop | Type | Description |
|---|---|---|
| `state` | `HelperState` | From the hook. Renders `null` while `state.request` is null. |
| `onPick` | `(uid: string) => void` | Wire to the hook's `pick`. |
| `onAdd` | `(spec: NewIdentitySpec) => void` | Wire to the hook's `add`. Called with the validated form payload. |
| `onCancel` | `() => void` | Wire to the hook's `cancel`. |
| `renderAccount` | `(identity: SandboxIdentity) => ReactNode` | Optional account-row content override (the row button + data attrs stay component-owned). |
| `title` | `ReactNode` | Heading override. Default `Sign in with <provider label>`. |
| `description` | `ReactNode` | Optional helper text under the title. |
| `initialValues` | `{email?, displayName?, claims?}` | Prefill for the add form (raw JSON text for `claims`). |
| `className` | `string` | Forwarded to the root. |

## Claims validation

The add form validates the claims textarea with the same checks and messages
as the Firebase emulator UI: must be a JSON **object**, ≤ 1000 characters,
and no reserved JWT keys (`sub`, `iss`, `exp`, …). Exposed for reuse:

```ts
import { validateSerializedClaims, FORBIDDEN_CUSTOM_CLAIMS } from '@pyric/ui/auth';
```

## Provider labels

`providerLabel(providerId)` maps the emulator's provider-id set to text
(`'google.com'` → `Google`, falls back to the raw id). Hook icons or styling
off `data-pyric-provider-id` instead — the library ships no assets.

## Styling hooks

| Selector | Element |
|---|---|
| `[data-pyric-ui="auth-signin-helper"]` | Root `<section>`; carries `data-pyric-provider-id` + `data-pyric-auth-type`. |
| `[data-pyric-helper-title]` / `[data-pyric-helper-description]` | Header text. |
| `[data-pyric-account-list]` / `[data-pyric-account-entry]` | Picker list / rows (`data-pyric-account-uid`, `data-pyric-provider-id`). |
| `button[data-pyric-account-pick]` | Row button. Default children: `[data-pyric-account-name]` + `[data-pyric-account-email]`. |
| `form[data-pyric-add-account-form]` | Add-account form. |
| `[data-pyric-field="email" \| "display-name" \| "claims"]` | Inputs. The claims textarea gains `data-pyric-claims-invalid` + `aria-invalid` on error. |
| `[data-pyric-claims-error]` | `role="alert"` validation message. |
| `button[data-pyric-cancel]` / `button[data-pyric-submit]` | Actions. Submit is disabled while the email is empty. |

## Gotchas

- **One flow at a time** — a new `signInWithPopup` while one is parked
  cancels the stale request (rejects `auth/popup-closed-by-user`).
- **Tokens are host-synthesized** (`sandbox-helper-<uid>`) until the sandbox
  backend grows `createSignInCredential` (tracked follow-up); claims still
  flow into rules evaluation via the seeded identity.
- A live consumer: the playground's
  [`PreviewAuthHelper`](../../../../packages/playground/src/components/PreviewAuthHelper.tsx)
  + its `global.css` skin.
