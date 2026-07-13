/**
 * REST-backed `CrawlerFirestore` — the minimum surface
 * `firestore_discover_paths` needs, satisfied by hitting the Firestore
 * REST API directly with a Bearer token.
 *
 * Why this exists: the modular Web SDK (`firebase/firestore`) does NOT
 * expose `listCollections()` at all — it's an admin-only operation.
 * Anyone running discover from a browser (or any non-admin environment
 * with an OAuth access token but no firebase-admin) needs this shim
 * because there's no standard SDK alternative.
 *
 * Implements the structural `CrawlerFirestore` / `CrawlerCollectionRef`
 * / `CrawlerDocumentRef` contracts from `./crawler.ts`. The shim is
 * deliberately narrow — no client SDK, no admin SDK, no listeners. The
 * crawler only ever calls `listCollections` / `listDocuments` / `get`,
 * so that's all this provides.
 *
 * Wire format: REST returns `{ name, fields, createTime, updateTime }`
 * where `fields` is the same `Record<string, FirestoreValue>` shape
 * that firebase-admin exposes as `DocumentSnapshot._fieldsProto`. We
 * surface it under exactly that key so `discover/wire.ts`'s
 * `snapshotToObservations()` reads it unchanged — no translation
 * layer, no type-narrowing loss.
 *
 * Auth: caller supplies an access token with `auth/datastore` scope
 * (covered by `auth/firebase`). Token is bearer-injected on every
 * request; expiry is the caller's problem.
 */
import type {
  CrawlerCollectionRef,
  CrawlerDocumentRef,
  CrawlerFirestore,
} from './crawler.js';
import type { WireDocumentSnapshot } from './wire.js';

const FIRESTORE_REST = 'https://firestore.googleapis.com/v1';

export interface RestCrawlerFirestoreOptions {
  /** Google OAuth access token, bearer-injected on every request. */
  accessToken: string;
  /** Firebase project id (project number is also accepted by the REST API). */
  projectId: string;
  /** Database id — defaults to `(default)`. Non-default DBs land in
   *  `databases/<id>` instead of `databases/(default)`. */
  databaseId?: string;
  /** Override fetch — useful for tests. Defaults to global `fetch`. */
  fetchImpl?: typeof fetch;
}

export class RestCrawlerFirestoreError extends Error {
  constructor(
    public readonly status: number,
    public readonly endpoint: string,
    body: string,
  ) {
    super(`RestCrawlerFirestore ${endpoint}: ${status} ${truncate(body, 200)}`);
    this.name = 'RestCrawlerFirestoreError';
  }
}

function truncate(s: string, max: number): string {
  return s.length <= max ? s : `${s.slice(0, max)}…`;
}

/**
 * Build the `CrawlerFirestore` the crawler expects. Returned object
 * satisfies the structural contract — no class, no inheritance.
 */
export function createRestCrawlerFirestore(opts: RestCrawlerFirestoreOptions): CrawlerFirestore {
  const databaseId = opts.databaseId ?? '(default)';
  const docsRoot = `projects/${opts.projectId}/databases/${databaseId}/documents`;
  const fetchImpl: typeof fetch = opts.fetchImpl ?? globalThis.fetch.bind(globalThis);

  async function api(
    method: 'GET' | 'POST',
    fullName: string,
    body?: unknown,
    query?: Record<string, string | undefined>,
  ): Promise<unknown> {
    const qs = query
      ? Object.entries(query)
          .filter(([, v]) => v !== undefined)
          .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v as string)}`)
          .join('&')
      : '';
    const url = `${FIRESTORE_REST}/${fullName}${qs ? `?${qs}` : ''}`;
    const res = await fetchImpl(url, {
      method,
      headers: {
        Authorization: `Bearer ${opts.accessToken}`,
        ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    if (!res.ok) {
      throw new RestCrawlerFirestoreError(res.status, url, await res.text());
    }
    return res.json();
  }

  /**
   * Resolve a list of collection ids under `parentName` (the docs root
   * for top-level collections, or `documents/path/to/doc` for
   * subcollections). The REST endpoint pages, but a Firestore project
   * realistically has <1k collection ids per document — first page is
   * usually enough. We still follow `nextPageToken` defensively.
   */
  async function listCollectionIds(parentName: string): Promise<string[]> {
    const ids: string[] = [];
    let pageToken: string | undefined;
    do {
      const result = (await api(
        'POST',
        `${parentName}:listCollectionIds`,
        pageToken ? { pageToken } : {},
      )) as { collectionIds?: string[]; nextPageToken?: string };
      if (result.collectionIds) ids.push(...result.collectionIds);
      pageToken = result.nextPageToken;
    } while (pageToken);
    return ids;
  }

  /**
   * Build a `CrawlerCollectionRef` from a path relative to the docs
   * root (e.g. `users/alice/posts`). `id` is the last segment.
   */
  function makeCollectionRef(relativePath: string): CrawlerCollectionRef {
    const fullName = `${docsRoot}/${relativePath}`;
    const id = relativePath.slice(relativePath.lastIndexOf('/') + 1);
    return {
      id,
      path: relativePath,
      async listDocuments(): Promise<CrawlerDocumentRef[]> {
        // `mask.fieldPaths=__name__` skips the document bodies — we
        // only need ids/paths here. Sampling fetches bodies later
        // via `get()`. `showMissing=true` so docs that exist only as
        // subcollection parents still surface as refs (matches
        // admin SDK's `listDocuments`).
        const out: CrawlerDocumentRef[] = [];
        let pageToken: string | undefined;
        do {
          const result = (await api('GET', fullName, undefined, {
            'mask.fieldPaths': '__name__',
            showMissing: 'true',
            pageSize: '300',
            pageToken,
          })) as { documents?: { name: string }[]; nextPageToken?: string };
          for (const d of result.documents ?? []) {
            // `name` is the full resource path; strip the docs root
            // to get the workspace-relative path the crawler uses.
            const docPath = d.name.slice(`${docsRoot}/`.length);
            out.push(makeDocumentRef(docPath));
          }
          pageToken = result.nextPageToken;
        } while (pageToken);
        return out;
      },
    };
  }

  /**
   * Build a `CrawlerDocumentRef` from a path relative to the docs
   * root (e.g. `users/alice`). `id` is the last segment.
   */
  function makeDocumentRef(relativePath: string): CrawlerDocumentRef {
    const fullName = `${docsRoot}/${relativePath}`;
    const id = relativePath.slice(relativePath.lastIndexOf('/') + 1);
    return {
      id,
      path: relativePath,
      async listCollections(): Promise<CrawlerCollectionRef[]> {
        const ids = await listCollectionIds(fullName);
        return ids.map((cid) => makeCollectionRef(`${relativePath}/${cid}`));
      },
      async get(): Promise<WireDocumentSnapshot> {
        let result: { name?: string; fields?: Record<string, unknown> };
        try {
          result = (await api('GET', fullName)) as {
            name?: string;
            fields?: Record<string, unknown>;
          };
        } catch (e) {
          // 404 = "phantom missing parent" — a path that has
          // subcollections but no actual doc. firebase-admin's
          // `DocumentReference.get()` returns a snapshot with
          // `exists: false` and no fields here; we mirror that by
          // returning an empty-fields snapshot so the wire reader
          // produces zero observations instead of throwing.
          if (e instanceof RestCrawlerFirestoreError && e.status === 404) {
            return { _fieldsProto: {}, ref: { path: relativePath } };
          }
          throw e;
        }
        // Surface `fields` under the `_fieldsProto` key the wire
        // reader looks for. The REST format is byte-identical to
        // admin SDK's internal protobuf at this level (integerValue
        // vs doubleValue preserved), so no translation is needed.
        return {
          _fieldsProto: result.fields ?? {},
          ref: { path: relativePath },
        };
      },
    };
  }

  return {
    async listCollections(): Promise<CrawlerCollectionRef[]> {
      const ids = await listCollectionIds(docsRoot);
      return ids.map((id) => makeCollectionRef(id));
    },
    collection(path: string): CrawlerCollectionRef {
      return makeCollectionRef(path);
    },
    doc(path: string): CrawlerDocumentRef {
      return makeDocumentRef(path);
    },
  };
}
