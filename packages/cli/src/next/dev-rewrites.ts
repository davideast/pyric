/**
 * Next.js dev-time rewrite rules for routing Pyric bridge, socket, Functions
 * gateway (`/__pyric/functions/*`), emulator callable paths, and `firebase.json`
 * Hosting function rewrites.
 */
import type { NextConfigObject, PyricNextOptions } from './types.js';
import { resolveSandboxTargetUrl } from './target-url.js';
import { resolveFunctionsGateway, type ResolvedFunctionsGateway } from './functions-target.js';
import {
  assembleEmulatorPathRewrite,
  translateHostingFunctionRewrites,
  type NextRewriteRule,
} from './hosting-rewrites.js';

const PYRIC_PROXY_SOURCE = '/__pyric/:path*';
const PYRIC_PROXY_PATH = '/__pyric/:path*';
const PYRIC_FUNCTIONS_SOURCE = '/__pyric/functions/:path*';
const PYRIC_FUNCTIONS_DEST_PATH = '/:path*';

interface RewritesObject {
  beforeFiles?: NextRewriteRule[];
  afterFiles?: NextRewriteRule[];
  fallback?: NextRewriteRule[];
  [key: string]: unknown;
}

function shouldSkipRewrites(options?: PyricNextOptions): boolean {
  if (options === undefined) {
    return false;
  }
  return options.rewrites === false;
}

function assembleRewriteRule(options?: PyricNextOptions, hasI18n = false): NextRewriteRule {
  const targetUrl = resolveSandboxTargetUrl(options);
  const destinationUrl = `${targetUrl}${PYRIC_PROXY_PATH}`;
  return {
    source: PYRIC_PROXY_SOURCE,
    destination: destinationUrl,
    // The browser runtime requests `/__pyric/*` at the origin root. Without
    // these flags, Next prefixes the source with a configured basePath or i18n locale.
    basePath: false,
    ...(hasI18n ? { locale: false as const } : {}),
  };
}

function assembleFunctionsProxyRule(targetUrl: string, hasI18n = false): NextRewriteRule {
  return {
    source: PYRIC_FUNCTIONS_SOURCE,
    destination: `${targetUrl}${PYRIC_FUNCTIONS_DEST_PATH}`,
    basePath: false,
    ...(hasI18n ? { locale: false as const } : {}),
  };
}

function prependToArrayRewrites(existing: NextRewriteRule[], pyricRule: NextRewriteRule): NextRewriteRule[] {
  return [pyricRule, ...existing];
}

function prependToObjectRewrites(existing: RewritesObject, pyricRule: NextRewriteRule): RewritesObject {
  const beforeFilesList = Array.isArray(existing.beforeFiles) ? existing.beforeFiles : [];
  return Object.assign({}, existing, { beforeFiles: [pyricRule, ...beforeFilesList] });
}

function assembleFunctionsRewriteBuckets(
  gateway: ResolvedFunctionsGateway,
  hasI18n: boolean,
): {
  beforeFiles: NextRewriteRule[];
  afterFiles: NextRewriteRule[];
  fallback: NextRewriteRule[];
} {
  const beforeFiles: NextRewriteRule[] = [assembleFunctionsProxyRule(gateway.targetUrl, hasI18n)];
  const afterFiles: NextRewriteRule[] = [];
  const fallback: NextRewriteRule[] = [];
  const seenAfterSources = new Set<string>();

  if (gateway.projectId !== null) {
    const emulatorRule = assembleEmulatorPathRewrite(gateway.projectId, gateway.targetUrl, hasI18n);
    if (emulatorRule !== null) {
      seenAfterSources.add(emulatorRule.source);
      afterFiles.push(emulatorRule);
    }
  }

  if (gateway.includeHostingRewrites && gateway.firebaseJson !== null) {
    const translated = translateHostingFunctionRewrites(gateway.firebaseJson, gateway.targetUrl, {
      hasI18n,
      onWarning: (warning) => console.warn(`[Pyric] ${warning}`),
    });
    for (const rule of translated.afterFiles) {
      if (seenAfterSources.has(rule.source)) continue;
      seenAfterSources.add(rule.source);
      afterFiles.push(rule);
    }
    fallback.push(...translated.fallback);
  }

  return { beforeFiles, afterFiles, fallback };
}

function mergeWithFunctionsRewrites(
  existing: unknown,
  pyricBeforeRules: NextRewriteRule[],
  functionsAfterRules: NextRewriteRule[],
  functionsFallbackRules: NextRewriteRule[],
): RewritesObject {
  if (Array.isArray(existing)) {
    return {
      beforeFiles: [...pyricBeforeRules],
      afterFiles: [...(existing as NextRewriteRule[]), ...functionsAfterRules],
      fallback: [...functionsFallbackRules],
    };
  }
  if (typeof existing === 'object' && existing !== null) {
    const existingObj = existing as RewritesObject;
    const existingBefore = Array.isArray(existingObj.beforeFiles) ? existingObj.beforeFiles : [];
    const existingAfter = Array.isArray(existingObj.afterFiles) ? existingObj.afterFiles : [];
    const existingFallback = Array.isArray(existingObj.fallback) ? existingObj.fallback : [];
    return Object.assign({}, existingObj, {
      beforeFiles: [...pyricBeforeRules, ...existingBefore],
      afterFiles: [...existingAfter, ...functionsAfterRules],
      fallback: [...existingFallback, ...functionsFallbackRules],
    });
  }
  return {
    beforeFiles: [...pyricBeforeRules],
    afterFiles: [...functionsAfterRules],
    fallback: [...functionsFallbackRules],
  };
}

/**
 * Attach Pyric dev-time rewrites to ensure zero-CORS browser runtime
 * communication and proxy Functions gateway / Hosting function rewrites when
 * a local Functions gateway is active.
 */
export function augmentDevRewrites(
  config: NextConfigObject,
  options?: PyricNextOptions,
  resolvedGateway?: ResolvedFunctionsGateway | null,
): NextConfigObject {
  if (shouldSkipRewrites(options)) {
    return config;
  }

  const updatedConfig: NextConfigObject = Object.assign({}, config);
  const hasI18n = typeof updatedConfig.i18n === 'object' && updatedConfig.i18n !== null;
  const pyricRule = assembleRewriteRule(options, hasI18n);
  const gateway = resolvedGateway !== undefined ? resolvedGateway : resolveFunctionsGateway(options);
  const originalRewrites = updatedConfig.rewrites;

  if (gateway === null) {
    updatedConfig.rewrites = async () => {
      if (typeof originalRewrites === 'function') {
        const existingRewrites = await originalRewrites();
        if (Array.isArray(existingRewrites)) {
          return prependToArrayRewrites(existingRewrites, pyricRule);
        }
        if (typeof existingRewrites === 'object' && existingRewrites !== null) {
          return prependToObjectRewrites(existingRewrites as RewritesObject, pyricRule);
        }
      }
      return [pyricRule];
    };
    return updatedConfig;
  }

  const fnBuckets = assembleFunctionsRewriteBuckets(gateway, hasI18n);
  // `/__pyric/functions/:path*` must precede `/__pyric/:path*` so Functions
  // proxy traffic strips the `/__pyric/functions` prefix instead of being
  // swallowed by the general `/__pyric/*` namespace rule.
  const pyricBeforeRules = [...fnBuckets.beforeFiles, pyricRule];

  updatedConfig.rewrites = async () => {
    const existingRewrites = typeof originalRewrites === 'function' ? await originalRewrites() : undefined;
    return mergeWithFunctionsRewrites(
      existingRewrites,
      pyricBeforeRules,
      fnBuckets.afterFiles,
      fnBuckets.fallback,
    );
  };

  return updatedConfig;
}
