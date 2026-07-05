import { Semaphore } from './semaphore.js';
import { CRAWL_DEFAULTS } from './spec.js';
import { fetchDatabase } from '../host.js';
import type { RtdbHost } from '../host.js';
import type { CrawlOptions, CrawlStructureResult, CrawlStructureSpec, StructureNode } from './spec.js';

class CrawlPermissionError extends Error {}

const EMPTY_NODE = (path: string): StructureNode => ({
  path, childCount: 0, truncated: false, children: [], schema: {},
});

export class CrawlStructureHandler implements CrawlStructureSpec {
  async execute(host: RtdbHost, options?: CrawlOptions, userToken?: string): Promise<CrawlStructureResult> {
    const opts = { ...CRAWL_DEFAULTS, ...options };
    const sem = new Semaphore(opts.maxConcurrency);

    try {
      const root = await this.crawlNode(host, opts.path, 0, opts, sem, userToken);
      return { success: true, data: root };
    } catch (e) {
      if (e instanceof CrawlPermissionError) {
        return {
          success: false,
          error: { code: 'PERMISSION_DENIED', message: e.message, recoverable: false },
        };
      }
      return {
        success: false,
        error: { code: 'CRAWL_FAILED', message: e instanceof Error ? e.message : String(e), recoverable: false },
      };
    }
  }

  private async crawlNode(
    host: RtdbHost,
    path: string,
    depth: number,
    opts: Required<CrawlOptions>,
    sem: Semaphore,
    userToken?: string,
  ): Promise<StructureNode> {
    await sem.acquire();
    let shallowData: unknown;
    try {
      const jsonPath = path === '/' ? '/.json' : `${path}.json`;
      const res = await fetchDatabase(host, jsonPath, { shallow: 'true' }, userToken);

      if (res.status === 401 || res.status === 403) {
        if (depth === 0) throw new CrawlPermissionError(`Permission denied at ${path}`);
        return EMPTY_NODE(path);
      }

      shallowData = res.ok ? await res.json().catch(() => null) : null;
    } finally {
      sem.release();
    }

    // Leaf primitive — this node IS a value, not a container
    if (shallowData !== null && typeof shallowData !== 'object') {
      return {
        path,
        childCount: 0,
        truncated: false,
        children: [],
        schema: {},
        valueType: typeof shallowData,
      };
    }

    if (shallowData === null) {
      return EMPTY_NODE(path);
    }

    const data = shallowData as Record<string, unknown>;
    const allKeys = Object.keys(data);
    const childCount = allKeys.length;
    const truncated = childCount > opts.maxChildren;

    // Capture leaf types from the shallow response itself (non-true values)
    const schema: Record<string, string> = {};
    for (const key of allKeys) {
      const val = data[key];
      if (val !== true) {
        schema[key] = val === null ? 'null' : typeof val;
      }
    }

    if (depth >= opts.maxDepth) {
      return { path, childCount, truncated, children: [], schema };
    }

    const objectKeys = allKeys.filter((k) => data[k] === true);
    const keysToExplore = objectKeys.slice(0, opts.maxChildren);

    const children = await Promise.all(
      keysToExplore.map((key) => {
        const childPath = path === '/' ? `/${key}` : `${path}/${key}`;
        return this.crawlNode(host, childPath, depth + 1, opts, sem, userToken).catch(
          () => EMPTY_NODE(childPath),
        );
      }),
    );

    // Populate schema from children that turned out to be leaf primitives
    for (const child of children) {
      if (child.valueType && child.childCount === 0) {
        const seg = child.path.split('/').filter(Boolean).pop()!;
        schema[seg] = child.valueType;
      }
    }

    return { path, childCount, truncated, children, schema };
  }
}
