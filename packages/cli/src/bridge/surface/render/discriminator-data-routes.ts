/**
 * Data, Firestore structure, and Cloud Storage routes for the discriminator
 * surface variant.
 */
import type { Args, DiscriminatorRoute } from './discriminator-route-shapes.js';
import {
  assign,
  on,
  onBoth,
  parseJsonArray,
  parseJsonObject,
  parseJsonValue,
  text,
} from './discriminator-route-shapes.js';

interface BatchOperation {
  op: string;
  path: string;
  dataJson?: string;
}

interface QueryFilter {
  field: string;
  op: string;
  valueJson: string;
}

function hasFilters(args: Args): boolean {
  return Array.isArray(args.filters) && args.filters.length > 0;
}

function translateFilters(args: Args): Array<{ field: string; op: string; value: unknown }> {
  const authored = (args.filters ?? []) as QueryFilter[];
  return authored.map((filter) => ({
    field: filter.field,
    op: filter.op,
    value: parseJsonValue(filter.valueJson),
  }));
}

/** `filtersJson`'s entries, translated into the `where` constraints the depth methods take. */
function constraintsFromFiltersJson(args: Args): Args[] | undefined {
  const parsed = parseJsonArray(text(args, 'filtersJson'));
  if (parsed === undefined) return undefined;
  return (parsed as QueryFilter[]).map((filter) => ({
    type: 'where',
    field: filter.field,
    op: filter.op,
    value: parseJsonValue(filter.valueJson),
  }));
}

export const DATA_ROUTES: DiscriminatorRoute[] = [
  {
    tool: 'mutate_sandbox_data',
    action: 'set',
    selects: onBoth('service', 'firestore', 'action', 'set'),
    operation: 'write_firestore_document',
    translate: (args) => ({
      path: args.path,
      data: parseJsonObject(text(args, 'dataJson')) ?? {},
    }),
  },
  {
    tool: 'mutate_sandbox_data',
    action: 'add',
    selects: onBoth('service', 'firestore', 'action', 'add'),
    operation: 'add_firestore_document',
    translate: (args) => ({
      path: args.path,
      data: parseJsonObject(text(args, 'dataJson')) ?? {},
    }),
  },
  {
    tool: 'mutate_sandbox_data',
    action: 'update',
    selects: onBoth('service', 'firestore', 'action', 'update'),
    operation: 'update_firestore_document',
    translate: (args) => ({
      path: args.path,
      data: parseJsonObject(text(args, 'dataJson')) ?? {},
    }),
  },
  {
    tool: 'mutate_sandbox_data',
    action: 'delete',
    selects: onBoth('service', 'firestore', 'action', 'delete'),
    operation: 'delete_firestore_document',
    translate: (args) => ({ path: args.path }),
  },
  {
    tool: 'mutate_sandbox_data',
    action: 'batch',
    selects: onBoth('service', 'firestore', 'action', 'batch'),
    operation: 'batch_firestore_writes',
    translate: (args) => {
      const authored = (args.batchOps ?? []) as BatchOperation[];
      const writes = authored.map((entry) => {
        const write: Args = { op: entry.op, path: entry.path };
        assign(write, 'data', parseJsonObject(entry.dataJson));
        return write;
      });
      return { writes };
    },
  },
  {
    tool: 'mutate_sandbox_data',
    action: 'writeIndexes',
    selects: onBoth('service', 'firestore', 'action', 'writeIndexes'),
    operation: 'write_firestore_indexes',
    translate: (args) => {
      const payload = parseJsonObject(text(args, 'dataJson')) ?? {};
      const translated: Args = { indexes: payload.indexes ?? [] };
      assign(translated, 'path', payload.path);
      assign(translated, 'confirm', payload.confirm);
      return translated;
    },
  },
  {
    tool: 'mutate_sandbox_data',
    action: 'set',
    selects: onBoth('service', 'database', 'action', 'set'),
    operation: 'write_database_value',
    translate: (args) => ({ path: args.path, value: parseJsonValue(text(args, 'dataJson')) }),
  },
  {
    tool: 'mutate_sandbox_data',
    action: 'update',
    selects: onBoth('service', 'database', 'action', 'update'),
    operation: 'update_database_value',
    translate: (args) => ({
      path: args.path,
      value: parseJsonObject(text(args, 'dataJson')) ?? {},
    }),
  },
  {
    tool: 'mutate_sandbox_data',
    action: 'delete',
    selects: onBoth('service', 'database', 'action', 'delete'),
    operation: 'delete_database_value',
    translate: (args) => ({ path: args.path }),
  },
  {
    tool: 'mutate_sandbox_data',
    action: 'push',
    selects: onBoth('service', 'database', 'action', 'push'),
    operation: 'push_database_value',
    translate: (args) => {
      const translated: Args = { path: args.path };
      assign(translated, 'value', parseJsonValue(text(args, 'dataJson')));
      return translated;
    },
  },
  {
    tool: 'query_sandbox_data',
    action: null,
    selects: (args) => args.service === 'firestore' && hasFilters(args),
    operation: 'query_firestore_documents',
    translate: (args) => {
      const translated: Args = { path: args.path, filters: translateFilters(args) };
      assign(translated, 'orderBy', text(args, 'orderByField'));
      assign(translated, 'direction', text(args, 'orderDirection'));
      assign(translated, 'limit', args.limit);
      return translated;
    },
  },
  {
    tool: 'query_sandbox_data',
    action: null,
    selects: (args) => args.service === 'firestore' && !hasFilters(args),
    operation: 'list_firestore_documents',
    translate: (args) => {
      const translated: Args = { path: args.path };
      assign(translated, 'limit', args.limit);
      return translated;
    },
  },
  {
    tool: 'query_sandbox_data',
    action: null,
    selects: (args) => args.service === 'database' && args.action === 'crawl',
    operation: 'crawl_database_structure',
    translate: (args) => {
      const translated: Args = {};
      assign(translated, 'path', args.path);
      assign(translated, 'depth', args.depth);
      return translated;
    },
  },
  {
    tool: 'query_sandbox_data',
    action: null,
    selects: (args) => args.service === 'database' && args.action === 'extractIndexes',
    operation: 'extract_database_indexes',
    translate: (args) => {
      const translated: Args = {};
      assign(translated, 'paths', parseJsonArray(text(args, 'pathsJson')));
      assign(translated, 'instance', text(args, 'instance'));
      assign(translated, 'rulesPath', text(args, 'rulesPath'));
      assign(translated, 'check', args.check);
      return translated;
    },
  },
  {
    tool: 'query_sandbox_data',
    action: null,
    selects: on('service', 'database'),
    operation: 'query_database_values',
    translate: (args) => {
      const translated: Args = { path: args.path };
      assign(translated, 'orderByChild', text(args, 'orderByField'));
      assign(translated, 'limitToFirst', args.limit);
      const equality = translateFilters(args).find((filter) => filter.op === '==');
      if (equality !== undefined) assign(translated, 'equalTo', equality.value);
      return translated;
    },
  },
];

export const FIRESTORE_STRUCTURE_ROUTES: DiscriminatorRoute[] = [
  {
    tool: 'inspect_firestore_structure',
    action: 'count',
    selects: on('action', 'count'),
    operation: 'count_firestore_documents',
    translate: (args) => {
      const translated: Args = { path: args.path };
      assign(translated, 'constraints', constraintsFromFiltersJson(args));
      return translated;
    },
  },
  {
    tool: 'inspect_firestore_structure',
    action: 'aggregate',
    selects: on('action', 'aggregate'),
    operation: 'aggregate_firestore_documents',
    translate: (args) => {
      const translated: Args = { path: args.path, spec: parseJsonObject(text(args, 'specJson')) ?? {} };
      assign(translated, 'constraints', constraintsFromFiltersJson(args));
      return translated;
    },
  },
  {
    tool: 'inspect_firestore_structure',
    action: 'discoverPaths',
    selects: on('action', 'discoverPaths'),
    operation: 'discover_firestore_paths',
    translate: (args) => {
      const translated: Args = {};
      assign(translated, 'depth', args.depth);
      assign(translated, 'limit', args.limit);
      return translated;
    },
  },
  {
    tool: 'inspect_firestore_structure',
    action: 'findCollectionGroup',
    selects: on('action', 'findCollectionGroup'),
    operation: 'find_firestore_collection_group',
    translate: (args) => ({ collectionId: args.collectionId }),
  },
  {
    tool: 'inspect_firestore_structure',
    action: 'extractIndexes',
    selects: on('action', 'extractIndexes'),
    operation: 'extract_firestore_indexes',
    translate: (args) => {
      const translated: Args = {};
      assign(translated, 'queries', parseJsonArray(text(args, 'queriesJson')));
      assign(translated, 'paths', parseJsonArray(text(args, 'pathsJson')));
      return translated;
    },
  },
];

export const STORAGE_ROUTES: DiscriminatorRoute[] = [
  {
    tool: 'manage_storage_files',
    action: 'upload',
    selects: on('action', 'upload'),
    operation: 'upload_storage_file',
    translate: (args) => {
      const translated: Args = { path: args.path };
      assign(translated, 'sourcePath', text(args, 'sourcePath'));
      if (translated.sourcePath === undefined) {
        translated.contentBase64 = args.base64Content ?? '';
      }
      assign(translated, 'contentType', text(args, 'contentType'));
      assign(translated, 'metadata', parseJsonObject(text(args, 'customMetadataJson')));
      return translated;
    },
  },
  {
    tool: 'manage_storage_files',
    action: 'download',
    selects: on('action', 'download'),
    operation: 'download_storage_file',
    translate: (args) => ({ path: args.path }),
  },
  {
    tool: 'manage_storage_files',
    action: 'delete',
    selects: on('action', 'delete'),
    operation: 'delete_storage_file',
    translate: (args) => ({ path: args.path }),
  },
  {
    tool: 'manage_storage_files',
    action: 'list',
    selects: on('action', 'list'),
    operation: 'list_storage_files',
    translate: (args) => {
      const translated: Args = {};
      assign(translated, 'prefix', text(args, 'path'));
      return translated;
    },
  },
  {
    tool: 'manage_storage_files',
    action: 'download_url',
    selects: on('action', 'download_url'),
    operation: 'get_storage_download_url',
    translate: (args) => ({ path: args.path }),
  },
  {
    tool: 'manage_storage_files',
    action: 'update_metadata',
    selects: on('action', 'update_metadata'),
    operation: 'update_storage_metadata',
    translate: (args) => {
      const metadata: Args = {};
      assign(metadata, 'contentType', text(args, 'contentType'));
      assign(metadata, 'cacheControl', text(args, 'cacheControl'));
      assign(metadata, 'customMetadata', parseJsonObject(text(args, 'customMetadataJson')));
      return { path: args.path, metadata };
    },
  },
  {
    tool: 'manage_storage_files',
    action: 'set_cross_service_iam',
    selects: on('action', 'set_cross_service_iam'),
    operation: 'set_storage_cross_service_iam',
    translate: (args) => ({ mode: args.crossServiceIam }),
  },
  {
    tool: 'manage_storage_files',
    action: 'service_status',
    selects: on('action', 'service_status'),
    operation: 'get_storage_service_status',
    translate: (args) => {
      const call: Args = {};
      assign(call, 'confirm', args.confirm);
      return call;
    },
  },
  {
    tool: 'manage_storage_files',
    action: 'provision',
    selects: on('action', 'provision'),
    operation: 'provision_storage_bucket',
    translate: (args) => {
      const call: Args = {};
      assign(call, 'bucket', text(args, 'bucket'));
      assign(call, 'confirm', args.confirm);
      return call;
    },
  },
];
