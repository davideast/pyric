/**
 * Admin-plane and wire-plane App Check captures: firebase-admin `createToken`
 * and `verifyToken`, plus the raw `exchangeDebugToken` REST envelope.
 */
import type { AppCheck } from 'firebase-admin/app-check';
import { jwtShape, redactText, tamperSignature, type Secrets } from './redact.ts';
import { writeObservation, type ObservationContext } from './observation-writer.ts';
import { mintWithRetry } from './mint.ts';

const API = 'https://firebaseappcheck.googleapis.com/v1';

export interface AdminProbeInput {
  context: ObservationContext;
  appCheck: AppCheck;
  appId: string;
  apiKey: string;
  debugToken: string;
  unregisteredDebugToken: string;
}

function adminError(error: unknown, secrets: Secrets) {
  const e = error as { code?: string; message?: string; errorInfo?: unknown };
  return { threw: true, code: e.code ?? null, message: redactText(String(e.message ?? error), secrets) };
}

async function settle<T>(operation: () => Promise<T>, secrets: Secrets): Promise<{ threw: false; value: T } | ReturnType<typeof adminError>> {
  try {
    return { threw: false, value: await operation() };
  } catch (error) {
    return adminError(error, secrets);
  }
}

async function exchangeDebugToken(input: AdminProbeInput, debugToken: string) {
  const { projectId } = input.context;
  const url = `${API}/projects/${projectId}/apps/${input.appId}:exchangeDebugToken?key=${input.apiKey}`;
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ debugToken }),
  });
  const text = await response.text();
  let body: Record<string, unknown> | null = null;
  try {
    body = JSON.parse(text) as Record<string, unknown>;
  } catch {
    body = null;
  }
  return { status: response.status, body };
}

export async function runAdminProbes(input: AdminProbeInput, failures: string[]): Promise<string> {
  const { context, appCheck, appId } = input;
  const secrets = context.secrets;
  const remember = (token: string) => {
    secrets.values.push(token);
    return token;
  };
  const probe = async (name: string, fn: () => Promise<void>) => {
    try {
      await fn();
    } catch (error) {
      failures.push(name);
      console.error(`failed ${name}: ${redactText(String(error), secrets)}`);
    }
  };

  let minted = '';
  await probe('app-check-admin-create-token-shape', async () => {
    const result = await mintWithRetry(appCheck, appId);
    minted = remember(result.token);
    writeObservation(context, 'app-check-admin-create-token-shape',
      'firebase-admin createToken(appId) with no options: the result key set, the default ttlMillis, and the App Check JWT shape (header fields, claim names, iss and aud with the project number redacted, sub against the app id, exp minus iat). Token values are never stored.',
      { resultKeySet: Object.keys(result).sort(), ttlMillis: result.ttlMillis, token: jwtShape(result.token, secrets) }, 'admin');
  });

  await probe('app-check-admin-create-token-custom-ttl', async () => {
    const thirtyMinutes = await mintWithRetry(appCheck, appId, { ttlMillis: 30 * 60 * 1000 });
    remember(thirtyMinutes.token);
    const tooShort = await settle(() => appCheck.createToken(appId, { ttlMillis: 29 * 60 * 1000 }), secrets);
    const tooLong = await settle(() => appCheck.createToken(appId, { ttlMillis: 7 * 24 * 60 * 60 * 1000 + 1000 }), secrets);
    writeObservation(context, 'app-check-admin-create-token-custom-ttl',
      'createToken ttlMillis option: 30 minutes is honored (ttlMillis and exp minus iat), and the errors for 29 minutes and for 7 days plus one second.',
      {
        thirtyMinutes: { ttlMillis: thirtyMinutes.ttlMillis, ttlSeconds: jwtShape(thirtyMinutes.token, secrets).ttlSeconds },
        twentyNineMinutes: tooShort.threw ? tooShort : { threw: false },
        sevenDaysPlusOneSecond: tooLong.threw ? tooLong : { threw: false },
      }, 'admin');
  });

  await probe('app-check-admin-create-token-unknown-app', async () => {
    const unknownAppId = appId.replace(/:web:[0-9a-f]+$/, ':web:0000000000000000000000');
    const result = await settle(() => appCheck.createToken(unknownAppId), secrets);
    if (!result.threw) throw new Error('expected createToken for an unknown app to reject');
    writeObservation(context, 'app-check-admin-create-token-unknown-app',
      'createToken for a syntactically valid web app id that the project does not own (the real app id with its hash replaced by zeros).',
      { ...result, message: result.message.replace(unknownAppId, '<unknownAppId>') }, 'admin');
  });

  const wire = await exchangeDebugToken(input, input.debugToken);
  const exchanged = typeof wire.body?.token === 'string' ? remember(wire.body.token) : '';

  await probe('app-check-exchange-debug-token-wire', async () => {
    const unregistered = await exchangeDebugToken(input, input.unregisteredDebugToken);
    if (wire.status !== 200) throw new Error(`registered debug token exchange returned ${wire.status}`);
    writeObservation(context, 'app-check-exchange-debug-token-wire',
      'Raw REST envelope of projects.apps.exchangeDebugToken (the call the web SDK makes in debug mode, API key in the key query parameter): the success key set, ttl, and token shape for a registered debug token, and the error envelope for an unregistered one.',
      {
        registered: { httpStatus: wire.status, keySet: Object.keys(wire.body ?? {}).sort(), ttl: wire.body?.ttl, token: jwtShape(exchanged, secrets) },
        unregistered: { httpStatus: unregistered.status, body: unregistered.body },
      }, 'admin');
  });

  await probe('app-check-admin-verify-token', async () => {
    const adminMinted = await appCheck.verifyToken(minted);
    const debugExchanged = await appCheck.verifyToken(exchanged);
    const describe = (result: typeof adminMinted) => ({
      resultKeySet: Object.keys(result).sort(),
      appIdEqualsConfig: result.appId === appId,
      decodedClaimNames: Object.keys(result.token).sort(),
      decodedAppIdEqualsConfig: result.token.app_id === appId,
      alreadyConsumed: result.alreadyConsumed ?? null,
    });
    writeObservation(context, 'app-check-admin-verify-token',
      'verifyToken without options, for an Admin-minted token and for a token from the debug-token exchange: result key set, decoded claim names, and app id agreement.',
      { adminMinted: describe(adminMinted), debugExchanged: describe(debugExchanged) }, 'admin');
  });

  await probe('app-check-admin-verify-tampered', async () => {
    const tampered = await settle(() => appCheck.verifyToken(tamperSignature(minted)), secrets);
    const notJwt = await settle(() => appCheck.verifyToken('not-a-jwt'), secrets);
    const empty = await settle(() => appCheck.verifyToken(''), secrets);
    if (!tampered.threw) throw new Error('expected a tampered token to be rejected');
    writeObservation(context, 'app-check-admin-verify-tampered',
      'verifyToken rejections: a minted token with one signature character changed, the string not-a-jwt, and the empty string.',
      { tamperedSignature: tampered, notJwt, emptyString: empty }, 'admin');
  });

  await probe('app-check-admin-verify-consume', async () => {
    const limited = remember((await mintWithRetry(appCheck, appId)).token);
    const first = await appCheck.verifyToken(limited, { consume: true });
    const second = await appCheck.verifyToken(limited, { consume: true });
    const third = await appCheck.verifyToken(limited);
    writeObservation(context, 'app-check-admin-verify-consume',
      'Replay protection through verifyToken(token, { consume: true }) on a fresh Admin-minted token: the first call, a second consume, and a plain verify after consumption.',
      {
        firstConsume: { resultKeySet: Object.keys(first).sort(), alreadyConsumed: first.alreadyConsumed ?? null },
        secondConsume: { resultKeySet: Object.keys(second).sort(), alreadyConsumed: second.alreadyConsumed ?? null },
        plainVerifyAfterConsume: { resultKeySet: Object.keys(third).sort(), alreadyConsumed: third.alreadyConsumed ?? null },
      }, 'admin');
  });
  return minted;
}
