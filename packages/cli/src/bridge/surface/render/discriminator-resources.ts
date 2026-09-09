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
    uriTemplate: 'pyric://storage/objects/{bucket}',
    name: 'storage_objects',
    description: 'List all stored files and metadata in the specified Cloud Storage bucket.',
  },
  {
    uriTemplate: 'pyric://stdlib/rules/{module}',
    name: 'stdlib_rules',
    description: 'Inspect Security Rules standard library documentation by module name (or index).',
  },
];

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
    uriTemplate: 'pyric://firestore/docs/{path}',
    selects: () => true,
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
    uriTemplate: 'pyric://storage/objects/{bucket}',
    selects: () => true,
    operation: 'list_storage_files',
    translate: () => ({}),
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
 * Read the template parameters out of a uri, or null when the uri does not
 * belong to the template. Every template has at most one parameter, and it is
 * the whole tail of the uri.
 */
export function matchResourceUri(uriTemplate: string, uri: string): Params | null {
  const opening = uriTemplate.indexOf('{');
  if (opening === -1) {
    if (uri !== uriTemplate) return null;
    return {};
  }
  const prefix = uriTemplate.slice(0, opening);
  const parameter = uriTemplate.slice(opening + 1, uriTemplate.indexOf('}'));
  if (!uri.startsWith(prefix)) return null;
  return { [parameter]: uri.slice(prefix.length) };
}
