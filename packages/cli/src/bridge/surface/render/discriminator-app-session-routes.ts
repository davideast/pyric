/**
 * The app session family's routes: the five sign-in actions and the sign-out.
 *
 * These are the one family whose subject is the application's own identity
 * rather than the caller's, which is why they are a tool of their own rather
 * than more actions on the identity switch. Nothing here changes what the
 * caller's later calls are evaluated as.
 */
import type { Args, DiscriminatorRoute } from './discriminator-route-shapes.js';
import { assign, on, text } from './discriminator-route-shapes.js';

const TOOL = 'manage_app_session';

/** The credential object a federated sign-in describes, from the flat fields. */
function credentialFrom(args: Args): Args {
  const credential: Args = {};
  assign(credential, 'providerId', text(args, 'providerId'));
  assign(credential, 'email', text(args, 'email'));
  assign(credential, 'idToken', text(args, 'idToken'));
  assign(credential, 'accessToken', text(args, 'accessToken'));
  return credential;
}

export const APP_SESSION_ROUTES: DiscriminatorRoute[] = [
  {
    tool: TOOL,
    action: 'sign_in_password',
    selects: on('action', 'sign_in_password'),
    operation: 'signin_auth_password',
    translate: (args) => ({ email: args.email, password: args.password }),
  },
  {
    tool: TOOL,
    action: 'sign_in_anonymous',
    selects: on('action', 'sign_in_anonymous'),
    operation: 'signin_auth_anonymous',
    translate: () => ({}),
  },
  {
    tool: TOOL,
    action: 'sign_in_custom_token',
    selects: on('action', 'sign_in_custom_token'),
    operation: 'signin_auth_token',
    translate: (args) => ({ token: args.token }),
  },
  {
    tool: TOOL,
    action: 'sign_in_credential',
    selects: on('action', 'sign_in_credential'),
    operation: 'signin_auth_credential',
    translate: (args) => ({ credential: credentialFrom(args) }),
  },
  {
    tool: TOOL,
    action: 'sign_out',
    selects: on('action', 'sign_out'),
    operation: 'signout_auth_session',
    translate: () => ({}),
  },
];
