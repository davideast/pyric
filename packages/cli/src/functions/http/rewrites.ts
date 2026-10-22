/**
 * firebase.json `hosting.rewrites` whose destination is a function.
 *
 * Hosting tries rewrites in order and the first match wins, so a function
 * rewrite only applies when no earlier rewrite (a `**` to `/index.html`, say)
 * matched first, and only when no static file answers the path. The function
 * sees the full original URL (firebase-tools `lib/hosting/proxy.js`), and the
 * region defaults to us-central1 (`lib/hosting/functionsProxy.js:20-31`).
 */
import { DEFAULT_REGION } from './discovery.js';

export interface HostingRewrite {
  matches(pathname: string): boolean;
  /** Present when the rewrite's destination is a function. */
  function: { functionId: string; region: string } | null;
}

/** A Hosting `source` glob as a RegExp: `**` crosses `/`, `*` and `?` do not, `{a,b}` alternates. */
export function hostingGlob(source: string): RegExp {
  const glob = source.startsWith('/') ? source : `/${source}`;
  let pattern = '';
  for (let index = 0; index < glob.length; index += 1) {
    const char = glob[index];
    const rest = glob.slice(index);
    if (rest.startsWith('/**/')) {
      pattern += '(?:/|/.*/)';
      index += 3;
    } else if (rest === '/**') {
      pattern += '(?:/.*)?';
      index += 2;
    } else if (rest.startsWith('**')) {
      pattern += '.*';
      index += 1;
    } else if (char === '*') {
      pattern += '[^/]*';
    } else if (char === '?') {
      pattern += '[^/]';
    } else if (char === '{') {
      const close = glob.indexOf('}', index);
      if (close === -1) {
        pattern += '\\{';
      } else {
        const options = glob.slice(index + 1, close).split(',').map((option) => option.replace(/[.+^$()|[\]\\]/g, '\\$&'));
        pattern += `(?:${options.join('|')})`;
        index = close;
      }
    } else {
      pattern += char.replace(/[.+^$()|[\]\\]/g, '\\$&');
    }
  }
  return new RegExp(`^${pattern}$`);
}

interface RewriteConfig {
  source?: unknown;
  regex?: unknown;
  function?: unknown;
  region?: unknown;
}

function functionTarget(rewrite: RewriteConfig): HostingRewrite['function'] {
  if (typeof rewrite.function === 'string') {
    return { functionId: rewrite.function, region: typeof rewrite.region === 'string' ? rewrite.region : DEFAULT_REGION };
  }
  const target = rewrite.function as { functionId?: unknown; region?: unknown } | undefined;
  if (typeof target === 'object' && target !== null && typeof target.functionId === 'string') {
    return { functionId: target.functionId, region: typeof target.region === 'string' ? target.region : DEFAULT_REGION };
  }
  return null;
}

function matcher(rewrite: RewriteConfig): ((pathname: string) => boolean) | null {
  if (typeof rewrite.source === 'string') {
    const glob = hostingGlob(rewrite.source);
    return (pathname) => glob.test(pathname);
  }
  if (typeof rewrite.regex === 'string') {
    const regex = new RegExp(rewrite.regex);
    return (pathname) => regex.test(pathname);
  }
  return null;
}

/** The rewrites of the one hosting config pyric serves (the first, for a multi-site array). */
export function hostingRewrites(firebaseJson: unknown): HostingRewrite[] {
  const hosting = (firebaseJson as { hosting?: unknown } | null)?.hosting;
  const site = Array.isArray(hosting) ? hosting[0] : hosting;
  const rewrites = (site as { rewrites?: unknown } | undefined)?.rewrites;
  if (!Array.isArray(rewrites)) return [];
  return rewrites.flatMap((raw): HostingRewrite[] => {
    const rewrite = raw as RewriteConfig;
    const matches = matcher(rewrite);
    return matches ? [{ matches, function: functionTarget(rewrite) }] : [];
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
