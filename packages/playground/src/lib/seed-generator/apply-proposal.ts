/**
 * Apply an AI-generated SeedProposalV1 to the session sandbox.
 */
import type { CreateUserRequest } from 'pyric/auth';

import {
  applyAuthSeedUsersAsync,
  seedUserToCreateRequest,
  type AuthSeedApplyResult,
} from '~/lib/sandbox/seed-auth-apply';
import {
  applySeedAsync,
  isValidCollectionId,
  parseSeedJson,
  type AsyncAdminSeedSurface,
  type ApplyResult,
} from '~/lib/sandbox/seed-apply';

import type { SeedProposalV1 } from './schema';

export interface FirestoreApplySummary {
  collections: number;
  applied: number;
  failed: number;
  errors: Array<{ collection: string; id: string; error: string }>;
}

export interface ApplyProposalResult {
  firestore: FirestoreApplySummary;
  auth: AuthSeedApplyResult;
}

export async function applySeedProposal(
  admin: AsyncAdminSeedSurface,
  proposal: SeedProposalV1,
): Promise<ApplyProposalResult> {
  const firestoreErrors: FirestoreApplySummary['errors'] = [];
  let applied = 0;
  let failed = 0;
  let collections = 0;

  for (const [collectionId, docsValue] of Object.entries(proposal.firestore)) {
    if (!isValidCollectionId(collectionId)) {
      failed++;
      firestoreErrors.push({
        collection: collectionId,
        id: '(collection)',
        error: 'Invalid collection id.',
      });
      continue;
    }
    collections++;
    const parsed = parseSeedJson(JSON.stringify(docsValue));
    if (!parsed.ok) {
      failed++;
      firestoreErrors.push({
        collection: collectionId,
        id: '(parse)',
        error: parsed.error,
      });
      continue;
    }
    const result: ApplyResult = await applySeedAsync(admin, collectionId, parsed.docs);
    applied += result.applied;
    failed += result.failed;
    for (const err of result.errors) {
      firestoreErrors.push({ collection: collectionId, id: err.id, error: err.error });
    }
  }

  let authRequests: CreateUserRequest[] = [];
  if (proposal.auth?.length) {
    authRequests = proposal.auth.map((u) =>
      seedUserToCreateRequest({
        uid: u.uid,
        email: u.email ?? `${u.uid}@example.test`,
        password: u.password ?? `pw-${u.uid}`,
        ...(u.displayName ? { displayName: u.displayName } : {}),
        ...(u.customClaims ? { customClaims: u.customClaims } : {}),
      }),
    );
  }

  const auth = await applyAuthSeedUsersAsync(authRequests);

  return {
    firestore: { collections, applied, failed, errors: firestoreErrors },
    auth,
  };
}
