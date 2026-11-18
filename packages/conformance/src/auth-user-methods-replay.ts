import { deleteApp, initializeApp as initializeAdminApp } from 'pyric-admin/app';
import { getAuth as getAdminAuth } from 'pyric-admin/auth';
import type { Sandbox } from 'pyric/sandbox';
import { decodeJwtParts, deepEqualJsonValues } from './auth-user-probe-session.ts';
import type { Behavior } from './capture/sdk-scenarios/replay-comparison.ts';

export function createSandboxAdminAuthSession(sandbox: Sandbox, label: string): {
  readonly adminAuth: ReplayAdminAuth;
  cleanup(): Promise<void>;
} {
  const adminApp = initializeAdminApp(
    { sandbox, projectId: 'demo-auth-user-methods' },
    `admin-${label}-${Math.random().toString(36).slice(2, 10)}`,
  );
  const adminAuth = getAdminAuth(adminApp) as unknown as ReplayAdminAuth;
  return {
    adminAuth,
    cleanup: async () => {
      await deleteApp(adminApp);
    },
  };
}

interface ReplayUserInfo {
  readonly providerId: string;
  readonly uid: string;
  readonly displayName: string | null;
  readonly email: string | null;
  readonly phoneNumber: string | null;
  readonly photoURL: string | null;
}

interface ReplayIdTokenResult {
  readonly token: string;
  readonly authTime: string;
  readonly issuedAtTime: string;
  readonly expirationTime: string;
  readonly signInProvider: string | null;
  readonly signInSecondFactor: string | null;
  readonly claims: Record<string, unknown>;
}

interface ReplayUser {
  readonly uid: string;
  readonly email: string | null;
  readonly emailVerified: boolean;
  readonly displayName: string | null;
  readonly photoURL: string | null;
  readonly phoneNumber: string | null;
  readonly isAnonymous: boolean;
  readonly providerId: string | null;
  readonly providerData: readonly ReplayUserInfo[];
  getIdToken(forceRefresh?: boolean): Promise<string>;
  getIdTokenResult(forceRefresh?: boolean): Promise<ReplayIdTokenResult>;
}

interface ReplayAuthInstance {
  readonly currentUser: ReplayUser | null;
}

export interface ReplayClientAuthSdk {
  signInAnonymously(auth: ReplayAuthInstance): Promise<{ user: ReplayUser }>;
  signInWithEmailAndPassword(
    auth: ReplayAuthInstance,
    email: string,
    password: string,
  ): Promise<{ user: ReplayUser }>;
  signOut(auth: ReplayAuthInstance): Promise<void>;
  onAuthStateChanged(
    auth: ReplayAuthInstance,
    observer: (user: ReplayUser | null) => void,
  ): () => void;
  onIdTokenChanged(
    auth: ReplayAuthInstance,
    observer: (user: ReplayUser | null) => void,
  ): () => void;
  updateProfile(
    user: ReplayUser,
    profile: { displayName?: string | null; photoURL?: string | null },
  ): Promise<void>;
}

interface ReplayAdminUserRecord {
  readonly uid: string;
  readonly email?: string;
  readonly emailVerified: boolean;
  readonly displayName?: string;
  readonly photoURL?: string;
  readonly phoneNumber?: string;
  readonly providerData: ReadonlyArray<{
    readonly providerId: string;
    readonly uid: string;
  }>;
}

export interface ReplayAdminAuth {
  createUser(props: {
    uid: string;
    email: string;
    password: string;
    displayName?: string;
    photoURL?: string;
    phoneNumber?: string;
    emailVerified?: boolean;
  }): Promise<ReplayAdminUserRecord>;
  getUser(uid: string): Promise<ReplayAdminUserRecord>;
  updateUser(
    uid: string,
    props: {
      emailVerified?: boolean;
      displayName?: string | null;
      photoURL?: string | null;
    },
  ): Promise<ReplayAdminUserRecord>;
  setCustomUserClaims(uid: string, claims: Record<string, unknown> | null): Promise<void>;
}

export interface AuthUserMethodsReplayContext {
  readonly auth: ReplayAuthInstance;
  readonly authSdk: ReplayClientAuthSdk;
  readonly adminAuth: ReplayAdminAuth;
  nextUid(label: string): string;
  nextEmail(label: string): string;
  nextPhoneNumber(): string;
  wait(): Promise<void>;
  cleanup(): Promise<void>;
}

const PROBE_PASSWORD = 'ProbePassword!123';

export async function replayAuthUserGetIdTokenJwtStructure(
  ctx: AuthUserMethodsReplayContext,
): Promise<Behavior> {
  try {
    const uid = ctx.nextUid('jwt');
    const email = ctx.nextEmail('jwt');
    await ctx.adminAuth.createUser({
      uid,
      email,
      password: PROBE_PASSWORD,
      displayName: 'Jwt Probe',
    });

    const cred = await ctx.authSdk.signInWithEmailAndPassword(ctx.auth, email, PROBE_PASSWORD);
    const token = await cred.user.getIdToken();
    const result = await cred.user.getIdTokenResult();
    const decoded = decodeJwtParts(token);

    const headerAlg = decoded.header.alg ?? null;
    const headerTyp = decoded.header.typ ?? null;
    const hasNonEmptyKid =
      typeof decoded.header.kid === 'string' && decoded.header.kid.length > 0;
    const payloadKeysSorted = Object.keys(decoded.payload).sort();
    const resultClaimKeysSorted = Object.keys(result.claims).sort();
    const rawExp = decoded.payload.exp ?? 0;
    const rawIat = decoded.payload.iat ?? 0;
    const expMinusIatSeconds = Number(rawExp) - Number(rawIat);

    return {
      segmentCount: decoded.segmentCount,
      allSegmentsBase64Url: decoded.allSegmentsBase64Url,
      headerAlg,
      headerTyp,
      hasNonEmptyKid,
      tokenEqualsResultToken: token === result.token,
      payloadMatchesResultClaims: deepEqualJsonValues(decoded.payload, result.claims),
      payloadKeysSorted,
      resultClaimKeysSorted,
      subMatchesUid: decoded.payload.sub === uid,
      userIdMatchesUid: decoded.payload.user_id === uid,
      emailMatchesAccount: decoded.payload.email === email,
      nameClaim: decoded.payload.name ?? null,
      expMinusIatSeconds,
    };
  } finally {
    await ctx.cleanup();
  }
}

export async function replayAuthUserGetIdTokenResultClaimsShape(
  ctx: AuthUserMethodsReplayContext,
): Promise<Behavior> {
  try {
    const uid = ctx.nextUid('claims');
    const email = ctx.nextEmail('claims');
    await ctx.adminAuth.createUser({ uid, email, password: PROBE_PASSWORD });
    await ctx.adminAuth.setCustomUserClaims(uid, { role: 'editor', tier: 2 });

    const cred = await ctx.authSdk.signInWithEmailAndPassword(ctx.auth, email, PROBE_PASSWORD);
    const tokenResult = await cred.user.getIdTokenResult();
    const firebaseClaim = (tokenResult.claims.firebase ?? {}) as Record<string, unknown>;
    const parsedAuthTime = Date.parse(tokenResult.authTime);
    const parsedIssuedAt = Date.parse(tokenResult.issuedAtTime);
    const parsedExpiration = Date.parse(tokenResult.expirationTime);

    return {
      resultKeysSorted: Object.keys(tokenResult).sort(),
      tokenIsNonEmptyString:
        typeof tokenResult.token === 'string' && tokenResult.token.length > 0,
      signInProvider: tokenResult.signInProvider,
      signInSecondFactor: tokenResult.signInSecondFactor,
      authTimeValidIso: Number.isFinite(parsedAuthTime),
      issuedAtTimeValidIso: Number.isFinite(parsedIssuedAt),
      expirationTimeValidIso: Number.isFinite(parsedExpiration),
      customRoleClaim: tokenResult.claims.role ?? null,
      customTierClaim: tokenResult.claims.tier ?? null,
      subMatchesUid: tokenResult.claims.sub === uid,
      firebaseSignInProvider: firebaseClaim.sign_in_provider ?? null,
    };
  } finally {
    await ctx.cleanup();
  }
}

export async function replayAuthUserIdentityFieldsBySource(
  ctx: AuthUserMethodsReplayContext,
): Promise<Behavior> {
  try {
    const anonCred = await ctx.authSdk.signInAnonymously(ctx.auth);
    const anonymousUser = {
      uidIsNonEmptyString:
        typeof anonCred.user.uid === 'string' && anonCred.user.uid.length > 0,
      email: anonCred.user.email,
      displayName: anonCred.user.displayName,
      isAnonymous: anonCred.user.isAnonymous,
    };
    await ctx.authSdk.signOut(ctx.auth);

    const uid = ctx.nextUid('pw');
    const email = ctx.nextEmail('pw');
    await ctx.adminAuth.createUser({
      uid,
      email,
      password: PROBE_PASSWORD,
      displayName: 'Ada Lovelace',
    });
    const pwCred = await ctx.authSdk.signInWithEmailAndPassword(ctx.auth, email, PROBE_PASSWORD);
    const passwordUser = {
      uidMatchesCreated: pwCred.user.uid === uid,
      emailMatchesCreated: pwCred.user.email === email,
      displayName: pwCred.user.displayName,
      isAnonymous: pwCred.user.isAnonymous,
    };

    return {
      anonymousUser,
      passwordUser,
    };
  } finally {
    await ctx.cleanup();
  }
}

export async function replayAuthUserEmailVerifiedPassthrough(
  ctx: AuthUserMethodsReplayContext,
): Promise<Behavior> {
  try {
    const anonCred = await ctx.authSdk.signInAnonymously(ctx.auth);
    const anonymousEmailVerified = anonCred.user.emailVerified;
    const anonAdminRecord = await ctx.adminAuth.getUser(anonCred.user.uid);
    const anonymousAdminEmailVerified = anonAdminRecord.emailVerified;
    await ctx.authSdk.signOut(ctx.auth);

    const uid = ctx.nextUid('ev');
    const email = ctx.nextEmail('ev');
    await ctx.adminAuth.createUser({ uid, email, password: PROBE_PASSWORD });

    const unverifiedCred = await ctx.authSdk.signInWithEmailAndPassword(
      ctx.auth,
      email,
      PROBE_PASSWORD,
    );
    const unverifiedClientFlag = unverifiedCred.user.emailVerified;
    const unverifiedAdminFlag = (await ctx.adminAuth.getUser(uid)).emailVerified;
    await ctx.authSdk.signOut(ctx.auth);

    await ctx.adminAuth.updateUser(uid, { emailVerified: true });
    const verifiedCred = await ctx.authSdk.signInWithEmailAndPassword(
      ctx.auth,
      email,
      PROBE_PASSWORD,
    );
    const verifiedClientFlag = verifiedCred.user.emailVerified;
    const verifiedAdminFlag = (await ctx.adminAuth.getUser(uid)).emailVerified;

    return {
      anonymousEmailVerified,
      anonymousAdminEmailVerified,
      unverifiedClientFlag,
      unverifiedAdminFlag,
      verifiedClientFlag,
      verifiedAdminFlag,
    };
  } finally {
    await ctx.cleanup();
  }
}

export async function replayAuthUserPhotoPhoneAndProviderData(
  ctx: AuthUserMethodsReplayContext,
): Promise<Behavior> {
  try {
    const anonCred = await ctx.authSdk.signInAnonymously(ctx.auth);
    const anonymousShape = {
      photoURL: anonCred.user.photoURL,
      phoneNumber: anonCred.user.phoneNumber,
      providerId: anonCred.user.providerId,
      providerDataLength: anonCred.user.providerData.length,
    };
    await ctx.authSdk.signOut(ctx.auth);

    const defaultUid = ctx.nextUid('pw-default');
    const defaultEmail = ctx.nextEmail('pw-default');
    await ctx.adminAuth.createUser({
      uid: defaultUid,
      email: defaultEmail,
      password: PROBE_PASSWORD,
    });
    const defaultCred = await ctx.authSdk.signInWithEmailAndPassword(
      ctx.auth,
      defaultEmail,
      PROBE_PASSWORD,
    );
    const firstDefaultProvider = defaultCred.user.providerData[0];
    let defaultProviderEntry: Record<string, unknown> | null = null;
    if (firstDefaultProvider !== undefined) {
      defaultProviderEntry = {
        providerId: firstDefaultProvider.providerId,
        uidMatchesEmail: firstDefaultProvider.uid === defaultEmail,
        emailMatchesAccount: firstDefaultProvider.email === defaultEmail,
        displayName: firstDefaultProvider.displayName,
        photoURL: firstDefaultProvider.photoURL,
        phoneNumber: firstDefaultProvider.phoneNumber,
      };
    }
    const defaultPasswordShape = {
      photoURL: defaultCred.user.photoURL,
      phoneNumber: defaultCred.user.phoneNumber,
      providerId: defaultCred.user.providerId,
      providerDataLength: defaultCred.user.providerData.length,
      defaultProviderEntry,
    };
    await ctx.authSdk.signOut(ctx.auth);

    const richUid = ctx.nextUid('pw-rich');
    const richEmail = ctx.nextEmail('pw-rich');
    const richPhoto = 'https://example.com/avatars/grace.png';
    const richPhone = ctx.nextPhoneNumber();
    await ctx.adminAuth.createUser({
      uid: richUid,
      email: richEmail,
      password: PROBE_PASSWORD,
      displayName: 'Grace Hopper',
      photoURL: richPhoto,
      phoneNumber: richPhone,
    });
    const richCred = await ctx.authSdk.signInWithEmailAndPassword(
      ctx.auth,
      richEmail,
      PROBE_PASSWORD,
    );
    const adminRichRecord = await ctx.adminAuth.getUser(richUid);

    return {
      anonymousShape,
      defaultPasswordShape,
      configuredUserShape: {
        photoURL: richCred.user.photoURL,
        phoneNumberMatchesAssigned: richCred.user.phoneNumber === richPhone,
        providerId: richCred.user.providerId,
        clientProviderIdsSorted: richCred.user.providerData
          .map((entry) => entry.providerId)
          .sort(),
        adminProviderIdsSorted: adminRichRecord.providerData
          .map((entry) => entry.providerId)
          .sort(),
      },
    };
  } finally {
    await ctx.cleanup();
  }
}

export async function replayAuthUpdateProfileInPlaceAndPersistence(
  ctx: AuthUserMethodsReplayContext,
): Promise<Behavior> {
  try {
    const uid = ctx.nextUid('prof');
    const email = ctx.nextEmail('prof');
    await ctx.adminAuth.createUser({ uid, email, password: PROBE_PASSWORD });

    const cred = await ctx.authSdk.signInWithEmailAndPassword(ctx.auth, email, PROBE_PASSWORD);
    const heldUser = cred.user;

    let authStateFires = 0;
    let idTokenFires = 0;
    const unsubAuth = ctx.authSdk.onAuthStateChanged(ctx.auth, () => {
      authStateFires += 1;
    });
    const unsubToken = ctx.authSdk.onIdTokenChanged(ctx.auth, () => {
      idTokenFires += 1;
    });

    await ctx.wait();
    const baselineAuthStateFires = authStateFires;
    const baselineIdTokenFires = idTokenFires;

    await ctx.authSdk.updateProfile(heldUser, {
      displayName: 'Builder One',
      photoURL: 'https://example.com/avatars/builder.png',
    });
    await ctx.wait();

    const pwProvider = heldUser.providerData.find((p) => p.providerId === 'password');
    const afterSetBoth = {
      sameCurrentUserRef: ctx.auth.currentUser === heldUser,
      displayName: heldUser.displayName,
      photoURL: heldUser.photoURL,
      passwordProviderDisplayName: pwProvider?.displayName ?? null,
      passwordProviderPhotoURL: pwProvider?.photoURL ?? null,
      extraAuthStateFires: authStateFires - baselineAuthStateFires,
      extraIdTokenFires: idTokenFires - baselineIdTokenFires,
    };

    await ctx.authSdk.updateProfile(heldUser, {
      photoURL: null,
    });
    await ctx.wait();

    const adminRecord = await ctx.adminAuth.getUser(uid);
    const afterClearPhotoOnly = {
      displayName: heldUser.displayName,
      photoURL: heldUser.photoURL,
      adminDisplayName: adminRecord.displayName ?? null,
      adminPhotoURL: adminRecord.photoURL ?? null,
      extraAuthStateFiresTotal: authStateFires - baselineAuthStateFires,
    };

    unsubAuth();
    unsubToken();

    await ctx.authSdk.signOut(ctx.auth);
    const reSignedIn = await ctx.authSdk.signInWithEmailAndPassword(
      ctx.auth,
      email,
      PROBE_PASSWORD,
    );

    return {
      afterSetBoth,
      afterClearPhotoOnly,
      afterReSignIn: {
        displayName: reSignedIn.user.displayName,
        photoURL: reSignedIn.user.photoURL,
      },
    };
  } finally {
    await ctx.cleanup();
  }
}
