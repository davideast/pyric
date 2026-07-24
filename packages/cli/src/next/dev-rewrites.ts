/**
 * Next.js dev-time rewrite rules for routing Pyric bridge and socket traffic.
 */
import type { NextConfigObject, PyricNextOptions } from './types.js';
import { resolveSandboxTargetUrl } from './target-url.js';

const PYRIC_PROXY_SOURCE = '/__pyric/:path*';
const PYRIC_PROXY_PATH = '/__pyric/:path*';

interface RewriteRule {
  source: string;
  destination: string;
}

interface RewritesObject {
  beforeFiles?: RewriteRule[];
  afterFiles?: RewriteRule[];
  fallback?: RewriteRule[];
  [key: string]: unknown;
}

function shouldSkipRewrites(options?: PyricNextOptions): boolean {
  if (options === undefined) {
    return false;
  }
  return options.rewrites === false;
}

function assembleRewriteRule(options?: PyricNextOptions): RewriteRule {
  const targetUrl = resolveSandboxTargetUrl(options);
  const destinationUrl = `${targetUrl}${PYRIC_PROXY_PATH}`;
  const rule: RewriteRule = {
    source: PYRIC_PROXY_SOURCE,
    destination: destinationUrl,
  };
  return rule;
}

function prependToArrayRewrites(existing: RewriteRule[], pyricRule: RewriteRule): RewriteRule[] {
  const combinedRules = [pyricRule, ...existing];
  return combinedRules;
}

function prependToObjectRewrites(existing: RewritesObject, pyricRule: RewriteRule): RewritesObject {
  const beforeFilesList = Array.isArray(existing.beforeFiles) ? existing.beforeFiles : [];
  const updatedBeforeFiles = [pyricRule, ...beforeFilesList];
  const updatedObject: RewritesObject = Object.assign({}, existing, { beforeFiles: updatedBeforeFiles });
  return updatedObject;
}

/**
 * Attach Pyric dev-time rewrites to ensure zero-CORS browser runtime communication.
 */
export function augmentDevRewrites(config: NextConfigObject, options?: PyricNextOptions): NextConfigObject {
  if (shouldSkipRewrites(options)) {
    return config;
  }

  const updatedConfig: NextConfigObject = Object.assign({}, config);
  const pyricRule = assembleRewriteRule(options);
  const originalRewrites = updatedConfig.rewrites;

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
