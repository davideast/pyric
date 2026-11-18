import { deleteApp as deleteAdminApp, initializeApp as initializeAdminApp } from 'pyric-admin/app';
import { getAuth as getAdminAuth } from 'pyric-admin/auth';
import type { Sandbox } from 'pyric/sandbox';
import { observeSyncAuthAttempt } from './auth-user-probe-session.ts';
import type { Behavior } from './capture/sdk-scenarios/replay-comparison.ts';

interface ReplayProviderInfo {
  readonly providerId: string;
  readonly email?: string | null;
}

interface ReplayCredentialUser {
  readonly uid: string;
  readonly isAnonymous: boolean;
  readonly providerData: readonly ReplayProviderInfo[];
}

interface ReplayUserCredential {
  readonly user: ReplayCredentialUser;
  readonly operationType?: string;
}

interface ReplayAuthCredentialInstance {
  readonly providerId: string;
  readonly signInMethod: string;
  toJSON(): Record<string, unknown>;
}

interface ReplayEmailAuthCredentialInstance extends ReplayAuthCredentialInstance {
  readonly email: string;
}

interface ReplayOAuthCredentialInstance extends ReplayAuthCredentialInstance {
  readonly idToken?: string;
  readonly accessToken?: string;
  readonly secret?: string;
}

export interface ReplayProvidersAndCredentialsAuthSdk {
  readonly AuthCredential: {
    new (providerId: string, signInMethod: string): ReplayAuthCredentialInstance;
    fromJSON(json: string | Record<string, unknown>): ReplayAuthCredentialInstance | null;
  };
  readonly EmailAuthCredential: {
    new (...args: never[]): ReplayEmailAuthCredentialInstance;
    fromJSON(json: string | Record<string, unknown>): ReplayEmailAuthCredentialInstance | null;
  };
  readonly OAuthCredential: {
    new (...args: never[]): ReplayOAuthCredentialInstance;
    fromJSON(json: string | Record<string, unknown>): ReplayOAuthCredentialInstance | null;
  };
  readonly GoogleAuthProvider: {
    readonly PROVIDER_ID: string;
    readonly GOOGLE_SIGN_IN_METHOD: string;
    new (): {
      readonly providerId: string;
      addScope(scope: string): unknown;
      setCustomParameters(params: Record<string, unknown>): unknown;
    };
    credential(idToken?: string | null, accessToken?: string | null): ReplayOAuthCredentialInstance;
    credentialFromError(error: unknown): ReplayAuthCredentialInstance | null;
  };
  readonly EmailAuthProvider: {
    readonly PROVIDER_ID: string;
    readonly EMAIL_PASSWORD_SIGN_IN_METHOD: string;
    readonly EMAIL_LINK_SIGN_IN_METHOD: string;
    new (): {
      readonly providerId: string;
    };
    credential(email: string, password: string): ReplayEmailAuthCredentialInstance;
    credentialWithLink(email: string, emailLink: string): ReplayEmailAuthCredentialInstance;
  };
  readonly FacebookAuthProvider: {
    readonly PROVIDER_ID: string;
    readonly FACEBOOK_SIGN_IN_METHOD: string;
    new (): {
      readonly providerId: string;
      addScope(scope: string): unknown;
    };
    credential(accessToken: string): ReplayOAuthCredentialInstance;
    credentialFromError(error: unknown): ReplayAuthCredentialInstance | null;
  };
  readonly GithubAuthProvider: {
    readonly PROVIDER_ID: string;
    readonly GITHUB_SIGN_IN_METHOD: string;
    new (): {
      readonly providerId: string;
      addScope(scope: string): unknown;
    };
    credential(accessToken: string): ReplayOAuthCredentialInstance;
    credentialFromError(error: unknown): ReplayAuthCredentialInstance | null;
  };
  readonly TwitterAuthProvider: {
    readonly PROVIDER_ID: string;
    readonly TWITTER_SIGN_IN_METHOD: string;
    new (): {
      readonly providerId: string;
      addScope(scope: string): unknown;
    };
    credential(token: string, secret: string): ReplayOAuthCredentialInstance;
    credentialFromError(error: unknown): ReplayAuthCredentialInstance | null;
  };
  readonly OAuthProvider: {
    new (providerId: string): {
      readonly providerId: string;
      addScope(scope: string): unknown;
      setCustomParameters(params: Record<string, unknown>): unknown;
      credential(args: {
        idToken?: string;
        accessToken?: string;
        rawNonce?: string;
      }): ReplayOAuthCredentialInstance;
    };
    credentialFromError(error: unknown): ReplayAuthCredentialInstance | null;
  };
  readonly SAMLAuthProvider: {
    new (providerId: string): {
      readonly providerId: string;
    };
    credentialFromError(error: unknown): ReplayAuthCredentialInstance | null;
  };
  signInWithCustomToken(auth: unknown, customToken: string): Promise<ReplayUserCredential>;
  signInWithCredential(
    auth: unknown,
    credential: ReplayAuthCredentialInstance,
  ): Promise<ReplayUserCredential>;
  signOut(auth: unknown): Promise<void>;
  linkWithCredential(
    user: ReplayCredentialUser,
    credential: ReplayAuthCredentialInstance,
  ): Promise<ReplayUserCredential>;
  unlink(user: ReplayCredentialUser, providerId: string): Promise<ReplayCredentialUser>;
  reload(user: ReplayCredentialUser): Promise<void>;
}

interface ReplayAdminAuth {
  createCustomToken(uid: string): Promise<string>;
}

export interface AuthProvidersAndCredentialsReplayContext {
  readonly auth: unknown;
  readonly authSdk: ReplayProvidersAndCredentialsAuthSdk;
  readonly adminAuth: ReplayAdminAuth;
  readonly FirebaseError: new (code: string, message: string) => Error;
  nextUid(label: string): string;
  nextEmail(label: string): string;
  cleanup(): Promise<void>;
}

export function createProvidersAdminSession(
  sandbox: Sandbox,
  projectId: string,
  label: string,
): {
  readonly adminAuth: ReplayAdminAuth;
  cleanup(): Promise<void>;
} {
  const adminApp = initializeAdminApp(
    { sandbox, projectId },
    `admin-providers-${label}-${Math.random().toString(36).slice(2, 10)}`,
  );
  const adminAuth = getAdminAuth(adminApp) as unknown as ReplayAdminAuth;
  return {
    adminAuth,
    cleanup: async () => {
      await deleteAdminApp(adminApp);
    },
  };
}

function nullableJson(cred: ReplayAuthCredentialInstance | null): Record<string, unknown> | null {
  if (cred === null) {
    return null;
  }
  return cred.toJSON();
}

function nullableString(value: string | undefined): string | null {
  if (value === undefined) {
    return null;
  }
  return value;
}

export async function replayAuthProviderClassesAndSamlGuard(
  ctx: AuthProvidersAndCredentialsReplayContext,
): Promise<Behavior> {
  try {
    const {
      EmailAuthProvider,
      FacebookAuthProvider,
      GithubAuthProvider,
      GoogleAuthProvider,
      OAuthProvider,
      SAMLAuthProvider,
      TwitterAuthProvider,
    } = ctx.authSdk;

    const google = new GoogleAuthProvider();
    const email = new EmailAuthProvider();
    const facebook = new FacebookAuthProvider();
    const github = new GithubAuthProvider();
    const twitter = new TwitterAuthProvider();
    const oauth = new OAuthProvider('apple.com');
    const saml = new SAMLAuthProvider('saml.corp-sso');

    const ErrCtor = ctx.FirebaseError as unknown as new (...args: never[]) => Error;
    const sampleErr = new ctx.FirebaseError('auth/internal-error', 'err');

    const invalidMissingPrefix = observeSyncAuthAttempt(
      () => new SAMLAuthProvider('corp-sso'),
      ErrCtor,
    );
    const invalidEmptyPrefix = observeSyncAuthAttempt(
      () => new SAMLAuthProvider(''),
      ErrCtor,
    );

    return {
      google: {
        staticProviderId: GoogleAuthProvider.PROVIDER_ID,
        staticSignInMethod: GoogleAuthProvider.GOOGLE_SIGN_IN_METHOD,
        instanceProviderId: google.providerId,
        addScopeChainsSelf: google.addScope('profile') === google,
        setCustomParamsChainsSelf:
          google.setCustomParameters({ prompt: 'select_account' }) === google,
        credentialFromErrorNull: GoogleAuthProvider.credentialFromError(sampleErr) === null,
      },
      email: {
        staticProviderId: EmailAuthProvider.PROVIDER_ID,
        staticPasswordMethod: EmailAuthProvider.EMAIL_PASSWORD_SIGN_IN_METHOD,
        staticLinkMethod: EmailAuthProvider.EMAIL_LINK_SIGN_IN_METHOD,
        instanceProviderId: email.providerId,
      },
      facebook: {
        staticProviderId: FacebookAuthProvider.PROVIDER_ID,
        staticSignInMethod: FacebookAuthProvider.FACEBOOK_SIGN_IN_METHOD,
        instanceProviderId: facebook.providerId,
        addScopeChainsSelf: facebook.addScope('email') === facebook,
        credentialFromErrorNull: FacebookAuthProvider.credentialFromError(sampleErr) === null,
      },
      github: {
        staticProviderId: GithubAuthProvider.PROVIDER_ID,
        staticSignInMethod: GithubAuthProvider.GITHUB_SIGN_IN_METHOD,
        instanceProviderId: github.providerId,
        addScopeChainsSelf: github.addScope('read:user') === github,
        credentialFromErrorNull: GithubAuthProvider.credentialFromError(sampleErr) === null,
      },
      twitter: {
        staticProviderId: TwitterAuthProvider.PROVIDER_ID,
        staticSignInMethod: TwitterAuthProvider.TWITTER_SIGN_IN_METHOD,
        instanceProviderId: twitter.providerId,
        addScopeChainsSelf: twitter.addScope('users.read') === twitter,
        credentialFromErrorNull: TwitterAuthProvider.credentialFromError(sampleErr) === null,
      },
      oauth: {
        instanceProviderId: oauth.providerId,
        addScopeChainsSelf: oauth.addScope('name') === oauth,
        setCustomParamsChainsSelf: oauth.setCustomParameters({ locale: 'en' }) === oauth,
        credentialFromErrorNull: OAuthProvider.credentialFromError(sampleErr) === null,
      },
      saml: {
        instanceProviderId: saml.providerId,
        hasStaticCredentialFactory: 'credential' in SAMLAuthProvider,
        hasInstanceCredentialFactory: 'credential' in saml,
        credentialFromErrorNull: SAMLAuthProvider.credentialFromError(sampleErr) === null,
        invalidMissingPrefix,
        invalidEmptyPrefix,
      },
    };
  } finally {
    await ctx.cleanup();
  }
}

export async function replayAuthCredentialFactoriesAndJsonRoundtrip(
  ctx: AuthProvidersAndCredentialsReplayContext,
): Promise<Behavior> {
  try {
    const {
      AuthCredential,
      EmailAuthCredential,
      EmailAuthProvider,
      FacebookAuthProvider,
      GithubAuthProvider,
      GoogleAuthProvider,
      OAuthCredential,
      OAuthProvider,
      TwitterAuthProvider,
    } = ctx.authSdk;

    const ErrCtor = ctx.FirebaseError as unknown as new (...args: never[]) => Error;
    const emailPw = EmailAuthProvider.credential('ada@example.com', 'Secret!123');
    const validSignInLink =
      'https://example.com/finish?apiKey=demo-api-key&mode=signIn&oobCode=oob-code-42';
    const emailLink = EmailAuthProvider.credentialWithLink('ada@example.com', validSignInLink);
    const invalidLinkAttempt = observeSyncAuthAttempt(
      () => EmailAuthProvider.credentialWithLink('ada@example.com', 'https://example.com/no-oob'),
      ErrCtor,
    );
    const resetModeLinkAttempt = observeSyncAuthAttempt(
      () =>
        EmailAuthProvider.credentialWithLink(
          'ada@example.com',
          'https://example.com/reset?apiKey=demo-api-key&mode=resetPassword&oobCode=oob-99',
        ),
      ErrCtor,
    );

    const googleCred = GoogleAuthProvider.credential('google-id-tok', 'google-access-tok');
    const facebookCred = FacebookAuthProvider.credential('fb-access-tok');
    const githubCred = GithubAuthProvider.credential('gh-access-tok');
    const twitterCred = TwitterAuthProvider.credential('tw-oauth-token', 'tw-oauth-secret');
    const appleCred = new OAuthProvider('apple.com').credential({
      idToken: 'apple-id-tok',
      accessToken: 'apple-access-tok',
    });

    const emailPwFromObj = EmailAuthCredential.fromJSON(emailPw.toJSON());
    const emailPwFromStr = EmailAuthCredential.fromJSON(JSON.stringify(emailPw.toJSON()));
    const emailLinkFromObj = EmailAuthCredential.fromJSON(emailLink.toJSON());
    const googleFromObj = OAuthCredential.fromJSON(googleCred.toJSON());
    const googleFromStr = OAuthCredential.fromJSON(JSON.stringify(googleCred.toJSON()));
    const twitterFromObj = OAuthCredential.fromJSON(twitterCred.toJSON());

    return {
      emailPassword: {
        isAuthCredential: emailPw instanceof AuthCredential,
        isEmailAuthCredential: emailPw instanceof EmailAuthCredential,
        providerId: emailPw.providerId,
        signInMethod: emailPw.signInMethod,
        toJson: emailPw.toJSON(),
        roundTripFromObject: nullableJson(emailPwFromObj),
        roundTripFromString: nullableJson(emailPwFromStr),
        fromEmptyObject: EmailAuthCredential.fromJSON({}),
      },
      emailLink: {
        isAuthCredential: emailLink instanceof AuthCredential,
        isEmailAuthCredential: emailLink instanceof EmailAuthCredential,
        providerId: emailLink.providerId,
        signInMethod: emailLink.signInMethod,
        toJson: emailLink.toJSON(),
        roundTripFromObject: nullableJson(emailLinkFromObj),
        invalidLinkAttempt,
        resetModeLinkAttempt,
      },
      oauthCredentials: {
        google: {
          isAuthCredential: googleCred instanceof AuthCredential,
          isOAuthCredential: googleCred instanceof OAuthCredential,
          providerId: googleCred.providerId,
          signInMethod: googleCred.signInMethod,
          idToken: nullableString(googleCred.idToken),
          accessToken: nullableString(googleCred.accessToken),
          toJson: googleCred.toJSON(),
          roundTripFromObject: nullableJson(googleFromObj),
          roundTripFromString: nullableJson(googleFromStr),
        },
        facebook: {
          isAuthCredential: facebookCred instanceof AuthCredential,
          isOAuthCredential: facebookCred instanceof OAuthCredential,
          providerId: facebookCred.providerId,
          signInMethod: facebookCred.signInMethod,
          accessToken: nullableString(facebookCred.accessToken),
          toJson: facebookCred.toJSON(),
        },
        github: {
          isAuthCredential: githubCred instanceof AuthCredential,
          isOAuthCredential: githubCred instanceof OAuthCredential,
          providerId: githubCred.providerId,
          signInMethod: githubCred.signInMethod,
          accessToken: nullableString(githubCred.accessToken),
          toJson: githubCred.toJSON(),
        },
        twitter: {
          isAuthCredential: twitterCred instanceof AuthCredential,
          isOAuthCredential: twitterCred instanceof OAuthCredential,
          providerId: twitterCred.providerId,
          signInMethod: twitterCred.signInMethod,
          accessToken: nullableString(twitterCred.accessToken),
          secret: nullableString(twitterCred.secret),
          toJson: twitterCred.toJSON(),
          roundTripFromObject: nullableJson(twitterFromObj),
        },
        appleOAuth: {
          isAuthCredential: appleCred instanceof AuthCredential,
          isOAuthCredential: appleCred instanceof OAuthCredential,
          providerId: appleCred.providerId,
          signInMethod: appleCred.signInMethod,
          idToken: nullableString(appleCred.idToken),
          accessToken: nullableString(appleCred.accessToken),
          toJson: appleCred.toJSON(),
        },
        fromEmptyObject: OAuthCredential.fromJSON({}),
      },
    };
  } finally {
    await ctx.cleanup();
  }
}

export async function replayAuthEmailCredentialSigninAndProviderdata(
  ctx: AuthProvidersAndCredentialsReplayContext,
): Promise<Behavior> {
  try {
    const uid = ctx.nextUid('provdata');
    const email = ctx.nextEmail('provdata');
    const password = 'ProbePassword!123';
    const customToken = await ctx.adminAuth.createCustomToken(uid);

    const initialCred = await ctx.authSdk.signInWithCustomToken(ctx.auth, customToken);
    const initialProviderIds = initialCred.user.providerData.map((item) => item.providerId);
    const initialIsAnonymous = initialCred.user.isAnonymous;

    const emailCred = ctx.authSdk.EmailAuthProvider.credential(email, password);
    const linkedCred = await ctx.authSdk.linkWithCredential(initialCred.user, emailCred);
    const afterLinkProviderIds = linkedCred.user.providerData.map((item) => item.providerId);
    const linkedPasswordEntry = linkedCred.user.providerData.find(
      (item) => item.providerId === 'password',
    );
    let linkedEmailMatches = false;
    if (linkedPasswordEntry !== undefined) {
      linkedEmailMatches = linkedPasswordEntry.email === email;
    }
    const uidPreservedOnLink = linkedCred.user.uid === uid;

    await ctx.authSdk.signOut(ctx.auth);

    const freshEmailCred = ctx.authSdk.EmailAuthProvider.credential(email, password);
    const credSignIn = await ctx.authSdk.signInWithCredential(ctx.auth, freshEmailCred);
    const signInWithEmailCredentialSucceeded = credSignIn.operationType === 'signIn';
    const sameUidAfterCredentialSignIn = credSignIn.user.uid === uid;
    const afterCredentialSignInProviderIds = credSignIn.user.providerData.map(
      (item) => item.providerId,
    );

    const unlinkedUser = await ctx.authSdk.unlink(credSignIn.user, 'password');
    const afterUnlinkProviderIds = unlinkedUser.providerData.map((item) => item.providerId);
    const remainsNonAnonymousAfterUnlink = unlinkedUser.isAnonymous === false;

    await ctx.authSdk.reload(unlinkedUser);
    const afterReloadProviderIds = unlinkedUser.providerData.map((item) => item.providerId);

    return {
      initialProviderIds,
      initialIsAnonymous,
      afterLinkProviderIds,
      linkedEmailMatches,
      uidPreservedOnLink,
      signInWithEmailCredentialSucceeded,
      sameUidAfterCredentialSignIn,
      afterCredentialSignInProviderIds,
      afterUnlinkProviderIds,
      remainsNonAnonymousAfterUnlink,
      afterReloadProviderIds,
    };
  } finally {
    await ctx.cleanup();
  }
}
