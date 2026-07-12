/**
 * `pyric firestore:discover [collection?]` — thin wrapper over
 * `@pyric/cli/discover`'s `crawl` against the project's Firestore.
 *
 * Uses the REST-backed `CrawlerFirestore` so this works from any Node
 * environment with a service-account token (no firebase-admin
 * required at runtime).
 *
 * An optional positional `collection` narrows the crawl via the
 * crawler's `rootFilter` — useful for "tell me about this one
 * collection" probes that don't want to walk the whole tree.
 *
 * Prints the discovered schema (templatePath → CollectionSchema map)
 * as JSON.
 */

import {
  crawl,
  createRestCrawlerFirestore,
  type CrawlOptions,
  type CrawlerFirestore,
  type CollectionSchema,
} from '../discover/index.js';
import type { ParsedArgs } from './parse-args.js';
import type { ProjectScope } from '../deploy/index.js';
import { resolveScope } from './scope.js';
import { readFirebaseRc } from './firebase-json.js';

export interface DiscoverDeps {
  resolveScope?: (opts: { projectId?: string }) => Promise<{ scope: ProjectScope; source: string }>;
  /**
   * Build a CrawlerFirestore from a scope + token. Defaults to
   * `createRestCrawlerFirestore`; tests pass a stub here to avoid
   * real RPCs.
   */
  createFirestore?: (opts: { accessToken: string; projectId: string }) => CrawlerFirestore;
  crawl?: typeof crawl;
  readFirebaseRc?: typeof readFirebaseRc;
  cwd?: string;
  stdout?: { write(s: string): void };
  stderr?: { write(s: string): void };
}

export async function runFirestoreDiscover(
  parsed: ParsedArgs,
  deps: DiscoverDeps = {},
): Promise<number> {
  const out = deps.stdout ?? process.stdout;
  const err = deps.stderr ?? process.stderr;

  const flagProject = parsed.flags.get('project');
  const explicit = typeof flagProject === 'string' ? flagProject : undefined;
  let projectIdHint = explicit;
  if (!projectIdHint) {
    const rcRead = deps.readFirebaseRc ?? readFirebaseRc;
    const rc = await rcRead(deps.cwd ?? process.cwd()).catch(() => null);
    projectIdHint = rc?.projects?.default ?? undefined;
  }

  let scope: ProjectScope;
  try {
    const resolveScopeFn = deps.resolveScope ?? resolveScope;
    const resolved = await resolveScopeFn({ projectId: projectIdHint });
    scope = resolved.scope;
  } catch (e) {
    err.write(`${e instanceof Error ? e.message : String(e)}\n`);
    return 1;
  }

  let token: string;
  try {
    token = await scope.resolveToken();
  } catch (e) {
    err.write(
      `pyric firestore:discover: failed to resolve access token: ${e instanceof Error ? e.message : String(e)}\n`,
    );
    return 2;
  }

  const createFirestoreFn = deps.createFirestore ?? createRestCrawlerFirestore;
  const db = createFirestoreFn({ accessToken: token, projectId: scope.projectId });

  const collectionFilter = parsed.positional[0];
  const options: CrawlOptions = collectionFilter
    ? { rootFilter: (id) => id === collectionFilter }
    : {};

  const crawlFn = deps.crawl ?? crawl;
  try {
    const result = await crawlFn(db, options);
    // Convert the Map<string, CollectionSchema> into a plain object
    // for JSON serialization. Maps don't survive `JSON.stringify`
    // — they emit `{}` without explicit conversion.
    const schemaByTemplate: Record<string, CollectionSchema> = {};
    for (const [k, v] of result.finalizedSchemas) {
      schemaByTemplate[k] = v;
    }
    out.write(
      `${JSON.stringify(
        {
          complete: result.complete,
          listOps: result.listOps,
          readOps: result.readOps,
          schemaByTemplate,
        },
        null,
        2,
      )}\n`,
    );
    return 0;
  } catch (e) {
    err.write(`pyric firestore:discover: ${e instanceof Error ? e.message : String(e)}\n`);
    return 2;
  }
}
