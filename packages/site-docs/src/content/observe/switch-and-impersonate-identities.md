---
title: "Switch and impersonate identities in development"
navLabel: "Impersonate & tenants"
group: "Observe & shape"
section: ""
order: 16
description: "Switch active users, impersonate tenant identities, and bypass Security Rules with zero page reloads."
---

# Switch and impersonate identities in development

Testing role-based access control and multi-tenant security boundaries usually requires repeatedly logging out, completing login flows with test credentials, or manually mocking JWT claims.

During local Vite development (`pyric dev` or the `pyric()` plugin), Pyric embeds an accessible impersonation dialog directly inside the runtime chip. You can switch between active sandbox users, test multi-tenant boundaries (`request.auth.token.firebase.tenant`), and toggle an administrative rules bypass without reloading the page or altering application code.

## Open the impersonation modal

1. Look for the Pyric runtime chip in the bottom-right corner of your browser window. While the application is idle, the collapsed bar displays `ready` or your active identity badge (such as `as: <uid>` or `bypass rules`).
2. Click anywhere on the bar to expand the runtime panel.
3. Select the **Identity** row (or the **Impersonate** button) to open the modal dialog.

The dialog uses the native HTML `<dialog>` element with focus containment. Pressing `Escape` or clicking the close button (`×`) dismisses the dialog and restores keyboard focus to the chip.

## Switch between sandbox users

The modal displays the current authentication status in the banner at the top, followed by a list of all sandbox users.

1. Browse the user list or type in the search box to find a user by display name, email, UID, provider, or custom claims.
2. Click any user in the list.

The application immediately switches its active identity to that user:

- **Zero page reload**: The Pyric client transport updates the active `AuthLens` without refreshing the page or restarting your components.
- **Direct auth transition**: Active `onAuthStateChanged` listeners fire immediately with the new user record. If you switch from Alice to Bob, your application transitions directly from Alice to Bob without an intermediate `null` (signed-out) flash.
- **Rules evaluation**: All subsequent Firestore and Realtime Database reads and writes evaluate against your Security Rules using the impersonated user's UID, provider data, and custom claims.

To return to a signed-out state, open the modal and click **Sign Out**.

## Filter users by role, tenant, or provider

When your sandbox contains many seeded users, use the horizontal filter chips above the search list:

- **All**: Displays all users in the local database.
- **Admins**: Isolates users holding administrative custom claims (e.g. `role: 'admin'`, `admin: true`).
- **Multi-Tenant**: Shows users scoped to an Identity Platform tenant.
- **Provider chips**: Filters by identity provider, such as `google.com`, `github.com`, or password credentials.

Selected filters combine with your search query to narrow the list instantly.

## Create a new user on the fly

If you need an identity that does not yet exist in your seed data:

1. Open the impersonation modal and click **+ Create New User**.
2. Enter the user's email address and an optional display name or password.
3. If testing multi-tenancy, specify the target **Tenant ID**.
4. To test role-based rules, provide custom claims as JSON (for example, `{"role": "editor", "department": "billing"}`).
5. Submit the form.

The new identity is created in the sandbox user database and selected as the active user immediately.

## Test multi-tenant boundaries

Firebase projects serving SaaS or enterprise customers rely on Google Cloud Identity Platform multi-tenancy. Security Rules enforce tenant isolation using the canonical claim:

```rules
request.auth.token.firebase.tenant
```

Pyric normalises tenant identity claims across the sandbox runtime and Security Rules engine:

```rules
rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /tenants/{tenantId}/workspaces/{workspaceId} {
      // Enforce strict tenant boundary isolation
      allow read, write: if request.auth != null
        && request.auth.token.firebase.tenant == tenantId;
    }
  }
}
```

When you impersonate a user assigned to tenant `tenant-acme`, Pyric populates `request.auth.token.firebase.tenant = 'tenant-acme'`. Switching to a user in `tenant-globex` causes requests targeting `/tenants/tenant-acme/...` to fail with a Security Rules denial, allowing you to test cross-tenant isolation live.

## Bypass Security Rules with Admin Mode

When building UI components before your Security Rules are fully defined, or when inspecting data structures that user rules restrict:

1. Open the impersonation modal.
2. Click **Toggle Admin Bypass**.

When Admin Mode is active:

- The collapsed runtime chip displays the badge `bypass rules`.
- Firestore and Realtime Database operations execute under an administrative lens (`mode: 'admin'`), bypassing Security Rules evaluation while preserving your local application session.
- To re-enable Security Rules enforcement, open the modal and click **Toggle Admin Bypass** again.

## Persistence across browser reloads

Active impersonation is persisted in browser storage:

- The active lens (`mode: 'as'` or `mode: 'admin'`) is stored in `sessionStorage` under the key `pyric:auth-lens`.
- Refreshing the browser tab or opening additional tabs on the same development server hydrates the saved lens automatically.
- Closing the session or clicking **Sign Out** clears the stored lens and restores the standard application session.

## Programmatic identity switching in tests

For automated test suites and seed scripts, you can switch identities directly in code using the sandbox auth namespace without interacting with the UI:

```ts
import { initializeSandbox } from 'pyric/sandbox';
import { getAuth, sandbox as authSandbox } from 'pyric/auth';

const sandbox = initializeSandbox();
const auth = getAuth(sandbox);

// Seed users with roles and tenant identifiers
authSandbox.seedUsers(auth, [
  {
    uid: 'alice',
    email: 'alice@acme.com',
    tenant: 'tenant-acme',
    customClaims: { role: 'admin' },
  },
  {
    uid: 'bob',
    email: 'bob@globex.com',
    tenant: 'tenant-globex',
    customClaims: { role: 'member' },
  },
]);

// Switch the active user synchronously in tests
authSandbox.setUser(auth, aliceUser);

// Sign out
authSandbox.setUser(auth, null);
```

Programmatic switches trigger `onAuthStateChanged` callbacks and update rules evaluation context identical to UI impersonation.
