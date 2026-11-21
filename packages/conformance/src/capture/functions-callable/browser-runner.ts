/**
 * Chromium client-probe runner and production token minting for the
 * `functions-callable` capture rig.
 */
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { chromium, type Browser, type Page } from '@playwright/test';
import { CALLABLE_BROWSER_SOURCE } from './browser-source.ts';
import type {
  AppCheckTokenKind,
  AuthTokenKind,
  CallableProbeRequest,
  ClientScenarioInput,
  FunctionsCallableClientProbe,
} from './probe-types.ts';

export interface WebAppConfig {
  apiKey: string;
  appId: string;
  projectId: string;
  [key: string]: unknown;
}

const TOKEN_HELPER_SOURCE = String.raw`
import { initializeApp } from 'firebase/app';
import { getAuth, signInWithCustomToken } from 'firebase/auth';
import { CustomProvider, getLimitedUseToken, getToken, initializeAppCheck } from 'firebase/app-check';

let helperCount = 0;
let cachedAppCheck;

function freshApp(config) {
  return initializeApp(config, 'callable-capture-token-' + helperCount++);
}

function appCheckFor(config) {
  if (!cachedAppCheck) {
    cachedAppCheck = initializeAppCheck(freshApp(config), {
      provider: new CustomProvider({
        getToken: async () => {
          throw new Error('debug mode must not call CustomProvider');
        },
      }),
      isTokenAutoRefreshEnabled: false,
    });
  }
  return cachedAppCheck;
}

globalThis.functionsCallableCaptureTokens = {
  async idToken(config, customToken) {
    const auth = getAuth(freshApp(config));
    await signInWithCustomToken(auth, customToken);
    if (!auth.currentUser) {
      throw new Error('signInWithCustomToken left no currentUser');
    }
    return auth.currentUser.getIdToken();
  },
  async appCheckToken(config) {
    const result = await getToken(appCheckFor(config));
    return result.token;
  },
  async limitedUseToken(config) {
    const result = await getLimitedUseToken(appCheckFor(config));
    return result.token;
  },
};
`;

async function bundleCaptureBrowserScript(): Promise<string> {
  const combinedSource = `${CALLABLE_BROWSER_SOURCE}\n${TOKEN_HELPER_SOURCE}`;
  const built = await Bun.build({
    entrypoints: ['virtual:callable-capture-browser'],
    target: 'browser',
    format: 'iife',
    plugins: [
      {
        name: 'callable-capture-browser',
        setup(builder) {
          builder.onResolve({ filter: /^virtual:callable-capture-browser$/ }, () => ({
            path: 'callable-capture-browser.js',
            namespace: 'callable-capture',
          }));
          builder.onLoad({ filter: /.*/, namespace: 'callable-capture' }, () => ({
            contents: combinedSource,
            loader: 'js',
          }));
        },
      },
    ],
  });
  if (!built.success) {
    const messages = built.logs.map((log) => log.message).join('; ');
    throw new Error(`callable browser bundle failed: ${messages}`);
  }
  const firstOutput = built.outputs[0];
  if (!firstOutput) {
    throw new Error('callable browser bundle emitted no output');
  }
  return firstOutput.text();
}

function ensureChromiumInstalled(repoRoot: string): void {
  const executable = chromium.executablePath();
  if (existsSync(executable)) {
    return;
  }
  const install = spawnSync('bunx', ['playwright', 'install', 'chromium'], {
    cwd: repoRoot,
    stdio: 'inherit',
  });
  if (install.status !== 0) {
    throw new Error('bunx playwright install chromium failed');
  }
}

function forgedJwt(token: string): string {
  const parts = token.split('.');
  const header = parts[0] ?? '';
  const payload = parts[1] ?? '';
  const signature = parts[2] ?? '';
  let replacement = 'A';
  if (signature.at(-1) === 'A') {
    replacement = 'B';
  }
  return `${header}.${payload}.${signature.slice(0, -1)}${replacement}`;
}

export interface CallableBrowserSession {
  withWireTokens(requests: readonly CallableProbeRequest[]): Promise<CallableProbeRequest[]>;
  runClientProbe(
    probe: FunctionsCallableClientProbe,
    input: ClientScenarioInput,
  ): Promise<Record<string, unknown>>;
  close(): Promise<void>;
}

/**
 * Opens headless Chromium at `hostingBase` with `FIREBASE_APPCHECK_DEBUG_TOKEN`
 * pre-configured, providing real Web SDK tokens for wire probes and running
 * `CALLABLE_BROWSER_SOURCE` client scenarios.
 */
export async function openCallableBrowserSession(options: {
  repoRoot: string;
  hostingBase: string;
  webConfig: WebAppConfig;
  debugToken: string;
  customToken: string;
}): Promise<CallableBrowserSession> {
  const { repoRoot, hostingBase, webConfig, debugToken, customToken } = options;
  ensureChromiumInstalled(repoRoot);
  const scriptSource = await bundleCaptureBrowserScript();
  const browser: Browser = await chromium.launch({ headless: true });
  const context = await browser.newContext();
  await context.addInitScript((token: string) => {
    (self as unknown as { FIREBASE_APPCHECK_DEBUG_TOKEN: string }).FIREBASE_APPCHECK_DEBUG_TOKEN =
      token;
  }, debugToken);

  const page: Page = await context.newPage();
  await page.goto(hostingBase, { waitUntil: 'domcontentloaded' });
  await page.addScriptTag({ content: scriptSource });

  let cachedIdToken: Promise<string> | undefined;
  let cachedValidAppCheck: Promise<string> | undefined;

  const callTokenHelper = (method: string, extra?: string): Promise<string> =>
    page.evaluate(
      async ([fnName, cfg, tokenArg]) => {
        const ns = (
          globalThis as unknown as {
            functionsCallableCaptureTokens: Record<
              string,
              (c: unknown, t?: string) => Promise<string>
            >;
          }
        ).functionsCallableCaptureTokens;
        const helper = ns[fnName];
        if (!helper) {
          throw new Error(`missing token helper ${fnName}`);
        }
        return helper(cfg, tokenArg);
      },
      [method, webConfig, extra] as const,
    );

  const validIdToken = (): Promise<string> => {
    if (cachedIdToken === undefined) {
      cachedIdToken = callTokenHelper('idToken', customToken);
    }
    return cachedIdToken;
  };

  const validAppCheckToken = (): Promise<string> => {
    if (cachedValidAppCheck === undefined) {
      cachedValidAppCheck = callTokenHelper('appCheckToken');
    }
    return cachedValidAppCheck;
  };

  const resolveAuthHeader = async (kind: AuthTokenKind): Promise<string> => {
    if (kind === 'garbage') {
      return 'Bearer not-a-jwt';
    }
    if (kind === 'basic') {
      return `Basic ${Buffer.from('pyric:callable').toString('base64')}`;
    }
    const valid = await validIdToken();
    if (kind === 'forged') {
      return `Bearer ${forgedJwt(valid)}`;
    }
    return `Bearer ${valid}`;
  };

  const resolveAppCheckHeader = async (
    kind: AppCheckTokenKind,
    sharedLimited: () => Promise<string>,
  ): Promise<string> => {
    if (kind === 'invalid') {
      const hdr = Buffer.from(JSON.stringify({ alg: 'none' })).toString('base64url');
      const body = Buffer.from(JSON.stringify({ sub: 'not-an-app' })).toString('base64url');
      return `${hdr}.${body}.`;
    }
    if (kind === 'limited-use-shared') {
      return sharedLimited();
    }
    if (kind === 'limited-use') {
      return callTokenHelper('limitedUseToken');
    }
    return validAppCheckToken();
  };

  return {
    async withWireTokens(
      requests: readonly CallableProbeRequest[],
    ): Promise<CallableProbeRequest[]> {
      let sharedLimitedPromise: Promise<string> | undefined;
      const sharedLimited = (): Promise<string> => {
        if (sharedLimitedPromise === undefined) {
          sharedLimitedPromise = callTokenHelper('limitedUseToken');
        }
        return sharedLimitedPromise;
      };
      const out: CallableProbeRequest[] = [];
      for (const req of requests) {
        const headers = { ...req.headers };
        if (req.tokens?.auth) {
          headers.authorization = await resolveAuthHeader(req.tokens.auth);
        }
        if (req.tokens?.appCheck) {
          headers['x-firebase-appcheck'] = await resolveAppCheckHeader(
            req.tokens.appCheck,
            sharedLimited,
          );
        }
        out.push({ ...req, headers });
      }
      return out;
    },

    async runClientProbe(
      probe: FunctionsCallableClientProbe,
      input: ClientScenarioInput,
    ): Promise<Record<string, unknown>> {
      return page.evaluate(
        async ([scenario, cfg, scenarioInput]) => {
          const ns = (
            globalThis as unknown as {
              functionsCallableProbes: Record<
                string,
                (c: unknown, i: unknown) => Promise<Record<string, unknown>>
              >;
            }
          ).functionsCallableProbes;
          const runner = ns[scenario];
          if (!runner) {
            throw new Error(`missing client scenario ${scenario}`);
          }
          return runner(cfg, scenarioInput);
        },
        [probe.scenario, webConfig, input] as const,
      );
    },

    async close(): Promise<void> {
      await browser.close().catch(() => undefined);
    },
  };
}
