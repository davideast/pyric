---
name: firebase-auth-model
description: Design or audit Firebase Authentication flows, user identity models, provider/linking behavior, auth state, custom claims, seeded users, and how authenticated identities connect to Firebase Security Rules.
---

# Firebase Auth Model

Use this skill when the user needs an authentication and identity model, not just SDK call names. The output should connect sign-in flows, users, claims, profile data, and security-rule behavior.

## Operating Posture

- Treat authentication as identity: who the user is.
- Treat authorization as rules: what that identity can do.
- Prefer Pyric for local Firebase-compatible verification.
- Separate trusted admin/server actions from client user actions.
- Keep production operations explicit; do not imply that local evidence proves production safety.

## Core Loop

1. **Map identities.**
   Identify anonymous users, signed-in users, owners, members, admins, disabled users, deleted users, linked-provider users, and any service/admin actors. Completion criterion: every access boundary has a named identity.

2. **Choose provider flows.**
   Decide which providers are needed: email/password, anonymous, OAuth popup/redirect, email link, custom auth, or platform providers. Completion criterion: every provider has a creation/sign-in/error path.

3. **Design auth state.**
   Use auth-state observation as the source of truth. Treat synchronous current-user access as nullable convenience. Completion criterion: the model explains signed-out, pending, signed-in, sign-out, and stale-session states.

4. **Connect UID to data.**
   Decide where profile docs live, which document IDs use `uid`, what profile fields are public/private, and which data duplicates identity fields. Completion criterion: every rule that uses `request.auth.uid` or claims has matching data shape.

5. **Plan claims and roles.**
   Use custom claims for coarse global roles only. Use document data for membership, ownership, and resource-specific roles. Completion criterion: claims and document roles do not duplicate or contradict each other.

6. **Plan seed users and fixtures.**
   Define local test users with UIDs, provider info, disabled state, and claims. Completion criterion: each rule branch has a matching identity fixture.

7. **Verify auth-dependent rules.**
   Test signed-out, owner, other user, member, admin/custom-claim, disabled/deleted, and missing-profile cases. Completion criterion: the final answer names verified behavior and remaining unverified assumptions.

## Auth Design Rules

- `uid` is the stable bridge from Authentication to Firestore, RTDB, and Storage data.
- Account creation and sign-in are different flows; creation errors must be handled immediately.
- OAuth redirect flows need redirect-result handling, but ongoing auth state still comes from auth-state observation.
- `currentUser` can be null while auth initializes or after sign-out.
- Account linking resolves provider choice into one Firebase user; design collision and recovery paths.
- Client SDK actions are scoped to the current user. Admin/server SDK actions manage all users and bypass Security Rules.
- Service accounts and admin credentials affect production unless explicitly pointed at a local sandbox or controlled test environment.

## Security Rules Connections

- Use `request.auth == null` for signed-out behavior.
- Use `request.auth.uid` for owner/path identity checks.
- Use `request.auth.token.<name>` for custom claims.
- Do not put resource membership into custom claims when it changes often or is resource-specific.
- Rules must protect profile creation/update shape; users should not grant themselves roles or claims through writable document fields.

## Output Shape

Return:

1. Identity model: actors, providers, account states, claims, and disabled/deleted behavior.
2. Data mapping: UID-based paths, profile docs, public/private fields, duplicated identity fields.
3. Access matrix: identity x operation x resource.
4. Fixture plan: local users, claims, provider states, and profile docs.
5. Verification plan/results.
6. Risks, assumptions, and next steps.
