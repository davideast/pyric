/**
 * The seven resource templates the discriminator variant reads through, and
 * the canonical operation each read runs.
 *
 * Reads are resources on this variant, so the operations that fetch state
 * arrive here rather than as tools. One template can serve two operations when
 * its parameter says which: the stdlib module `index` is the catalogue, and
 * any other module is one module's detail.
 */
type Params = Record<string, string>;

/** One resource template as the client sees it, and where a read of it goes. */
export interface DiscriminatorResource {
  uriTemplate: string;
  name: string;
  description: string;
}

/** One route from a resource read to a canonical operation. */
export interface ResourceRoute {
  uriTemplate: string;
  /** Whether a read with these template parameters takes this route. */
  selects(params: Params): boolean;
  operation: string;
  translate(params: Params): Record<string, unknown>;
}

export const DISCRIMINATOR_RESOURCES: readonly DiscriminatorResource[] = [
  {
    uriTemplate: 'pyric://sandbox/status',
    name: 'sandbox_status',
    description:
      'Real-time sandbox service status, active identity lens, mock clock, and document/object counts.',
  },
  {
    uriTemplate: 'pyric://sandbox/events',
    name: 'sandbox_events',
    description:
      'Chronological stream of recorded sandbox requests, mutations, and rule evaluations.',
  },
  {
    uriTemplate: 'pyric://firestore/docs/{path}',
    name: 'firestore_docs',
    description:
      'Read a Firestore document or list documents in a collection by slash-separated path.',
  },
  {
    uriTemplate: 'pyric://database/tree/{path}',
    name: 'database_tree',
    description: 'Inspect Realtime Database JSON tree node and child keys at the specified path.',
  },
  {
    uriTemplate: 'pyric://auth/users',
    name: 'auth_users',
    description: 'List all user records registered in the sandbox Authentication user pool.',
  },
  {
    uriTemplate: 'pyric://storage/objects/{path}',
    name: 'storage_objects',
    description: 'Read metadata for a stored Cloud Storage object by slash-separated path.',
  },
  {
    uriTemplate: 'pyric://stdlib/rules/{module}',
    name: 'stdlib_rules',
    description: 'Inspect Security Rules standard library documentation by module name (or index).',
  },
];

export type ParsedResourceUri =
  | { status: 'unmatched' }
  | { status: 'malformed'; message: string }
  | { status: 'matched'; params: Params };

function nonEmptySegments(path: string): string[] {
  return path.split('/').filter((segment) => segment.length > 0);
}

function isCollectionResourcePath(params: Params): boolean {
  const parts = nonEmptySegments(params.path ?? '');
  return parts.length > 0 && parts.length % 2 === 1;
}

/**
 * The stdlib catalogue reads under this module name; every other name reads
 * one module. The typed service contract treats it the same way.
 */
const STDLIB_INDEX = 'index';

export const RESOURCE_ROUTES: readonly ResourceRoute[] = [
  {
    uriTemplate: 'pyric://sandbox/status',
    selects: () => true,
    operation: 'inspect_sandbox',
    translate: () => ({}),
  },
  {
    uriTemplate: 'pyric://sandbox/events',
    selects: () => true,
    operation: 'list_sandbox_events',
    translate: () => ({}),
  },
  {
    uriTemplate: 'pyric://firestore/docs/{path}',
    selects: (params) => isCollectionResourcePath(params),
    operation: 'list_firestore_documents',
    translate: (params) => ({ path: params.path }),
  },
  {
    uriTemplate: 'pyric://firestore/docs/{path}',
    selects: (params) => !isCollectionResourcePath(params),
    operation: 'get_firestore_document',
    translate: (params) => ({ path: params.path }),
  },
  {
    uriTemplate: 'pyric://database/tree/{path}',
    selects: () => true,
    operation: 'get_database_value',
    translate: (params) => ({ path: params.path }),
  },
  {
    uriTemplate: 'pyric://auth/users',
    selects: () => true,
    operation: 'list_auth_users',
    translate: () => ({}),
  },
  {
    uriTemplate: 'pyric://storage/objects/{path}',
    selects: () => true,
    operation: 'get_storage_metadata',
    translate: (params) => ({ path: params.path }),
  },
  {
    uriTemplate: 'pyric://stdlib/rules/{module}',
    selects: (params) => (params.module ?? STDLIB_INDEX) === STDLIB_INDEX,
    operation: 'list_rules_stdlib',
    translate: () => ({}),
  },
  {
    uriTemplate: 'pyric://stdlib/rules/{module}',
    selects: (params) => (params.module ?? STDLIB_INDEX) !== STDLIB_INDEX,
    operation: 'get_rules_stdlib',
    translate: (params) => ({ module: params.module }),
  },
];

/**
 * Parse and RFC 3986 percent-decode template parameters from a resource URI.
 * Malformed percent sequences return `{ status: 'malformed' }` rather than
 * throwing an unhandled `URIError`.
 */
export function parseResourceUri(uriTemplate: string, uri: string): ParsedResourceUri {
  const opening = uriTemplate.indexOf('{');
  if (opening === -1) {
    if (uri !== uriTemplate) return { status: 'unmatched' };
    return { status: 'matched', params: {} };
  }
  const prefix = uriTemplate.slice(0, opening);
  const parameter = uriTemplate.slice(opening + 1, uriTemplate.indexOf('}'));
  if (!uri.startsWith(prefix)) return { status: 'unmatched' };
  const rawValue = uri.slice(prefix.length);
  try {
    return { status: 'matched', params: { [parameter]: decodeURIComponent(rawValue) } };
  } catch {
    return {
      status: 'malformed',
      message: `Invalid percent-encoded resource URI parameter '${parameter}' in '${uri}'.`,
    };
  }
}
