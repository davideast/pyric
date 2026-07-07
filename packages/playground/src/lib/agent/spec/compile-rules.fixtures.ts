/**
 * Round-trip-pin specs for the rules compiler (compile-rules.roundtrip.test.ts).
 * Coffee-shop (the crossDoc/enumTransition/claim mix) lives in
 * coffee-shop.fixture.ts; these two add focused coverage the pin requires:
 *   - TEAM_TASKS_SPEC — a custom-claim authorization model (path-uid +
 *     ownerField collections, an admin claim, public-read);
 *   - DOC_REVIEW_SPEC — an enumTransition-centric model (a status machine
 *     with branching transitions + an immutable field).
 *
 * Each has ONLY enumerable conditions, so `compileRules` must emit zero
 * holes and `deriveTests` must run fully green against the compiled output.
 *
 * Test fixture module: imported by spec tests only.
 */
import type { AppSpecV1 } from './schema';

/** Custom-claim authorization: members read shared tasks, owners manage
 *  their own task docs, admins manage the workspace doc. Exercises `claim`,
 *  `owner` (ownerField), path-uid owner, public-read, deny-by-default. */
export const TEAM_TASKS_SPEC: AppSpecV1 = {
  meta: {
    title: 'Team tasks',
    assumptions: [
      'Anyone signed in can read the shared task board.',
      'A task is owned by its creator; only the owner edits or deletes it.',
      'Only admins create or delete workspace settings.',
      'Each member owns their own profile doc (profiles/{uid}).',
    ],
  },
  identities: [
    { uid: 'alice', description: 'a team member' },
    { uid: 'bob', description: 'another team member' },
    { uid: 'admin', description: 'a workspace admin', claims: { admin: true } },
  ],
  collections: [
    {
      path: 'tasks/{taskId}',
      description: 'Shared task board',
      ownerField: 'ownerId',
      fields: [
        { name: 'ownerId', type: 'string', required: true },
        { name: 'title', type: 'string', required: true },
        { name: 'done', type: 'boolean' },
      ],
    },
    {
      path: 'settings/{settingId}',
      description: 'Workspace settings — admin-only writes',
      fields: [{ name: 'value', type: 'string', required: true }],
    },
    {
      path: 'profiles/{uid}',
      description: 'Per-user profile; doc id IS the uid (path-uid owned)',
      fields: [{ name: 'displayName', type: 'string', required: true }],
    },
  ],
  access: [
    // tasks: signed-in read; owner create/update/delete.
    { collection: 'tasks/{taskId}', op: 'get', grant: [{ kind: 'authenticated' }] },
    { collection: 'tasks/{taskId}', op: 'list', grant: [{ kind: 'authenticated' }] },
    {
      collection: 'tasks/{taskId}',
      op: 'create',
      grant: [
        { kind: 'authenticated' },
        { kind: 'owner' },
        { kind: 'requiredFields', fields: ['ownerId', 'title'] },
      ],
    },
    { collection: 'tasks/{taskId}', op: 'update', grant: [{ kind: 'authenticated' }, { kind: 'owner' }] },
    { collection: 'tasks/{taskId}', op: 'delete', grant: [{ kind: 'authenticated' }, { kind: 'owner' }] },
    // settings: public read; admin-claim create/update/delete.
    { collection: 'settings/{settingId}', op: 'get', grant: [] },
    { collection: 'settings/{settingId}', op: 'list', grant: [] },
    {
      collection: 'settings/{settingId}',
      op: 'create',
      grant: [{ kind: 'authenticated' }, { kind: 'claim', name: 'admin', equals: true }],
    },
    {
      collection: 'settings/{settingId}',
      op: 'update',
      grant: [{ kind: 'authenticated' }, { kind: 'claim', name: 'admin', equals: true }],
    },
    {
      collection: 'settings/{settingId}',
      op: 'delete',
      grant: [{ kind: 'authenticated' }, { kind: 'claim', name: 'admin', equals: true }],
    },
    // profiles: path-uid owner (doc id IS the uid).
    { collection: 'profiles/{uid}', op: 'get', grant: [{ kind: 'authenticated' }] },
    {
      collection: 'profiles/{uid}',
      op: 'create',
      grant: [
        { kind: 'authenticated' },
        { kind: 'owner' },
        { kind: 'requiredFields', fields: ['displayName'] },
      ],
    },
    { collection: 'profiles/{uid}', op: 'update', grant: [{ kind: 'authenticated' }, { kind: 'owner' }] },
    // profiles list + delete are ungranted → deny-by-default.
  ],
};

/** A status-machine model: documents move through a branching review
 *  workflow, the author field is immutable, and only the owner edits.
 *  Exercises `enumTransition` (branching), `fieldImmutable`, `owner`. */
export const DOC_REVIEW_SPEC: AppSpecV1 = {
  meta: {
    title: 'Document review workflow',
    assumptions: [
      'An author creates a doc in the draft state.',
      'Status moves draft → inReview → (approved | rejected); rejected → draft.',
      'The author field never changes after creation.',
      'Only the owning author edits or reads their doc; nobody deletes docs.',
    ],
  },
  identities: [
    { uid: 'writer', description: 'the document author' },
    { uid: 'other', description: 'a different user' },
  ],
  collections: [
    {
      path: 'docs/{docId}',
      description: 'Reviewable documents',
      ownerField: 'author',
      fields: [
        { name: 'author', type: 'string', required: true, immutable: true },
        { name: 'title', type: 'string', required: true },
        {
          name: 'status',
          type: 'string',
          enum: ['draft', 'inReview', 'approved', 'rejected'],
          transitions: {
            draft: ['inReview'],
            inReview: ['approved', 'rejected'],
            rejected: ['draft'],
          },
        },
      ],
    },
  ],
  access: [
    { collection: 'docs/{docId}', op: 'get', grant: [{ kind: 'authenticated' }, { kind: 'owner' }] },
    { collection: 'docs/{docId}', op: 'list', grant: [{ kind: 'authenticated' }, { kind: 'owner' }] },
    {
      collection: 'docs/{docId}',
      op: 'create',
      grant: [
        { kind: 'authenticated' },
        { kind: 'owner' },
        { kind: 'requiredFields', fields: ['author', 'title'] },
      ],
    },
    {
      collection: 'docs/{docId}',
      op: 'update',
      grant: [
        { kind: 'authenticated' },
        { kind: 'owner' },
        { kind: 'fieldImmutable', field: 'author' },
        { kind: 'enumTransition', field: 'status' },
      ],
    },
    // docs delete is ungranted → deny-by-default.
  ],
};
