import type { UpdateRequest, UserRecord } from 'firebase-admin/auth';
import type { Probe } from '../../rigs/types.ts';
import { withAdminAuthProbeSession } from '../../src/sdk-probe-runtime.ts';

export interface AdminUpdateUserSubject {
  createUser(properties: { uid: string; email: string; password: string }): Promise<UserRecord>;
  updateUser(uid: string, properties: UpdateRequest): Promise<UserRecord>;
  getUser(uid: string): Promise<UserRecord>;
}

function summarizeUserRecord(
  record: UserRecord,
  expectedEmail: string,
  expectedPhone: string | undefined,
): Record<string, unknown> {
  return {
    emailMatchesExpected: record.email === expectedEmail,
    emailVerified: record.emailVerified,
    displayName: record.displayName ?? null,
    photoURL: record.photoURL ?? null,
    phoneNumberMatchesExpected: record.phoneNumber === expectedPhone,
    disabled: record.disabled,
    providerIds: record.providerData.map((entry) => entry.providerId).sort(),
  };
}

function uniqueProbePhoneNumber(): string {
  const millisTail = String(Date.now()).slice(-4);
  const randTail = String(Math.floor(Math.random() * 1000)).padStart(3, '0');
  return `+1555${millisTail}${randTail}`;
}

export async function observeUpdateUserFields(
  subject: AdminUpdateUserSubject,
  uidPrefix: string,
): Promise<Record<string, unknown>> {
  const uid = `${uidPrefix}-update`;
  const missingUid = `${uidPrefix}-missing`;
  const initialEmail = `${uidPrefix}-before@example.com`;
  const updatedEmail = `${uidPrefix}-after@example.com`;
  const updatedPhone = uniqueProbePhoneNumber();

  await subject.createUser({
    uid,
    email: initialEmail,
    password: 'initial-pw-123',
  });

  const updatedRecord = await subject.updateUser(uid, {
    email: updatedEmail,
    password: 'updated-pw-456',
    emailVerified: true,
    displayName: 'Updated Name',
    photoURL: 'https://example.com/avatar.png',
    phoneNumber: updatedPhone,
    disabled: true,
  });
  const fetchedAfterUpdate = await subject.getUser(uid);

  const clearedRecord = await subject.updateUser(uid, {
    displayName: null,
    photoURL: null,
    phoneNumber: null,
    disabled: false,
  });
  const fetchedAfterClear = await subject.getUser(uid);

  let missingUserError: Record<string, unknown> = {
    threw: false,
    code: null,
  };
  try {
    await subject.updateUser(missingUid, { displayName: 'Missing' });
  } catch (error) {
    const shaped = error as { code?: unknown };
    let code: string | null = null;
    if (typeof shaped.code === 'string') {
      code = shaped.code;
    }
    missingUserError = {
      threw: true,
      code,
    };
  }

  return {
    updatedReturned: summarizeUserRecord(updatedRecord, updatedEmail, updatedPhone),
    updatedFetched: summarizeUserRecord(fetchedAfterUpdate, updatedEmail, updatedPhone),
    clearedReturned: summarizeUserRecord(clearedRecord, updatedEmail, undefined),
    clearedFetched: summarizeUserRecord(fetchedAfterClear, updatedEmail, undefined),
    missingUserError,
  };
}

export const probe: Probe = {
  rig: 'admin-auth',
  requires: ['admin-auth'],
  pendingRowLink: true,
  matrixRow: '',
  rowIds: [],
  description:
    'firebase-admin/auth updateUser(uid, properties) mutates email, password, emailVerified, displayName, photoURL, phoneNumber, and disabled, clears nullable profile and phone fields with null, updates providerData accordingly, and rejects unknown UIDs with auth/user-not-found.',
  async observe(): Promise<Record<string, unknown>> {
    return withAdminAuthProbeSession(async ({ uidPrefix, adminAuth, createProbeUser }) => {
      const subject: AdminUpdateUserSubject = {
        createUser: (properties) => createProbeUser(properties),
        updateUser: (uid, properties) => adminAuth.updateUser(uid, properties),
        getUser: (uid) => adminAuth.getUser(uid),
      };
      return observeUpdateUserFields(subject, uidPrefix);
    });
  },
};
