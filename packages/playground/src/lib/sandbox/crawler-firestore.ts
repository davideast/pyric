/**
 * Sandbox-backed `CrawlerFirestore`. Wraps `SandboxRunner.readState()`
 * so the discover-paths crawler can walk the in-browser simulator
 * tree without any sign-in, OAuth token, or real Firebase project.
 *
 * Why this exists: the playground's natural surface IS the sandbox.
 * Requiring a signed-in real project before the agent can answer
 * "what does my data look like" forces a UX dance for the wrong
 * thing. This adapter makes discover work out of the box.
 *
 * What it does:
 *   - Materialize the sandbox snapshot (flat `Record<path, data>`)
 *     into the implicit tree the crawler expects.
 *   - Expose `listCollections` / `listDocuments` / per-doc
 *     `listCollections` over that tree.
 *   - Convert each doc's plain-JS data into the wire `_fieldsProto`
 *     shape the discover pipeline reads.
 *
 * Phantom-parent docs are preserved: if a path `a/b/c/d` exists,
 * `a/b` is exposed even when no doc lives directly at that path,
 * so the schema for `a/{aId}` sees the subcollection.
 */
import type {
  CrawlerCollectionRef,
  CrawlerDocumentRef,
  CrawlerFirestore,
  WireDocumentSnapshot,
} from '@pyric/cli/discover';

type Snapshot = Record<string, unknown>;

interface DocNode {
  /** Plain JS data if a concrete doc exists at this path. Phantom
   *  parents leave this undefined. */
  data?: Record<string, unknown>;
  /** Subcollection IDs keyed off this doc. */
  subcollections: Set<string>;
}

interface CollectionNode {
  /** Doc IDs inside this collection — concrete OR phantom parent. */
  docIds: Set<string>;
}

interface Tree {
  /** Collection path → node. Root collections have IDs as keys
   *  (e.g. `users`); nested ones use full collection paths
   *  (`users/alice/posts`). */
  collections: Map<string, CollectionNode>;
  /** Doc path → node. */
  docs: Map<string, DocNode>;
  /** Root collection IDs in insertion order. */
  rootIds: string[];
}

function buildTree(snap: Snapshot): Tree {
  const collections = new Map<string, CollectionNode>();
  const docs = new Map<string, DocNode>();
  const rootIds: string[] = [];
  const rootIdSet = new Set<string>();

  function ensureCollection(path: string): CollectionNode {
    let node = collections.get(path);
    if (!node) {
      node = { docIds: new Set() };
      collections.set(path, node);
    }
    return node;
  }
  function ensureDoc(path: string): DocNode {
    let node = docs.get(path);
    if (!node) {
      node = { subcollections: new Set() };
      docs.set(path, node);
    }
    return node;
  }

  for (const [docPath, data] of Object.entries(snap)) {
    const segs = docPath.split('/');
    if (segs.length < 2 || segs.length % 2 !== 0) {
      // Not a doc path (must alternate collection/doc, doc-terminal).
      continue;
    }
    // Walk every collection→doc boundary so phantom parents register.
    for (let i = 0; i < segs.length; i += 2) {
      const collPath = segs.slice(0, i + 1).join('/');
      const docId = segs[i + 1]!;
      const docPathHere = `${collPath}/${docId}`;
      const collNode = ensureCollection(collPath);
      collNode.docIds.add(docId);
      ensureDoc(docPathHere);
      if (i === 0 && !rootIdSet.has(collPath)) {
        rootIdSet.add(collPath);
        rootIds.push(collPath);
      }
      // The doc at depth i hosts the next collection (if any).
      if (i + 2 < segs.length) {
        const subId = segs[i + 2]!;
        docs.get(docPathHere)!.subcollections.add(subId);
      }
    }
    // Attach the actual data only at the terminal doc.
    docs.get(docPath)!.data = data as Record<string, unknown>;
  }

  return { collections, docs, rootIds };
}

// ─── Wire-format conversion ───────────────────────────────────────────────

function jsValueToWire(v: unknown): Record<string, unknown> {
  if (v === null) return { nullValue: 'NULL_VALUE' };
  if (typeof v === 'boolean') return { booleanValue: v };
  if (typeof v === 'number') {
    return Number.isInteger(v) ? { integerValue: String(v) } : { doubleValue: v };
  }
  if (typeof v === 'string') return { stringValue: v };
  if (typeof v === 'bigint') return { integerValue: String(v) };
  if (v instanceof Date) {
    return { timestampValue: v.toISOString() };
  }
  // Timestamp duck-type — sandbox stores `Timestamp` instances with
  // `seconds` + `nanoseconds`. Detect structurally to avoid pulling
  // the admin compat class into this browser file.
  if (
    typeof v === 'object' &&
    v !== null &&
    typeof (v as { seconds?: unknown }).seconds === 'number' &&
    typeof (v as { nanoseconds?: unknown }).nanoseconds === 'number'
  ) {
    const ts = v as { seconds: number; nanoseconds: number };
    const ms = ts.seconds * 1000 + Math.floor(ts.nanoseconds / 1_000_000);
    return { timestampValue: new Date(ms).toISOString() };
  }
  if (Array.isArray(v)) {
    return { arrayValue: { values: v.map(jsValueToWire) } };
  }
  if (typeof v === 'object') {
    return { mapValue: { fields: jsObjectToFieldsProto(v as Record<string, unknown>) } };
  }
  // Unknown shape — surface as null so the merge layer doesn't blow
  // up on an unrecognized valueType. The schema entry will be a
  // null observation, which is better than throwing mid-crawl.
  return { nullValue: 'NULL_VALUE' };
}

function jsObjectToFieldsProto(obj: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) {
    out[k] = jsValueToWire(v);
  }
  return out;
}

// ─── Adapter factory ──────────────────────────────────────────────────────

/**
 * Build a `CrawlerFirestore` over a sandbox snapshot. The snapshot is
 * re-read on every top-level `listCollections()` call so the crawler
 * sees current state (the user may have re-run `runOnce` between
 * tool calls).
 */
export function createSandboxCrawlerFirestore(
  getSnapshot: () => Snapshot,
): CrawlerFirestore {
  // Cache the tree per top-level crawl. The crawler issues exactly
  // one `db.listCollections()` per invocation; from there it derives
  // every other ref through the returned objects, which close over
  // `tree`. A new crawl call → new `listCollections()` → fresh tree.
  let tree: Tree | null = null;
  function ensureTree(): Tree {
    if (!tree) tree = buildTree(getSnapshot());
    return tree;
  }
  function freshTree(): Tree {
    tree = buildTree(getSnapshot());
    return tree;
  }

  function makeCollectionRef(collPath: string): CrawlerCollectionRef {
    const segs = collPath.split('/');
    const id = segs[segs.length - 1]!;
    return {
      id,
      path: collPath,
      async listDocuments(): Promise<CrawlerDocumentRef[]> {
        const t = ensureTree();
        const node = t.collections.get(collPath);
        if (!node) return [];
        const docs: CrawlerDocumentRef[] = [];
        for (const docId of node.docIds) {
          docs.push(makeDocumentRef(`${collPath}/${docId}`));
        }
        return docs;
      },
    };
  }

  function makeDocumentRef(docPath: string): CrawlerDocumentRef {
    const segs = docPath.split('/');
    const id = segs[segs.length - 1]!;
    return {
      id,
      path: docPath,
      async listCollections(): Promise<CrawlerCollectionRef[]> {
        const t = ensureTree();
        const node = t.docs.get(docPath);
        if (!node) return [];
        const refs: CrawlerCollectionRef[] = [];
        for (const subId of node.subcollections) {
          refs.push(makeCollectionRef(`${docPath}/${subId}`));
        }
        return refs;
      },
      async get(): Promise<WireDocumentSnapshot> {
        const t = ensureTree();
        const node = t.docs.get(docPath);
        const data = node?.data;
        return {
          _fieldsProto: data ? jsObjectToFieldsProto(data) : {},
          ref: { path: docPath },
        };
      },
    };
  }

  return {
    async listCollections(): Promise<CrawlerCollectionRef[]> {
      const t = freshTree();
      return t.rootIds.map((id) => makeCollectionRef(id));
    },
    collection(path: string): CrawlerCollectionRef {
      return makeCollectionRef(path);
    },
    doc(path: string): CrawlerDocumentRef {
      return makeDocumentRef(path);
    },
  };
}
