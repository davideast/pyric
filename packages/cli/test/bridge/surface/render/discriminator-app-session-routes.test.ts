/**
 * The app session family's routes: each action reaches its own canonical
 * operation, and the federated sign-in gathers the flat provider fields back
 * into the credential object the method takes.
 */
import { describe, expect, it } from 'bun:test';

import { APP_SESSION_ROUTES } from '../../../../src/bridge/surface/render/discriminator-app-session-routes.js';
import type { Args } from '../../../../src/bridge/surface/render/discriminator-route-shapes.js';

/** The route one action selects. */
function routeFor(args: Args) {
  const route = APP_SESSION_ROUTES.find((candidate) => candidate.selects(args));
  if (route === undefined) throw new Error(`no route selected by ${JSON.stringify(args)}`);
  return route;
}

describe('the app session routes', () => {
  it('serves one tool and names every action once', () => {
    expect(new Set(APP_SESSION_ROUTES.map((route) => route.tool))).toEqual(
      new Set(['manage_app_session']),
    );
    const actions = APP_SESSION_ROUTES.map((route) => route.action);
    expect(new Set(actions).size).toBe(actions.length);
  });

  it('reaches one canonical operation per action', () => {
    expect(
      APP_SESSION_ROUTES.map((route) => [route.action, route.operation]),
    ).toEqual([
      ['sign_in_password', 'signin_auth_password'],
      ['sign_in_anonymous', 'signin_auth_anonymous'],
      ['sign_in_custom_token', 'signin_auth_token'],
      ['sign_in_credential', 'signin_auth_credential'],
      ['sign_out', 'signout_auth_session'],
    ]);
  });

  it('translates a password sign-in into the method arguments', () => {
    const args = { action: 'sign_in_password', email: 'alice@example.com', password: 'hunter22' };
    expect(routeFor(args).translate(args)).toEqual({
      email: 'alice@example.com',
      password: 'hunter22',
    });
  });

  it('gathers the flat provider fields into one credential', () => {
    const args = {
      action: 'sign_in_credential',
      providerId: 'google.com',
      email: 'alice@example.com',
      idToken: 'id',
    };
    expect(routeFor(args).translate(args)).toEqual({
      credential: { providerId: 'google.com', email: 'alice@example.com', idToken: 'id' },
    });
  });

  it('takes no arguments for anonymous sign-in and sign-out', () => {
    const anonymous = { action: 'sign_in_anonymous' };
    const out = { action: 'sign_out' };
    expect(routeFor(anonymous).translate(anonymous)).toEqual({});
    expect(routeFor(out).translate(out)).toEqual({});
  });

  it('carries the token of a custom-token sign-in', () => {
    const args = { action: 'sign_in_custom_token', token: 'eyJ1aWQiOiJhbGljZSJ9' };
    expect(routeFor(args).translate(args)).toEqual({ token: 'eyJ1aWQiOiJhbGljZSJ9' });
  });
});
