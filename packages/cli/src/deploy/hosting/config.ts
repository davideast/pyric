/**
 * Translate a firebase.json hosting block (`HostingJsonConfig`, the
 * public API shape) into the `versions.create` request's `config`
 * (the REST `ServingConfig`). Mirrors firebase-tools' convertConfig
 * (clones/firebase-tools/src/deploy/hosting/convertConfig.ts) minus
 * the backend (functions/Run) endpoint validation — Hosting itself
 * re-validates rewrite targets at finalize time, which core.ts maps
 * to REWRITE_TARGET_NOT_FOUND.
 *
 * Pure mapping, isolated here so tests can pin every request body
 * against convertConfig.ts without spinning up the full deploy.
 *
 * Contract (parity plan "Done means"): every key is either supported,
 * rejected with a clear reason (dynamicLinks → sunset, pinTag →
 * deferred), or warned about — NEVER silently dropped.
 */
import type {
  HostingHeaderJson,
  HostingJsonConfig,
  HostingRedirectJson,
  HostingRewriteJson,
  HostingSource,
} from './spec.js';
import type {
  VersionConfig,
  VersionHasPattern,
  VersionHeaderEntry,
  VersionRedirectEntry,
  VersionRewriteEntry,
} from './types.js';

export type BuildVersionConfigResult =
  | { ok: true; config: VersionConfig; warnings: string[] }
  | { ok: false; message: string };

/** Keys this builder translates into the version config. */
const SERVING_KEYS = new Set([
  'rewrites',
  'redirects',
  'headers',
  'cleanUrls',
  'trailingSlash',
  'appAssociation',
  'i18n',
]);

/**
 * firebase.json hosting keys consumed by OTHER deploy inputs — present
 * here they do nothing, so warn with a pointer instead of dropping.
 */
const DEPLOY_LAYER_KEYS: Record<string, string> = {
  public: 'handled by the `localDir` / `files` input, not the version config',
  source: 'web-frameworks `source` deploys are not supported (use `public` + `localDir`)',
  site: 'handled by the `siteId` input',
  target: 'resolved to a site by the CLI (.firebaserc targets), not the version config',
  ignore: 'handled by the `ignore` input (applied while walking `localDir`)',
  predeploy: 'predeploy hooks are not run by pyric deploy',
  postdeploy: 'postdeploy hooks are not run by pyric deploy',
  frameworksBackend: 'web-frameworks integration is not supported',
};

export function buildVersionConfig(hosting?: HostingJsonConfig): BuildVersionConfigResult {
  if (!hosting) return { ok: true, config: {}, warnings: [] };
  if (typeof hosting !== 'object' || Array.isArray(hosting)) {
    return { ok: false, message: 'hosting config must be an object' };
  }

  const warnings: string[] = [];
  for (const key of Object.keys(hosting)) {
    if (SERVING_KEYS.has(key)) continue;
    const hint = DEPLOY_LAYER_KEYS[key];
    warnings.push(
      hint
        ? `hosting config key '${key}' ignored — ${hint}`
        : `unknown hosting config key '${key}' ignored — not part of the supported firebase.json hosting schema`,
    );
  }

  const config: VersionConfig = {};

  if (hosting.rewrites !== undefined) {
    if (!Array.isArray(hosting.rewrites)) {
      return { ok: false, message: 'hosting.rewrites must be an array' };
    }
    const rewrites: VersionRewriteEntry[] = [];
    for (let i = 0; i < hosting.rewrites.length; i++) {
      const out = convertRewrite(hosting.rewrites[i] as HostingRewriteJson, i);
      if (typeof out === 'string') return { ok: false, message: out };
      rewrites.push(out);
    }
    if (rewrites.length > 0) config.rewrites = rewrites;
  }

  if (hosting.redirects !== undefined) {
    if (!Array.isArray(hosting.redirects)) {
      return { ok: false, message: 'hosting.redirects must be an array' };
    }
    const redirects: VersionRedirectEntry[] = [];
    for (let i = 0; i < hosting.redirects.length; i++) {
      const out = convertRedirect(hosting.redirects[i] as HostingRedirectJson, i);
      if (typeof out === 'string') return { ok: false, message: out };
      redirects.push(out);
    }
    if (redirects.length > 0) config.redirects = redirects;
  }

  if (hosting.headers !== undefined) {
    if (!Array.isArray(hosting.headers)) {
      return { ok: false, message: 'hosting.headers must be an array' };
    }
    const headers: VersionHeaderEntry[] = [];
    for (let i = 0; i < hosting.headers.length; i++) {
      const out = convertHeader(hosting.headers[i] as HostingHeaderJson, i);
      if (typeof out === 'string') return { ok: false, message: out };
      headers.push(out);
    }
    if (headers.length > 0) config.headers = headers;
  }

  if (hosting.cleanUrls !== undefined) {
    if (typeof hosting.cleanUrls !== 'boolean') {
      return { ok: false, message: 'hosting.cleanUrls must be a boolean' };
    }
    config.cleanUrls = hosting.cleanUrls;
  }

  // firebase.json's boolean becomes the REST enum (convertConfig.ts:302-304).
  if (hosting.trailingSlash !== undefined) {
    if (typeof hosting.trailingSlash !== 'boolean') {
      return { ok: false, message: 'hosting.trailingSlash must be a boolean' };
    }
    config.trailingSlashBehavior = hosting.trailingSlash ? 'ADD' : 'REMOVE';
  }

  if (hosting.appAssociation !== undefined) {
    if (hosting.appAssociation !== 'AUTO' && hosting.appAssociation !== 'NONE') {
      return { ok: false, message: "hosting.appAssociation must be 'AUTO' or 'NONE'" };
    }
    config.appAssociation = hosting.appAssociation;
  }

  if (hosting.i18n !== undefined) {
    if (
      !hosting.i18n ||
      typeof hosting.i18n !== 'object' ||
      typeof (hosting.i18n as { root?: unknown }).root !== 'string' ||
      !(hosting.i18n as { root: string }).root
    ) {
      return { ok: false, message: 'hosting.i18n must be an object with a non-empty string `root`' };
    }
    config.i18n = { root: (hosting.i18n as { root: string }).root };
  }

  return { ok: true, config, warnings };
}

/**
 * Extract exactly one glob/regex pattern (convertConfig.ts:19-41).
 * `source` and `glob` are interchangeable glob spellings; when both
 * are present `glob` wins (mirrors extractPattern's assignment
 * order). glob + regex together is an error; neither is an error.
 */
function extractPattern(
  type: string,
  source: Partial<Record<'glob' | 'source' | 'regex', unknown>>,
  index: number,
): VersionHasPattern | string {
  let glob: string | undefined;
  let regex: string | undefined;
  if (typeof source.source === 'string' && source.source) glob = source.source;
  if (typeof source.glob === 'string' && source.glob) glob = source.glob;
  if (typeof source.regex === 'string' && source.regex) regex = source.regex;

  if (glob && regex) {
    return `hosting.${type}s[${index}]: cannot specify a ${type} pattern with both a glob and regex`;
  }
  if (glob) return { glob };
  if (regex) return { regex };
  return `hosting.${type}s[${index}]: a ${type} needs a pattern (one of \`source\`, \`glob\` or \`regex\`)`;
}

/** Rewrite targets → REST behavior (convertConfig.ts:135-272). Returns the entry or an error string. */
function convertRewrite(rewrite: HostingRewriteJson, index: number): VersionRewriteEntry | string {
  if (!rewrite || typeof rewrite !== 'object') {
    return `hosting.rewrites[${index}] must be an object`;
  }
  const pattern = extractPattern('rewrite', rewrite as HostingSource, index);
  if (typeof pattern === 'string') return pattern;

  if ('destination' in rewrite) {
    // Static rewrite: destination → REST `path` (convertConfig.ts:137-141).
    if (typeof rewrite.destination !== 'string' || !rewrite.destination) {
      return `hosting.rewrites[${index}].destination must be a non-empty string`;
    }
    return { ...pattern, path: rewrite.destination };
  }

  if ('function' in rewrite) {
    // Legacy string form `{ function: "id", region? }` — firebase-tools
    // normalizes it to the object form before converting
    // (clones/firebase-tools/src/hosting/config.ts:262-289).
    if (typeof rewrite.function === 'string') {
      if (!rewrite.function) {
        return `hosting.rewrites[${index}].function must be a non-empty string`;
      }
      const region = (rewrite as { region?: unknown }).region;
      if (region !== undefined && (typeof region !== 'string' || !region)) {
        return `hosting.rewrites[${index}].region must be a non-empty string`;
      }
      return {
        ...pattern,
        function: rewrite.function,
        ...(region ? { functionRegion: region as string } : {}),
      };
    }
    // Object form → scalar `function` + sibling `functionRegion`
    // (convertConfig.ts:184-187, 203-207).
    const fn = rewrite.function as { functionId?: unknown; region?: unknown; pinTag?: unknown };
    if (!fn || typeof fn !== 'object' || typeof fn.functionId !== 'string' || !fn.functionId) {
      return `hosting.rewrites[${index}].function.functionId must be a non-empty string`;
    }
    if (fn.pinTag) {
      return (
        `hosting.rewrites[${index}]: \`pinTag\` is not supported yet — pinning a channel to a ` +
        `function/Run revision needs Run traffic tagging (deferred; see design rationale Track C)`
      );
    }
    if (fn.region !== undefined && (typeof fn.region !== 'string' || !fn.region)) {
      return `hosting.rewrites[${index}].function.region must be a non-empty string`;
    }
    return {
      ...pattern,
      function: fn.functionId,
      ...(fn.region ? { functionRegion: fn.region as string } : {}),
    };
  }

  if ('run' in rewrite) {
    // Run rewrite (convertConfig.ts:248-260); region defaults to
    // us-central1 client-side (convertConfig.ts:252).
    const run = rewrite.run as { serviceId?: unknown; region?: unknown; pinTag?: unknown };
    if (!run || typeof run !== 'object' || typeof run.serviceId !== 'string' || !run.serviceId) {
      return `hosting.rewrites[${index}].run.serviceId must be a non-empty string`;
    }
    if (run.pinTag) {
      return (
        `hosting.rewrites[${index}]: \`pinTag\` is not supported yet — pinning a channel to a ` +
        `function/Run revision needs Run traffic tagging (deferred; see design rationale Track C)`
      );
    }
    if (run.region !== undefined && (typeof run.region !== 'string' || !run.region)) {
      return `hosting.rewrites[${index}].run.region must be a non-empty string`;
    }
    return {
      ...pattern,
      run: { serviceId: run.serviceId, region: (run.region as string) || 'us-central1' },
    };
  }

  if ('dynamicLinks' in rewrite) {
    // Firebase Dynamic Links shut down on 2025-08-25 — reject with the
    // reason rather than forwarding a rewrite that can never serve.
    return (
      `hosting.rewrites[${index}]: \`dynamicLinks\` rewrites are not supported — ` +
      `Firebase Dynamic Links was sunset (August 2025); remove the rewrite`
    );
  }

  // Mirror convertConfig.ts:263-271's exhaustiveness error.
  return (
    `hosting.rewrites[${index}] must specify one of 'destination', 'function' or 'run' ` +
    `('dynamicLinks' is sunset)`
  );
}

/** Redirects: destination → location, type → statusCode (convertConfig.ts:279-288). */
function convertRedirect(
  redirect: HostingRedirectJson,
  index: number,
): VersionRedirectEntry | string {
  if (!redirect || typeof redirect !== 'object') {
    return `hosting.redirects[${index}] must be an object`;
  }
  const pattern = extractPattern('redirect', redirect as HostingSource, index);
  if (typeof pattern === 'string') return pattern;
  if (typeof redirect.destination !== 'string' || !redirect.destination) {
    return `hosting.redirects[${index}].destination must be a non-empty string`;
  }
  // `statusCode` only when `type` is present (convertConfig.ts:284-286)
  // — Hosting serves 301 by default.
  if (redirect.type !== undefined && typeof redirect.type !== 'number') {
    return `hosting.redirects[${index}].type must be a number (HTTP status code)`;
  }
  return {
    ...pattern,
    location: redirect.destination,
    ...(redirect.type !== undefined ? { statusCode: redirect.type } : {}),
  };
}

/** Headers: firebase.json's `[{key,value}]` array → REST map (convertConfig.ts:289-299). */
function convertHeader(header: HostingHeaderJson, index: number): VersionHeaderEntry | string {
  if (!header || typeof header !== 'object') {
    return `hosting.headers[${index}] must be an object`;
  }
  const pattern = extractPattern('header', header as HostingSource, index);
  if (typeof pattern === 'string') return pattern;
  if (!Array.isArray(header.headers)) {
    return `hosting.headers[${index}].headers must be an array of { key, value }`;
  }
  const map: Record<string, string> = {};
  for (let j = 0; j < header.headers.length; j++) {
    const h = header.headers[j] as { key?: unknown; value?: unknown };
    if (!h || typeof h.key !== 'string' || !h.key || typeof h.value !== 'string') {
      return `hosting.headers[${index}].headers[${j}] must be { key: string, value: string }`;
    }
    map[h.key] = h.value;
  }
  return { ...pattern, headers: map };
}
