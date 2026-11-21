/**
 * The `firebase/functions` surface shared by the served page bundle
 * (`./functions.js`) and a registered Node process (`register/client/functions.js`).
 */
import type { FirebaseApp } from 'pyric/app';
import {
  FunctionsError,
  connectFunctionsEmulator,
  httpsCallable,
  httpsCallableFromURL,
  type Functions,
  type FunctionsErrorCode,
  type FunctionsErrorCodeCore,
  type HttpsCallable,
  type HttpsCallableOptions,
  type HttpsCallableResult,
  type HttpsCallableStreamOptions,
  type HttpsCallableStreamResult,
} from 'pyric/functions';
import {
  createGetFunctions,
  inProcessAuthToken,
  type FunctionsHostTransport,
} from 'pyric/functions/internal';
import { getAuthTokenForApp } from './active-auth.js';
import { initPayload } from './init-payload.js';
import { nodeRuntimeOrigin } from './runtime-origin.js';
import { markServiceUsed } from './service-use.js';

async function servedGatewayOrigin(): Promise<string | null> {
  const origin = nodeRuntimeOrigin();
  if (origin !== undefined) {
    const [configuration, host] = await Promise.all([initPayload, origin.host()]);
    const isNodeHost = configuration?.hosted === true;
    if (!isNodeHost) {
      throw origin.offHostError(`the host at ${host} is not the Node host`);
    }
    return host.replace(/\/$/, '');
  }
  if (typeof location !== 'undefined' && typeof location.origin === 'string') {
    return location.origin.replace(/\/$/, '');
  }
  return null;
}

async function servedAuthToken(app: FirebaseApp): Promise<string | null> {
  const activeToken = await getAuthTokenForApp(app);
  if (activeToken !== null) {
    return activeToken;
  }
  return inProcessAuthToken(app);
}

function servedFetch(input: string, init?: RequestInit): Promise<Response> {
  const realmFetch = nodeRuntimeOrigin()?.socketRealm.fetch;
  if (typeof realmFetch === 'function') {
    return realmFetch(input, init);
  }
  return fetch(input, init);
}

const servedTransport: FunctionsHostTransport = {
  gatewayOrigin: servedGatewayOrigin,
  authToken: servedAuthToken,
  fetchImpl: servedFetch,
};

const rawGetFunctions = createGetFunctions(servedTransport, 'served-functions');

export function getFunctions(app?: FirebaseApp, regionOrCustomDomain?: string): Functions {
  markServiceUsed();
  return rawGetFunctions(app, regionOrCustomDomain);
}

export {
  FunctionsError,
  connectFunctionsEmulator,
  httpsCallable,
  httpsCallableFromURL,
};
export type {
  Functions,
  FunctionsErrorCode,
  FunctionsErrorCodeCore,
  HttpsCallable,
  HttpsCallableOptions,
  HttpsCallableResult,
  HttpsCallableStreamOptions,
  HttpsCallableStreamResult,
};
