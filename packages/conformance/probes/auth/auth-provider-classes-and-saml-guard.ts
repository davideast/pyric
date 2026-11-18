import { FirebaseError } from 'firebase/app';
import type { Probe } from '../../rigs/types.ts';
import { observeSyncAuthAttempt } from '../../src/auth-user-probe-session.ts';

export const probe: Probe = {
  rig: 'sdk-probes',
  requires: [],
  matrixRow: 'auth#50',
  rowIds: ['auth#50', 'auth#52', 'auth#181'],
  description:
    'Provider classes expose canonical PROVIDER_ID and providerId values, chainable scope/parameter methods where supported, and SAMLAuthProvider enforces the saml. prefix while omitting client credential() factories.',
  async observe() {
    const {
      EmailAuthProvider,
      FacebookAuthProvider,
      GithubAuthProvider,
      GoogleAuthProvider,
      OAuthProvider,
      SAMLAuthProvider,
      TwitterAuthProvider,
    } = await import('firebase/auth');

    const google = new GoogleAuthProvider();
    const email = new EmailAuthProvider();
    const facebook = new FacebookAuthProvider();
    const github = new GithubAuthProvider();
    const twitter = new TwitterAuthProvider();
    const oauth = new OAuthProvider('apple.com');
    const saml = new SAMLAuthProvider('saml.corp-sso');

    const invalidMissingPrefix = observeSyncAuthAttempt(
      () => new SAMLAuthProvider('corp-sso'),
      FirebaseError,
    );
    const invalidEmptyPrefix = observeSyncAuthAttempt(
      () => new SAMLAuthProvider(''),
      FirebaseError,
    );

    return {
      google: {
        staticProviderId: GoogleAuthProvider.PROVIDER_ID,
        staticSignInMethod: GoogleAuthProvider.GOOGLE_SIGN_IN_METHOD,
        instanceProviderId: google.providerId,
        addScopeChainsSelf: google.addScope('profile') === google,
        setCustomParamsChainsSelf: google.setCustomParameters({ prompt: 'select_account' }) === google,
        credentialFromErrorNull: GoogleAuthProvider.credentialFromError(new FirebaseError('auth/internal-error', 'err')) === null,
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
        credentialFromErrorNull: FacebookAuthProvider.credentialFromError(new FirebaseError('auth/internal-error', 'err')) === null,
      },
      github: {
        staticProviderId: GithubAuthProvider.PROVIDER_ID,
        staticSignInMethod: GithubAuthProvider.GITHUB_SIGN_IN_METHOD,
        instanceProviderId: github.providerId,
        addScopeChainsSelf: github.addScope('read:user') === github,
        credentialFromErrorNull: GithubAuthProvider.credentialFromError(new FirebaseError('auth/internal-error', 'err')) === null,
      },
      twitter: {
        staticProviderId: TwitterAuthProvider.PROVIDER_ID,
        staticSignInMethod: TwitterAuthProvider.TWITTER_SIGN_IN_METHOD,
        instanceProviderId: twitter.providerId,
        addScopeChainsSelf: twitter.addScope('users.read') === twitter,
        credentialFromErrorNull: TwitterAuthProvider.credentialFromError(new FirebaseError('auth/internal-error', 'err')) === null,
      },
      oauth: {
        instanceProviderId: oauth.providerId,
        addScopeChainsSelf: oauth.addScope('name') === oauth,
        setCustomParamsChainsSelf: oauth.setCustomParameters({ locale: 'en' }) === oauth,
        credentialFromErrorNull: OAuthProvider.credentialFromError(new FirebaseError('auth/internal-error', 'err')) === null,
      },
      saml: {
        instanceProviderId: saml.providerId,
        hasStaticCredentialFactory: 'credential' in SAMLAuthProvider,
        hasInstanceCredentialFactory: 'credential' in saml,
        credentialFromErrorNull: SAMLAuthProvider.credentialFromError(new FirebaseError('auth/internal-error', 'err')) === null,
        invalidMissingPrefix,
        invalidEmptyPrefix,
      },
    };
  },
};
