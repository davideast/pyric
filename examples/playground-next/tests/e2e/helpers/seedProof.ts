/**
 * Seed the target project's Firestore with one document the fixture
 * app will read. Without this, the live URL would render
 * "0 proof rows" — the test asserts on "1 proof rows" to confirm
 * the deploy chain produced a working app.
 *
 * Uses the Firestore REST API directly with the SA bearer (the SA
 * has `roles/datastoreUser` via its `firebase-adminsdk` role binding,
 * so writes bypass the security rules). The fixture's rule allows
 * unauthenticated reads — that's what the live page exercises.
 */

const PROOF_COLLECTION = 'proof';

export async function seedProofDoc(projectId: string, token: string): Promise<void> {
  const url =
    `https://firestore.googleapis.com/v1/projects/${projectId}` +
    `/databases/(default)/documents/${PROOF_COLLECTION}?documentId=hello`;
  const body = {
    fields: {
      active: { booleanValue: true },
      createdAt: { timestampValue: new Date().toISOString() },
      label: { stringValue: 'proof' },
    },
  };
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });
  if (!res.ok && res.status !== 409 /* already exists */) {
    const text = await res.text();
    throw new Error(`seedProofDoc failed (${res.status}): ${text}`);
  }
}
