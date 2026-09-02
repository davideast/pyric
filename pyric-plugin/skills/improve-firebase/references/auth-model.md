# Firebase Auth Model

Authentication answers who the user is; Security Rules answer what that
identity may do. Deliver a model that connects sign-in flows, users, claims,
profile data, and rule behavior — not just SDK call names.

## Steps

1. **Map identities.** Name anonymous users, signed-in users, owners, members,
   admins/claim-holders, disabled users, deleted users, linked-provider users,
   and any service/admin actors. Complete when every access boundary has a
   named identity.

2. **Choose provider flows.** Provider configuration lives in the Firebase
   console and, for the sandbox, in Studio; the tool surface does not read or
   change it. Create the identity each flow produces with `auth_users.create`,
   confirm what the store holds with `auth_users.list`, and read the rules and
   recent denials with `sandbox.inspect`. Complete when every provider in the
   model has a creation, sign-in, and error path.

3. **Design auth state.** Auth-state observation is the source of truth;
   synchronous current-user access is a nullable convenience (null while auth
   initializes and after sign-out). Complete when the model covers signed-out,
   pending, signed-in, sign-out, and stale-session states.

4. **Connect UID to data.** `uid` is the stable bridge from Authentication to
   Firestore, RTDB, and Storage. Decide where profile docs live, which
   document IDs use `uid`, which profile fields are public vs private, and
   which display fields are duplicated. Complete when every rule that reads
   `request.auth.uid` or a claim has a matching data shape.

5. **Plan claims and roles.** Custom claims carry coarse global roles;
   document data carries membership, ownership, and resource-specific roles.
   Rules read claims through `request.auth.token.<name>`. Complete when
   claims and document roles neither duplicate nor contradict each other.

6. **Plan fixtures.** Define test users — UIDs, providers, claims, disabled
   state — and the profile/membership docs each rule branch needs. Seed the
   users with `auth_users.import` (claims and the disabled flag ride each
   record) and the documents with `firestore_data.add` /
   `firestore_data.batch_write` (or `database_data.set`). Complete when each
   rule branch has a matching identity fixture.

7. **Verify auth-dependent rules.** Exercise signed-out, owner, other-user,
   member, claim-holder, invalid-claim, missing-profile, and disabled cases
   with `firestore_rules.simulate` (set the auth context per case) and a
   `firestore_rules.test` suite — `pyric.verify_cases` generates
   the case list; use `database_rules.simulate` for RTDB paths. Complete when
   the answer names verified behavior and remaining unverified assumptions.

## Reference — auth design rules

- Account creation and sign-in are different flows; handle creation errors
  where they occur.
- OAuth redirect flows need redirect-result handling; ongoing state still
  comes from auth-state observation.
- Account linking resolves multiple providers into one user; design collision
  and recovery paths.
- Users must never grant themselves roles or claims through writable profile
  fields — rules must protect profile create/update shape.
- Client SDK actions are scoped to the current user; Admin/server SDK actions
  manage all users and bypass Security Rules. Keep admin credentials pointed
  at a sandbox unless production is explicitly intended.

## Rule connections

- `request.auth == null` — signed-out behavior.
- `request.auth.uid` — owner and path-identity checks.
- `request.auth.token.<name>` — custom claims; keep resource-specific or
  fast-changing membership out of claims.

## Scope honesty

`auth_users` creates, imports, lists, updates, and deletes user records in
the connected sandbox and replaces their claims; `auth_users.custom_token`
followed by a sign-in puts the claims on the token the rules engine reads.
Records never include passwords. Provider configuration, authorised domains,
and multi-factor state are not on the tool surface. When a finding depends on
production user records, verify with the Admin SDK or console and say which
evidence was used.

## Output shape

1. Identity model: actors, providers, account states, claims, disabled/deleted
   behavior.
2. Data mapping: UID-based paths, profile docs, public/private fields,
   duplicated identity fields.
3. Access matrix: identity × operation × resource.
4. Fixture plan: users, claims, provider states, profile docs.
5. Verification results.
6. Risks, assumptions, next steps.
