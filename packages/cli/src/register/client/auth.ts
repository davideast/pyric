/** `firebase/auth` in a Node process activated against a remote host (#1082): the served entry over the Node host. */
import './bootstrap.js';
import * as surface from '../../serve/entries/auth.js';
import { ensureRemoteServerAppSession } from './server-app-session.js';

export * from '../../serve/entries/auth.js';

export const getAuth = ((...args: Parameters<typeof surface.getAuth>) => {
  ensureRemoteServerAppSession(args[0]);
  return surface.getAuth(...args);
}) as typeof surface.getAuth;

export const initializeAuth = ((...args: Parameters<typeof surface.initializeAuth>) => {
  ensureRemoteServerAppSession(args[0]);
  return surface.initializeAuth(...args);
}) as typeof surface.initializeAuth;
