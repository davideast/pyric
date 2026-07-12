/**
 * Adapter wrapping {@link LocalEnvironment} so it satisfies the
 * `CrawlerFirestore` + `CollectionGroupCapableFirestore` contracts that
 * `firestore_discover_paths` and `firestore_find_collection_group`
 * depend on.
 *
 * Why this exists:
 *   The discover tools normally target firebase-admin's `Firestore`
 *   over the network. Driving them against {@link LocalEnvironment}
 *   instead lets unit + integration tests run hermetically — no
 *   service-account credentials, no live project, no permissions
 *   surprises. The adapter:
 *     - derives collection IDs from the in-memory keyspace
 *     - synthesizes `_fieldsProto` via {@link ../simulator/wire-encoder}
 *       so the crawler's wire-format reader sees what it expects
 *     - implements `collectionGroup(id)` by scanning paths whose
 *       penultimate segment matches `id`
 *
 * Phantom parent docs (Item 4):
 *   `LocalEnvironment.listDocuments(parent)` synthesizes empty records
 *   for any parent id whose only existence is via descendant paths. This
 *   adapter forwards those phantoms as doc refs whose `.get()` returns
 *   an empty `_fieldsProto` — matching how live Firestore exposes parent
 *   docs that have subcollections but no fields. Phantom refs are
 *   detected via the `phantom` flag on the list result.
 *
 * Limitations:
 *   - `collectionGroup().select()` is a no-op chainable: the discover
 *     tools call `.select()` with no args (refs only), so projection
 *     semantics aren't needed.
 */
import type { LocalEnvironment } from 'pyric/sandbox/internal';
import type {
  CrawlerCollectionRef,
  CrawlerDocumentRef,
  CrawlerFirestore,
} from './crawler.js';
import type {
  CollectionGroupCapableFirestore,
  CollectionGroupQuery,
  CollectionGroupSnapshot,
} from './findCollectionGroup.js';
import type { WireDocumentSnapshot } from './wire.js';
import { encodeFieldsProto } from 'pyric/sandbox/internal';

/**
 * Wrap a {@link LocalEnvironment} as a Firestore root that satisfies
 * the discover/crawler + find-collection-group contracts.
 */
export class LocalEnvironmentCrawlerAdapter
  implements CrawlerFirestore, CollectionGroupCapableFirestore
{
  constructor(private readonly env: LocalEnvironment) {}

  async listCollections(): Promise<CrawlerCollectionRef[]> {
    return this.env.listRootCollections().map((id) => this.makeCollectionRef(id));
  }

  collection(path: string): CrawlerCollectionRef {
    return this.makeCollectionRef(path);
  }

  doc(path: string): CrawlerDocumentRef {
    return this.makeDocRef(path);
  }

  collectionGroup(collectionId: string): CollectionGroupQuery {
    // Scan the keyspace for docs whose penultimate segment equals `collectionId`.
    // A document path is always odd-segments-deep — collection/doc/collection/doc...
    // so segments.length is even and segments[length-2] is the host collection ID.
    const matches: CollectionGroupSnapshot[] = [];
    for (const path of Object.keys(this.env.snapshot())) {
      const segments = path.split('/');
      if (segments.length < 2 || segments.length % 2 !== 0) continue;
      const hostId = segments[segments.length - 2]!;
      if (hostId !== collectionId) continue;
      const parentPath = segments.slice(0, -1).join('/');
      matches.push({ ref: { parent: { path: parentPath } } });
    }
    return makeChainableQuery(matches);
  }

  // ─── Internal factories ───────────────────────────────────────────────

  private makeCollectionRef(path: string): CrawlerCollectionRef {
    const id = path.split('/').pop()!;
    const env = this.env;
    const adapter = this;
    return {
      id,
      path,
      async listDocuments(): Promise<CrawlerDocumentRef[]> {
        return env.listDocuments(path).map(({ path: docPath, data, phantom }) =>
          // Phantom parents: pass `{}` so `.get()` materializes an empty
          // `_fieldsProto`, matching live Firestore's parent-with-only-
          // subcollections shape. We feed `knownData` either way so the
          // crawler avoids a redundant lookup against a non-existent doc.
          adapter.makeDocRef(docPath, phantom ? {} : data),
        );
      },
    };
  }

  private makeDocRef(
    path: string,
    knownData?: Record<string, unknown>,
  ): CrawlerDocumentRef {
    const id = path.split('/').pop()!;
    const env = this.env;
    const adapter = this;
    return {
      id,
      path,
      async listCollections(): Promise<CrawlerCollectionRef[]> {
        return env
          .listSubcollections(path)
          .map((subId) => adapter.makeCollectionRef(`${path}/${subId}`));
      },
      async get(): Promise<WireDocumentSnapshot> {
        // Prefer cached data from the listDocuments traversal; fall back to
        // a fresh lookup for ad-hoc doc() refs (e.g., the resume path).
        const data = knownData ?? env.getDocument(path) ?? {};
        return {
          _fieldsProto: encodeFieldsProto(data),
          ref: { path },
        };
      },
    };
  }
}

/**
 * Build a chainable {@link CollectionGroupQuery} over an in-memory match
 * list. Mirrors the firebase-admin `Query` shape used by `findCollectionGroup`:
 * `select()` is a no-op (refs only); `limit(n)` truncates; `get()` resolves.
 */
function makeChainableQuery(matches: CollectionGroupSnapshot[]): CollectionGroupQuery {
  const build = (current: CollectionGroupSnapshot[]): CollectionGroupQuery => ({
    select: () => build(current),
    limit: (n: number) => build(current.slice(0, n)),
    get: async () => ({ docs: current }),
  });
  return build(matches);
}
