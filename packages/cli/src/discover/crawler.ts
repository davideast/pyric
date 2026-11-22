/**
 * BFS-layer crawler for `firestore_discover_paths`.
 *
 * Orchestrates layered breadth-first structure discovery (`crawlStructure`)
 * and full discovery + adaptive sampling + session continuation (`crawl`).
 */
import { runWithLimit } from './concurrency.js';
import {
  checkPause,
  emptyResult,
  hydrateDiscovered,
  pauseAndPersist,
  requireCollection,
  serializeDiscovered,
  sessionErrorToEvent,
} from './crawler-persistence.js';
import {
  directChildTemplatePaths,
  inferTemplateVariable,
  recordCollection,
  safeRpc,
  sampleOneTemplate,
  toTemplatePath,
} from './crawler-sampling.js';
import {
  DEFAULT_DRY_RUN_SUBTREE_MULTIPLIER,
  DEFAULT_MAX_BATCH_BYTES,
  DEFAULT_MAX_CONCURRENCY,
  DEFAULT_MAX_DEPTH,
  DEFAULT_MAX_ERRORS_PER_COLLECTION,
  DEFAULT_MAX_SAMPLES,
  DEFAULT_STOP_ON_STABLE,
  type CrawlOptions,
  type CrawlResult,
  type DiscoveredCollection,
  type DryRunCostEstimate,
  type FullCrawlResult,
  type PersistedCrawlState,
  type PersistedDiscoveredCollection,
} from './crawler-types.js';
import type {
  CrawlerCollectionRef,
  CrawlerFirestore,
} from './firestore-source.js';
import type { SessionStore } from './session.js';
import type { CollectionSchema, DiscoverEvent } from './types.js';

export { inferTemplateVariable, toTemplatePath };
export type {
  CrawlOptions,
  CrawlResult,
  DiscoveredCollection,
  DryRunCostEstimate,
  FullCrawlResult,
  PersistedCrawlState,
  PersistedDiscoveredCollection,
};

/**
 * Walk the Firestore tree breadth-first within `maxDepth`, issuing each
 * layer's `listDocuments` and per-doc `listCollections` calls under a shared
 * concurrency cap.
 */
export async function crawlStructure(
  db: CrawlerFirestore,
  options: CrawlOptions = {},
): Promise<CrawlResult> {
  const maxConcurrency = options.maxConcurrency ?? DEFAULT_MAX_CONCURRENCY;
  const maxDepth = options.maxDepth ?? DEFAULT_MAX_DEPTH;
  const rootFilter = options.rootFilter;

  const events: DiscoverEvent[] = [];
  const discovered = new Map<string, DiscoveredCollection>();
  let listOps = 0;

  listOps++;
  const rootsResult = await safeRpc(() => db.listCollections(), '', events);
  let roots = rootsResult ?? [];
  if (rootFilter !== undefined) {
    roots = roots.filter((c) => rootFilter(c.id));
  }
  for (const root of roots) {
    recordCollection(discovered, events, root, 0, undefined);
  }

  let frontier: CrawlerCollectionRef[] = roots;
  for (let depth = 0; depth < maxDepth && frontier.length > 0; depth++) {
    const docsByColl = await runWithLimit(frontier, maxConcurrency, async (coll) => {
      listOps++;
      const tpl = toTemplatePath(coll.path);
      const docs = await safeRpc(() => coll.listDocuments(), tpl, events);
      return docs ?? [];
    });

    for (let i = 0; i < frontier.length; i++) {
      const coll = frontier[i];
      if (coll === undefined) continue;
      const docs = docsByColl[i] ?? [];
      const tpl = toTemplatePath(coll.path);
      const entry = discovered.get(tpl);
      if (entry !== undefined) entry.docRefs.push(...docs);
    }

    const allDocs = docsByColl.flat();
    if (allDocs.length === 0) {
      frontier = [];
      break;
    }

    const subsByDoc = await runWithLimit(allDocs, maxConcurrency, async (docRef) => {
      listOps++;
      const parentCollPath = docRef.path.slice(0, docRef.path.lastIndexOf('/'));
      let tpl = '';
      if (parentCollPath !== '') {
        tpl = toTemplatePath(parentCollPath);
      }
      const subs = await safeRpc(() => docRef.listCollections(), tpl, events);
      return subs ?? [];
    });

    const next: CrawlerCollectionRef[] = [];
    for (let i = 0; i < allDocs.length; i++) {
      const parentDoc = allDocs[i];
      if (parentDoc === undefined) continue;
      const subs = subsByDoc[i] ?? [];
      for (const sub of subs) {
        recordCollection(discovered, events, sub, depth + 1, parentDoc.path);
        next.push(sub);
      }
    }
    frontier = next;
  }

  return { events, discovered, listOps };
}

async function runDryRunCrawl(
  db: CrawlerFirestore,
  options: CrawlOptions,
  maxSamples: number,
  subtreeMultiplier: number,
  events: DiscoverEvent[],
): Promise<FullCrawlResult> {
  if (options.continuation !== undefined) {
    events.push({
      kind: 'error',
      templatePath: '',
      code: 'DRYRUN_NO_CONTINUATION',
      message:
        'dryRun: true does not accept a continuation token - it issues no real crawl. ' +
        'To resume a paused crawl, omit dryRun (or pass false).',
    });
    return emptyResult(events);
  }
  const rootsResult = await safeRpc(() => db.listCollections(), '', events);
  const allRoots = rootsResult ?? [];
  const rootFilter = options.rootFilter;
  let filteredRoots = allRoots;
  if (rootFilter !== undefined) {
    filteredRoots = allRoots.filter((c) => rootFilter(c.id));
  }
  const rootCollectionIds = filteredRoots.map((c) => c.id);
  for (const root of filteredRoots) {
    events.push({ kind: 'collection_discovered', templatePath: root.id, depth: 0 });
  }
  const rootCount = filteredRoots.length;
  const estimate: DryRunCostEstimate = {
    rootCollectionCount: rootCount,
    rootCollectionIds,
    maxSamples,
    subtreeMultiplier,
    estimatedListOps: 1 + rootCount * subtreeMultiplier,
    estimatedReadOps: rootCount * subtreeMultiplier * maxSamples,
  };
  return {
    events,
    discovered: new Map(),
    listOps: 1,
    readOps: 0,
    finalizedSchemas: new Map(),
    complete: true,
    dryRunCostEstimate: estimate,
  };
}

/**
 * Full crawl: discover structure, then sample up to `maxSamples` docs per
 * discovered templatePath and feed them through the merge layer. Supports
 * pause/resume across batches when `sessions` is supplied.
 */
export async function crawl(
  db: CrawlerFirestore,
  options: CrawlOptions = {},
  sessions?: SessionStore<PersistedCrawlState>,
): Promise<FullCrawlResult> {
  const maxConcurrency = options.maxConcurrency ?? DEFAULT_MAX_CONCURRENCY;
  const maxSamples = options.maxSamples ?? DEFAULT_MAX_SAMPLES;
  const maxErrorsPerCollection =
    options.maxErrorsPerCollection ?? DEFAULT_MAX_ERRORS_PER_COLLECTION;
  const stopOnStable = options.stopOnStable ?? DEFAULT_STOP_ON_STABLE;
  const maxDepth = options.maxDepth ?? DEFAULT_MAX_DEPTH;
  const rootFilter = options.rootFilter;
  const maxBatchBytes = options.maxBatchBytes ?? DEFAULT_MAX_BATCH_BYTES;
  const subtreeMultiplier =
    options.dryRunSubtreeMultiplier ?? DEFAULT_DRY_RUN_SUBTREE_MULTIPLIER;

  const events: DiscoverEvent[] = [];

  if (options.dryRun === true) {
    return runDryRunCrawl(db, options, maxSamples, subtreeMultiplier, events);
  }

  let state: PersistedCrawlState;
  if (options.continuation !== undefined) {
    if (sessions === undefined) {
      events.push({
        kind: 'error',
        templatePath: '',
        code: 'NO_SESSION_STORE',
        message: 'Continuation token provided but no SessionStore was passed to crawl().',
      });
      return emptyResult(events);
    }
    const lookup = sessions.get(options.continuation);
    if (!lookup.ok) {
      events.push(sessionErrorToEvent(lookup.error));
      return emptyResult(events);
    }
    state = lookup.value.state;
  } else {
    state = {
      phase: 'structure',
      currentDepth: 0,
      maxDepth,
      frontierPaths: [],
      discovered: {},
      samplingQueue: [],
      finalizedSchemas: {},
      listOps: 0,
      readOps: 0,
    };
  }

  const discovered = hydrateDiscovered(state.discovered, db);
  let frontier: CrawlerCollectionRef[] = [];
  if (state.phase === 'structure' && state.frontierPaths.length > 0) {
    frontier = state.frontierPaths.map((p) => requireCollection(db, p));
  }

  if (state.phase === 'structure') {
    if (state.currentDepth === 0 && frontier.length === 0 && discovered.size === 0) {
      state.listOps++;
      const rootsResult = await safeRpc(() => db.listCollections(), '', events);
      let roots = rootsResult ?? [];
      if (rootFilter !== undefined) {
        roots = roots.filter((c) => rootFilter(c.id));
      }
      for (const root of roots) {
        recordCollection(discovered, events, root, 0, undefined);
      }
      frontier = roots;
    }

    while (frontier.length > 0 && state.currentDepth < state.maxDepth) {
      const depth = state.currentDepth;

      const docsByColl = await runWithLimit(frontier, maxConcurrency, async (coll) => {
        state.listOps++;
        const tpl = toTemplatePath(coll.path);
        const docs = await safeRpc(() => coll.listDocuments(), tpl, events);
        return docs ?? [];
      });

      for (let i = 0; i < frontier.length; i++) {
        const coll = frontier[i];
        if (coll === undefined) continue;
        const docs = docsByColl[i] ?? [];
        const tpl = toTemplatePath(coll.path);
        const entry = discovered.get(tpl);
        if (entry !== undefined) entry.docRefs.push(...docs);
      }

      const allDocs = docsByColl.flat();
      if (allDocs.length === 0) {
        frontier = [];
        state.currentDepth++;
        break;
      }

      const subsByDoc = await runWithLimit(allDocs, maxConcurrency, async (docRef) => {
        state.listOps++;
        const parentCollPath = docRef.path.slice(0, docRef.path.lastIndexOf('/'));
        let tpl = '';
        if (parentCollPath !== '') {
          tpl = toTemplatePath(parentCollPath);
        }
        const subs = await safeRpc(() => docRef.listCollections(), tpl, events);
        return subs ?? [];
      });

      const next: CrawlerCollectionRef[] = [];
      for (let i = 0; i < allDocs.length; i++) {
        const parentDoc = allDocs[i];
        if (parentDoc === undefined) continue;
        const subs = subsByDoc[i] ?? [];
        for (const sub of subs) {
          recordCollection(discovered, events, sub, depth + 1, parentDoc.path);
          next.push(sub);
        }
      }
      frontier = next;
      state.currentDepth++;

      state.frontierPaths = frontier.map((c) => c.path);
      state.discovered = serializeDiscovered(discovered);

      if (sessions !== undefined) {
        const pause = checkPause(state, sessions, maxBatchBytes);
        if (pause !== null) {
          return pauseAndPersist(pause, state, events, discovered, sessions, options);
        }
      }
    }

    state.phase = 'sampling';
    state.frontierPaths = [];
    state.samplingQueue = Array.from(discovered.keys()).filter(
      (tpl) => !(tpl in state.finalizedSchemas),
    );
  }

  while (state.samplingQueue.length > 0) {
    const tpl = state.samplingQueue[0];
    if (tpl === undefined) break;
    const entry = discovered.get(tpl);
    if (entry === undefined) {
      state.samplingQueue.shift();
      continue;
    }

    const { schema: finalizedSchema, readOps: tplReadOps } = await sampleOneTemplate(
      entry,
      { maxConcurrency, maxSamples, stopOnStable, maxErrorsPerCollection },
      events,
    );
    state.readOps += tplReadOps;

    state.finalizedSchemas[tpl] = {
      templatePath: tpl,
      examplePath: entry.examplePath,
      schema: finalizedSchema.schema,
      samplingComplete: finalizedSchema.samplingComplete,
      declaredAt: finalizedSchema.declaredAt,
      subcollectionTemplatePaths: directChildTemplatePaths(tpl, discovered),
    };
    state.samplingQueue.shift();
    state.discovered = serializeDiscovered(discovered);

    if (state.samplingQueue.length > 0 && sessions !== undefined) {
      const pause = checkPause(state, sessions, maxBatchBytes);
      if (pause !== null) {
        return pauseAndPersist(pause, state, events, discovered, sessions, options);
      }
    }
  }

  if (sessions !== undefined && options.continuation !== undefined) {
    sessions.delete(options.continuation);
  }

  const finalizedSchemas = new Map<string, CollectionSchema>();
  for (const [k, v] of Object.entries(state.finalizedSchemas)) {
    finalizedSchemas.set(k, v);
  }

  return {
    events,
    discovered,
    listOps: state.listOps,
    readOps: state.readOps,
    finalizedSchemas,
    complete: true,
  };
}
