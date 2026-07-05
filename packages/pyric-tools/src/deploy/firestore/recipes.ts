/**
 * Paste-in templates for `firestore.rules.ensure(scope, recipe)`.
 *
 * Each recipe is a single config object ready to hand to
 * `rules.ensure`. Adding a new recipe is a single object export;
 * the consumer pattern stays uniform.
 */

const PYRIC_SESSIONS_SNIPPET = `    match /pyric_sessions/{sessionId} {
      // Anyone signed in (anonymous OK) can create. Read/edit denied
      // by default — owner reads via the Firebase Console.
      allow create: if request.auth != null;
      allow read, update, delete: if false;
    }`;

const PYRIC_SESSIONS_FRESH = `rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
${PYRIC_SESSIONS_SNIPPET}
  }
}
`;

/**
 * The multi-tenant playground session-archive recipe. Allows any
 * signed-in user (anonymous OK) to write a `pyric_sessions/{id}`
 * document; read/update/delete are denied by default. The project
 * owner reads via the Firebase Console.
 *
 * Pass to `firestore.rules.ensure(scope, recipes.pyricSessions)`.
 */
export const pyricSessions = {
  marker: 'match /pyric_sessions/',
  snippet: PYRIC_SESSIONS_SNIPPET,
  freshTemplate: PYRIC_SESSIONS_FRESH,
} as const;
