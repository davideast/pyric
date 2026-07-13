/** Structural RTDB traversal over an already-local sandbox snapshot. */
export interface RtdbStructureNode {
  path: string;
  childCount: number;
  truncated: boolean;
  children: RtdbStructureNode[];
  schema: Record<string, string>;
  valueType?: string;
}

export interface CrawlSnapshotOptions {
  path?: string;
  maxDepth?: number;
  maxChildren?: number;
}

function childPath(parent: string, key: string): string {
  return parent === '/' ? `/${key}` : `${parent}/${key}`;
}

function valueType(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  return typeof value;
}

function normalizePath(path: string | undefined): string {
  const segments = (path ?? '/').split('/').filter(Boolean);
  return segments.length === 0 ? '/' : `/${segments.join('/')}`;
}

function valueAtPath(value: unknown, path: string): unknown {
  let current = value;
  for (const segment of path.split('/').filter(Boolean)) {
    if (current === null || typeof current !== 'object' || Array.isArray(current)) {
      return null;
    }
    current = (current as Record<string, unknown>)[segment];
  }
  return current ?? null;
}

function crawlNode(
  value: unknown,
  path: string,
  depth: number,
  maxDepth: number,
  maxChildren: number,
): RtdbStructureNode {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return {
      path,
      childCount: 0,
      truncated: false,
      children: [],
      schema: {},
      valueType: valueType(value),
    };
  }

  const entries = Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => left.localeCompare(right));
  const schema: Record<string, string> = {};
  const objectEntries: Array<[string, Record<string, unknown>]> = [];

  for (const [key, child] of entries) {
    if (child !== null && typeof child === 'object' && !Array.isArray(child)) {
      objectEntries.push([key, child as Record<string, unknown>]);
    } else {
      schema[key] = valueType(child);
    }
  }

  const depthTruncated = depth >= maxDepth && objectEntries.length > 0;
  const childLimitTruncated = entries.length > maxChildren;
  const children = depth >= maxDepth
    ? []
    : objectEntries
        .slice(0, maxChildren)
        .map(([key, child]) => crawlNode(
          child,
          childPath(path, key),
          depth + 1,
          maxDepth,
          maxChildren,
        ));

  return {
    path,
    childCount: entries.length,
    truncated: depthTruncated || childLimitTruncated,
    children,
    schema,
  };
}

export function crawlSnapshot(
  snapshot: unknown,
  options: CrawlSnapshotOptions = {},
): RtdbStructureNode {
  const path = normalizePath(options.path);
  const maxDepth = options.maxDepth ?? 10;
  const maxChildren = options.maxChildren ?? 100;
  return crawlNode(
    valueAtPath(snapshot, path),
    path,
    0,
    maxDepth,
    maxChildren,
  );
}

export function countDescendantObjects(node: RtdbStructureNode): number {
  return node.children.reduce(
    (total, child) => total + 1 + countDescendantObjects(child),
    0,
  );
}
