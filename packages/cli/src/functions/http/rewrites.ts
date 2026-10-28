/**
 * firebase.json `hosting.rewrites` whose destination is a function.
 *
 * Hosting tries rewrites in order and the first match wins, so a function
 * rewrite only applies when no earlier rewrite (a `**` to `/index.html`, say)
 * matched first, and only when no static file answers the path. The function
 * sees the full original URL (firebase-tools `lib/hosting/proxy.js`). A
 * rewrite that names no region keeps `region: null`: the CLI takes the region
 * from the function's source and falls back to us-central1 only when the
 * source names none (firebase.google.com/docs/hosting/functions), so the
 * gateway resolves it against the discovered functions.
 *
 * Matching is superstatic 10.0.0's (`lib/utils/patterns.js`): a `source` is
 * `minimatch(path, source)` with minimatch 6.2.3 defaults, and a `regex` is
 * `new RegExp(regex, 'u')`, both against `hostingPathname` (gateway.ts). A
 * `regex` runs as a JavaScript regular expression here, while production
 * Hosting evaluates it with RE2, so a pattern RE2 rejects (a lookahead or a
 * backreference) can match in pyric and fail to deploy.
 */
import { Minimatch } from 'minimatch';

export interface HostingRewrite {
  matches(pathname: string): boolean;
  /** Present when the rewrite's destination is a function. */
  function: RewriteFunction | null;
}

export interface RewriteFunction {
  functionId: string;
  /** The rewrite's `region`, or null when it names none. */
  region: string | null;
}

interface RewriteConfig {
  source?: unknown;
  regex?: unknown;
  function?: unknown;
  region?: unknown;
}

function namedRegion(region: unknown): string | null {
  return typeof region === 'string' && region.length > 0 ? region : null;
}

function functionTarget(rewrite: RewriteConfig): HostingRewrite['function'] {
  if (typeof rewrite.function === 'string') {
    return { functionId: rewrite.function, region: namedRegion(rewrite.region) };
  }
  const target = rewrite.function as { functionId?: unknown; region?: unknown } | undefined;
  if (typeof target === 'object' && target !== null && typeof target.functionId === 'string') {
    return { functionId: target.functionId, region: namedRegion(target.region) };
  }
  return null;
}

function matcher(rewrite: RewriteConfig): ((pathname: string) => boolean) | null {
  if (typeof rewrite.source === 'string') {
    const glob = new Minimatch(rewrite.source);
    return (pathname) => glob.match(pathname);
  }
  if (typeof rewrite.regex === 'string') {
    const regex = new RegExp(rewrite.regex, 'u');
    return (pathname) => regex.test(pathname);
  }
  return null;
}

/**
 * The rewrites of the one hosting config pyric serves (the first, for a
 * multi-site array). A rewrite whose pattern does not compile is skipped and
 * reported to `onWarning`; the rest still apply.
 */
export function hostingRewrites(firebaseJson: unknown, onWarning?: (warning: string) => void): HostingRewrite[] {
  const hosting = (firebaseJson as { hosting?: unknown } | null)?.hosting;
  const site = Array.isArray(hosting) ? hosting[0] : hosting;
  const rewrites = (site as { rewrites?: unknown } | undefined)?.rewrites;
  if (!Array.isArray(rewrites)) return [];
  return rewrites.flatMap((raw, index): HostingRewrite[] => {
    const rewrite = raw as RewriteConfig;
    try {
      const matches = matcher(rewrite);
      return matches ? [{ matches, function: functionTarget(rewrite) }] : [];
    } catch (error) {
      const pattern = JSON.stringify(rewrite.source ?? rewrite.regex);
      onWarning?.(`firebase.json hosting.rewrites[${index}] (${pattern}) is skipped: ${error instanceof Error ? error.message : String(error)}`);
      return [];
    }
  });
}

/** The function the first matching rewrite names, or null when the first match is not a function (or none matches). */
export function rewriteTarget(rewrites: readonly HostingRewrite[], pathname: string): HostingRewrite['function'] {
  const first = rewrites.find((rewrite) => rewrite.matches(pathname));
  return first?.function ?? null;
}

/** Hosting forwards only the `__session` cookie to a function. */
export function sessionCookieOnly(cookie: string | undefined): string | undefined {
  const session = (cookie ?? '').split(/;\s*/).find((part) => part.startsWith('__session='));
  return session;
}
