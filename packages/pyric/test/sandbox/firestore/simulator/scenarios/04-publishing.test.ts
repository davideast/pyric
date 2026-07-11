/**
 * Scenario 4: Content Publishing Pipeline
 *
 * Posts with draft/review/published/archived state machine, editor publish gate
 * via custom claims, comments restricted to published posts via get().
 * Stdlib: transitions, lifecycle, auth, membership
 *
 * Rules: examples/scenarios/04-publishing.rules
 */
import { describe, test, expect } from 'bun:test';
import { LocalEnvironment } from 'pyric/sandbox/internal';
import { resolveModules } from 'pyric/rules/internal/node';

const SOURCE = `import { validTransition } from 'transitions';
import { fieldUnchanged } from 'lifecycle';
import { isAuthenticated } from 'auth';
import { hasClaim } from 'membership';
rules_version = '2+modules';
service cloud.firestore {
  match /databases/{database}/documents {
    match /posts/{postId} {
      allow read: if true;
      allow create: if isAuthenticated()
          && request.resource.data.authorId == request.auth.uid
          && request.resource.data.status == 'draft'
          && request.resource.data.title.size() > 0;
      allow update: if isAuthenticated()
          && fieldUnchanged('authorId')
          && (
            // Author submits for review
            (resource.data.authorId == request.auth.uid
              && validTransition('status', 'draft', 'review'))
            // Editor publishes
            || (hasClaim('role_editor')
              && validTransition('status', 'review', 'published'))
            // Editor rejects back to draft
            || (hasClaim('role_editor')
              && validTransition('status', 'review', 'draft'))
            // Author or editor archives
            || ((resource.data.authorId == request.auth.uid || hasClaim('role_editor'))
              && validTransition('status', 'published', 'archived'))
            // Author edits draft content (no status change)
            || (resource.data.authorId == request.auth.uid
              && resource.data.status == 'draft'
              && request.resource.data.status == 'draft')
          );
      allow delete: if false;

      match /comments/{commentId} {
        allow read: if true;
        allow create: if isAuthenticated()
            && request.resource.data.authorId == request.auth.uid
            && request.resource.data.body.size() > 0
            && get(/databases/$(database)/documents/posts/$(postId)).data.status == 'published';
        allow update: if isAuthenticated()
            && resource.data.authorId == request.auth.uid
            && fieldUnchanged('authorId')
            && request.resource.data.body.size() > 0;
        allow delete: if isAuthenticated()
            && resource.data.authorId == request.auth.uid;
      }
    }
  }
}`;

const resolved = resolveModules(SOURCE);
if (!resolved.success) throw new Error(resolved.error.message);
const RULES = resolved.data.resolved;

describe('Scenario 4: Content Publishing Pipeline', () => {
  function makeEnv() {
    const env = new LocalEnvironment();
    env.seed({
      rules: RULES,
      documents: {
        'posts/draft1': { title: 'My Draft', authorId: 'alice', status: 'draft', body: 'Content here' },
        'posts/review1': { title: 'In Review', authorId: 'alice', status: 'review', body: 'Ready for review' },
        'posts/pub1': { title: 'Published Post', authorId: 'alice', status: 'published', body: 'Live content' },
        'posts/pub1/comments/c1': { authorId: 'bob', body: 'Great post!' },
        'posts/pub1/comments/c2': { authorId: 'carol', body: 'Nice work' },
      },
    });
    return env;
  }

  test('create draft', () => {
    const env = makeEnv();
    const r = env.execute({ method: 'create', path: 'posts/draft2', auth: { uid: 'alice' }, data: { title: 'New Post', authorId: 'alice', status: 'draft', body: 'WIP' } });
    expect(r.allowed).toBe(true);
  });

  test('submit for review', () => {
    const env = makeEnv();
    const r = env.execute({ method: 'update', path: 'posts/draft1', auth: { uid: 'alice' }, data: { title: 'My Draft', authorId: 'alice', status: 'review', body: 'Content here' } });
    expect(r.allowed).toBe(true);
  });

  test('editor publishes', () => {
    const env = makeEnv();
    const r = env.execute({ method: 'update', path: 'posts/review1', auth: { uid: 'editor1', token: { role_editor: true } }, data: { title: 'In Review', authorId: 'alice', status: 'published', body: 'Ready for review' } });
    expect(r.allowed).toBe(true);
  });

  test('archive published post', () => {
    const env = makeEnv();
    const r = env.execute({ method: 'update', path: 'posts/pub1', auth: { uid: 'alice' }, data: { title: 'Published Post', authorId: 'alice', status: 'archived', body: 'Live content' } });
    expect(r.allowed).toBe(true);
  });

  test('editor rejects to draft', () => {
    const env = makeEnv();
    const r = env.execute({ method: 'update', path: 'posts/review1', auth: { uid: 'editor1', token: { role_editor: true } }, data: { title: 'In Review', authorId: 'alice', status: 'draft', body: 'Ready for review' } });
    expect(r.allowed).toBe(true);
  });

  test('author edits draft content', () => {
    const env = makeEnv();
    const r = env.execute({ method: 'update', path: 'posts/draft1', auth: { uid: 'alice' }, data: { title: 'Updated Draft', authorId: 'alice', status: 'draft', body: 'Better content' } });
    expect(r.allowed).toBe(true);
  });

  test('comment on published post', () => {
    const env = makeEnv();
    const r = env.execute({ method: 'create', path: 'posts/pub1/comments/c3', auth: { uid: 'dave' }, data: { authorId: 'dave', body: 'Interesting read' } });
    expect(r.allowed).toBe(true);
  });

  test('edit own comment', () => {
    const env = makeEnv();
    const r = env.execute({ method: 'update', path: 'posts/pub1/comments/c1', auth: { uid: 'bob' }, data: { authorId: 'bob', body: 'Updated comment' } });
    expect(r.allowed).toBe(true);
  });

  test('author cannot self-publish', () => {
    const env = makeEnv();
    const r = env.execute({ method: 'update', path: 'posts/review1', auth: { uid: 'alice' }, data: { title: 'In Review', authorId: 'alice', status: 'published', body: 'Ready for review' } });
    expect(r.allowed).toBe(false);
  });

  test('cannot skip review', () => {
    const env = makeEnv();
    const r = env.execute({ method: 'update', path: 'posts/draft1', auth: { uid: 'alice' }, data: { title: 'My Draft', authorId: 'alice', status: 'published', body: 'Content here' } });
    expect(r.allowed).toBe(false);
  });

  test('empty title denied', () => {
    const env = makeEnv();
    const r = env.execute({ method: 'create', path: 'posts/draft3', auth: { uid: 'alice' }, data: { title: '', authorId: 'alice', status: 'draft', body: 'No title' } });
    expect(r.allowed).toBe(false);
  });

  test('authorId tamper denied', () => {
    const env = makeEnv();
    const r = env.execute({ method: 'update', path: 'posts/draft1', auth: { uid: 'alice' }, data: { title: 'My Draft', authorId: 'bob', status: 'review', body: 'Content here' } });
    expect(r.allowed).toBe(false);
  });

  test('edit other comment denied', () => {
    const env = makeEnv();
    const r = env.execute({ method: 'update', path: 'posts/pub1/comments/c1', auth: { uid: 'carol' }, data: { authorId: 'bob', body: 'Hijacked' } });
    expect(r.allowed).toBe(false);
  });

  test('comment on draft denied', () => {
    const env = makeEnv();
    const r = env.execute({ method: 'create', path: 'posts/draft1/comments/c4', auth: { uid: 'dave' }, data: { authorId: 'dave', body: 'Too early' } });
    expect(r.allowed).toBe(false);
  });

  test('unauthenticated denied', () => {
    const env = makeEnv();
    const r = env.execute({ method: 'create', path: 'posts/anon1', auth: null, data: { title: 'Anon Post', authorId: 'anon', status: 'draft', body: 'Anonymous' } });
    expect(r.allowed).toBe(false);
  });
});
