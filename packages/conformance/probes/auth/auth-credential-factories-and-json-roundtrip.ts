import { FirebaseError } from 'firebase/app';
import type { Probe } from '../../rigs/types.ts';
import { observeSyncAuthAttempt } from '../../src/auth-user-probe-session.ts';

export const probe: Probe = {
  rig: 'sdk-probes',
  requires: [],
  matrixRow: 'auth#51',
  rowIds: ['auth#51', 'auth#180', 'auth#181'],
  description:
    'Provider static and instance credential factories produce AuthCredential, EmailAuthCredential, and OAuthCredential instances with deterministic toJSON and fromJSON round-trips and email-link URL validation.',
  async observe() {
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
    } = await import('firebase/auth');

    const emailPw = EmailAuthProvider.credential('ada@example.com', 'Secret!123');
    const validSignInLink =
      'https://example.com/finish?apiKey=demo-api-key&mode=signIn&oobCode=oob-code-42';
    const emailLink = EmailAuthProvider.credentialWithLink('ada@example.com', validSignInLink);
    const invalidLinkAttempt = observeSyncAuthAttempt(
      () => EmailAuthProvider.credentialWithLink('ada@example.com', 'https://example.com/no-oob'),
      FirebaseError,
    );
    const resetModeLinkAttempt = observeSyncAuthAttempt(
      () =>
        EmailAuthProvider.credentialWithLink(
          'ada@example.com',
          'https://example.com/reset?apiKey=demo-api-key&mode=resetPassword&oobCode=oob-99',
        ),
      FirebaseError,
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
        roundTripFromObject: emailPwFromObj?.toJSON() ?? null,
        roundTripFromString: emailPwFromStr?.toJSON() ?? null,
        fromEmptyObject: EmailAuthCredential.fromJSON({}),
      },
      emailLink: {
        isAuthCredential: emailLink instanceof AuthCredential,
        isEmailAuthCredential: emailLink instanceof EmailAuthCredential,
        providerId: emailLink.providerId,
        signInMethod: emailLink.signInMethod,
        toJson: emailLink.toJSON(),
        roundTripFromObject: emailLinkFromObj?.toJSON() ?? null,
        invalidLinkAttempt,
        resetModeLinkAttempt,
      },
      oauthCredentials: {
        google: {
          isAuthCredential: googleCred instanceof AuthCredential,
          isOAuthCredential: googleCred instanceof OAuthCredential,
          providerId: googleCred.providerId,
          signInMethod: googleCred.signInMethod,
          idToken: googleCred.idToken ?? null,
          accessToken: googleCred.accessToken ?? null,
          toJson: googleCred.toJSON(),
          roundTripFromObject: googleFromObj?.toJSON() ?? null,
          roundTripFromString: googleFromStr?.toJSON() ?? null,
        },
        facebook: {
          isAuthCredential: facebookCred instanceof AuthCredential,
          isOAuthCredential: facebookCred instanceof OAuthCredential,
          providerId: facebookCred.providerId,
          signInMethod: facebookCred.signInMethod,
          accessToken: facebookCred.accessToken ?? null,
          toJson: facebookCred.toJSON(),
        },
        github: {
          isAuthCredential: githubCred instanceof AuthCredential,
          isOAuthCredential: githubCred instanceof OAuthCredential,
          providerId: githubCred.providerId,
          signInMethod: githubCred.signInMethod,
          accessToken: githubCred.accessToken ?? null,
          toJson: githubCred.toJSON(),
        },
        twitter: {
          isAuthCredential: twitterCred instanceof AuthCredential,
          isOAuthCredential: twitterCred instanceof OAuthCredential,
          providerId: twitterCred.providerId,
          signInMethod: twitterCred.signInMethod,
          accessToken: twitterCred.accessToken ?? null,
          secret: twitterCred.secret ?? null,
          toJson: twitterCred.toJSON(),
          roundTripFromObject: twitterFromObj?.toJSON() ?? null,
        },
        appleOAuth: {
          isAuthCredential: appleCred instanceof AuthCredential,
          isOAuthCredential: appleCred instanceof OAuthCredential,
          providerId: appleCred.providerId,
          signInMethod: appleCred.signInMethod,
          idToken: appleCred.idToken ?? null,
          accessToken: appleCred.accessToken ?? null,
          toJson: appleCred.toJSON(),
        },
        fromEmptyObject: OAuthCredential.fromJSON({}),
      },
    };
  },
};
