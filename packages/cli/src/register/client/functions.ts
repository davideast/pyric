/** `firebase/functions` in a Node process activated against a remote host (#1082): the served surface over the Node host. */
import './bootstrap.js';
import * as surface from '../../serve/entries/functions-surface.js';
import { ensureRemoteServerAppSession } from './server-app-session.js';

export * from '../../serve/entries/functions-surface.js';

export const getFunctions = ((...args: Parameters<typeof surface.getFunctions>) => {
  ensureRemoteServerAppSession(args[0]);
  return surface.getFunctions(...args);
}) as typeof surface.getFunctions;
