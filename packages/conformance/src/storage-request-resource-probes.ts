/**
 * Probe definitions for the real-resource capture of the fields production
 * puts on Storage `request.resource`. The capture runner
 * (run-storage-request-resource-fields.ts) deploys these rules and makes these
 * writes against production; the replay test makes the same writes against the
 * sandbox. This module has no network or credential dependencies so both can
 * import it.
 *
 * Each probe object has its own path and its own rule. A presence probe
 * (`request.resource.F == request.resource.F`) allows only when field F is
 * present, because reading an absent field is an evaluation error that
 * denies; a value probe allows only when the field holds the stated value or
 * relation.
 */

export const OBSERVATION_NAME = 'stdlib-realstorage-request-resource-fields';

/** Every field the Storage rules reference documents on `resource` and `request.resource`. */
export const REQUEST_RESOURCE_FIELDS = [
  'name', 'bucket', 'generation', 'metageneration', 'size', 'timeCreated', 'updated',
  'md5Hash', 'crc32c', 'etag', 'contentDisposition', 'contentEncoding', 'contentLanguage',
  'contentType', 'metadata',
] as const;

/** Settable fields every full create and full metadata update sends. */
export const SETTABLE_FIELDS = {
  contentType: 'text/plain',
  contentDisposition: 'inline',
  contentEncoding: 'identity',
  contentLanguage: 'en',
  cacheControl: 'no-cache',
} as const;
export const CUSTOM_METADATA = { probe: 'value' } as const;

/** Fields whose presence is probed again on a create that sets only contentType. */
export const UNSET_ON_CREATE = ['contentDisposition', 'contentEncoding', 'contentLanguage', 'cacheControl', 'metadata'] as const;

/** Undocumented object-resource keys probed to account for the binding's key count. */
export const EXTRA_KEY_CANDIDATES = [
  'cacheControl', 'storageClass', 'customTime', 'componentCount', 'id', 'kind', 'path', 'contentMD5',
] as const;

/** Bytes of every seeded object and every create. */
export const PROBE_PAYLOAD = new Uint8Array([0x70, 0x79, 0x72, 0x69, 0x63]);
/** Bytes of every upload over an existing object. */
export const PROBE_REPLACEMENT = new Uint8Array([0x72, 0x75, 0x6c, 0x65, 0x73, 0x21]);

export interface Probe { id: string; condition: (objectName: string) => string; verb?: 'create' | 'update' | 'write' }

const presence = (field: string): Probe => ({
  id: `present-${field}`,
  condition: () => `request.resource.${field} == request.resource.${field}`,
});

const shared: Probe[] = [
  { id: 'name-object-path', condition: (name) => `request.resource.name == ${JSON.stringify(name)}` },
  { id: 'name-string', condition: () => 'request.resource.name is string' },
  { id: 'bucket-match', condition: () => 'request.resource.bucket == bucket' },
  { id: 'content-type-set', condition: () => `request.resource.contentType == '${SETTABLE_FIELDS.contentType}'` },
  { id: 'content-disposition-set', condition: () => `request.resource.contentDisposition == '${SETTABLE_FIELDS.contentDisposition}'` },
  { id: 'content-encoding-set', condition: () => `request.resource.contentEncoding == '${SETTABLE_FIELDS.contentEncoding}'` },
  { id: 'content-language-set', condition: () => `request.resource.contentLanguage == '${SETTABLE_FIELDS.contentLanguage}'` },
  { id: 'metadata-set', condition: () => `request.resource.metadata == {'probe': '${CUSTOM_METADATA.probe}'}` },
  { id: 'time-created-timestamp', condition: () => 'request.resource.timeCreated is timestamp' },
  { id: 'updated-timestamp', condition: () => 'request.resource.updated is timestamp' },
  { id: 'generation-int', condition: () => 'request.resource.generation is int' },
  { id: 'metageneration-int', condition: () => 'request.resource.metageneration is int' },
  { id: 'md5-string', condition: () => 'request.resource.md5Hash is string' },
  { id: 'etag-string', condition: () => 'request.resource.etag is string' },
  { id: 'crc32c-string', condition: () => 'request.resource.crc32c is string' },
  { id: 'size-int', condition: () => 'request.resource.size is int' },
  { id: 'cache-control-set', condition: () => "request.resource.cacheControl == 'no-cache'" },
  { id: 'storage-class-null', condition: () => 'request.resource.storageClass == null' },
  { id: 'storage-class-standard', condition: () => "request.resource.storageClass == 'STANDARD'" },
  { id: 'time-created-key', condition: () => "'timeCreated' in request.resource" },
  { id: 'updated-key', condition: () => "'updated' in request.resource" },
  { id: 'name-key', condition: () => "'name' in request.resource" },
  { id: 'keys-size-13', condition: () => 'request.resource.keys().size() == 13' },
  ...[14, 15, 16, 17, 18].map((size) => ({ id: `keys-size-${size}`, condition: () => `request.resource.keys().size() == ${size}` })),
  { id: 'keys-size-over-18', condition: () => 'request.resource.keys().size() > 18' },
  ...EXTRA_KEY_CANDIDATES.map((key) => ({ id: `extra-key-${key}`, condition: () => `'${key}' in request.resource` })),
  { id: 'keys-documented-13', condition: () => `request.resource.keys().hasAll(${JSON.stringify(REQUEST_RESOURCE_FIELDS.filter((field) => field !== 'timeCreated' && field !== 'updated'))})` },
];

/** A client upload to a path with no object. */
export const CREATE_PROBES: Probe[] = [
  ...REQUEST_RESOURCE_FIELDS.map(presence),
  ...shared,
  { id: 'size-bytes', condition: () => 'request.resource.size == 5' },
  { id: 'metageneration-one', condition: () => 'request.resource.metageneration == 1' },
  { id: 'time-created-request-time', condition: () => 'request.resource.timeCreated == request.time' },
  { id: 'updated-time-created', condition: () => 'request.resource.updated == request.resource.timeCreated' },
  { id: 'generation-null', condition: () => 'request.resource.generation == null' },
  { id: 'metageneration-null', condition: () => 'request.resource.metageneration == null' },
  { id: 'etag-null', condition: () => 'request.resource.etag == null' },
  ...UNSET_ON_CREATE.map((field) => ({ ...presence(field), id: `unset-present-${field}` })),
  ...UNSET_ON_CREATE.map((field) => ({ id: `unset-null-${field}`, condition: () => `request.resource.${field} == null` })),
  ...UNSET_ON_CREATE.filter((field) => field !== 'metadata').map((field) => ({ id: `unset-empty-${field}`, condition: () => `request.resource.${field} == ''` })),
  { id: 'unset-empty-metadata', condition: () => 'request.resource.metadata == {}' },
  { id: 'unset-identity-contentEncoding', condition: () => "request.resource.contentEncoding == 'identity'" },
  {
    id: 'unset-filename-contentDisposition',
    condition: (name) => `request.resource.contentDisposition == ${JSON.stringify(`inline; filename*=utf-8''${name.split('/').pop()}`)}`,
  },
  { id: 'unset-inline-contentDisposition', condition: () => "request.resource.contentDisposition.matches('inline.*')" },
];

/** A client metadata update of a seeded object. */
export const UPDATE_PROBES: Probe[] = [
  ...REQUEST_RESOURCE_FIELDS.map(presence),
  ...shared,
  { id: 'size-unchanged', condition: () => 'request.resource.size == resource.size' },
  { id: 'generation-unchanged', condition: () => 'request.resource.generation == resource.generation' },
  { id: 'metageneration-unchanged', condition: () => 'request.resource.metageneration == resource.metageneration' },
  { id: 'metageneration-next', condition: () => 'request.resource.metageneration == resource.metageneration + 1' },
  { id: 'time-created-unchanged', condition: () => 'request.resource.timeCreated == resource.timeCreated' },
  { id: 'updated-unchanged', condition: () => 'request.resource.updated == resource.updated' },
  { id: 'updated-request-time', condition: () => 'request.resource.updated == request.time' },
  { id: 'md5-unchanged', condition: () => 'request.resource.md5Hash == resource.md5Hash' },
  { id: 'crc32c-unchanged', condition: () => 'request.resource.crc32c == resource.crc32c' },
  { id: 'etag-unchanged', condition: () => 'request.resource.etag == resource.etag' },
  { id: 'partial-content-type-kept', condition: () => 'request.resource.contentType == resource.contentType' },
  { id: 'partial-content-disposition-null', condition: () => 'request.resource.contentDisposition == null' },
];

/** A client upload over a seeded object, sending only contentType and different bytes. */
export const OVERWRITE_PROBES: Probe[] = [
  ...REQUEST_RESOURCE_FIELDS.map(presence),
  { id: 'name-object-path', condition: (name) => `request.resource.name == ${JSON.stringify(name)}` },
  { id: 'size-bytes', condition: () => 'request.resource.size == 6' },
  { id: 'generation-null', condition: () => 'request.resource.generation == null' },
  { id: 'metageneration-null', condition: () => 'request.resource.metageneration == null' },
  { id: 'etag-null', condition: () => 'request.resource.etag == null' },
  { id: 'md5-changed', condition: () => 'request.resource.md5Hash != resource.md5Hash' },
  { id: 'keys-size-15', condition: () => 'request.resource.keys().size() == 15' },
  { id: 'unset-identity-contentEncoding', condition: () => "request.resource.contentEncoding == 'identity'" },
  {
    id: 'unset-filename-contentDisposition',
    condition: (name) => `request.resource.contentDisposition == ${JSON.stringify(`inline; filename*=utf-8''${name.split('/').pop()}`)}`,
  },
  { id: 'unset-null-contentLanguage', condition: () => 'request.resource.contentLanguage == null' },
  { id: 'unset-null-cacheControl', condition: () => 'request.resource.cacheControl == null' },
  { id: 'unset-null-metadata', condition: () => 'request.resource.metadata == null' },
  { id: 'verb-create', verb: 'create', condition: () => 'true' },
  { id: 'verb-update', verb: 'update', condition: () => 'true' },
  { id: 'resource-existing', condition: () => 'resource.size == 5' },
];

export type ProbeGroup = 'create' | 'update' | 'overwrite';

export const PROBE_GROUPS: ReadonlyArray<{ group: ProbeGroup; probes: Probe[] }> = [
  { group: 'create', probes: CREATE_PROBES },
  { group: 'update', probes: UPDATE_PROBES },
  { group: 'overwrite', probes: OVERWRITE_PROBES },
];

/** Object path of a probe under `prefix`. */
export function probePath(prefix: string, group: ProbeGroup, id: string): string {
  return `${prefix}/${group}/${id}.bin`;
}

/**
 * The write a probe makes. `fields` is the Firebase Storage resource the client
 * sends: settable fields plus custom `metadata`.
 */
export type ProbeWrite =
  | { kind: 'upload'; bytes: Uint8Array; fields: Record<string, unknown> }
  | { kind: 'metadataUpdate'; fields: Record<string, unknown> };

export function probeWrite(group: ProbeGroup, id: string): ProbeWrite {
  if (group === 'create') {
    return {
      kind: 'upload',
      bytes: PROBE_PAYLOAD,
      fields: id.startsWith('unset-')
        ? { contentType: SETTABLE_FIELDS.contentType }
        : { ...SETTABLE_FIELDS, metadata: CUSTOM_METADATA },
    };
  }
  if (group === 'update') {
    return {
      kind: 'metadataUpdate',
      fields: id.startsWith('partial-')
        ? { metadata: CUSTOM_METADATA }
        : { ...SETTABLE_FIELDS, metadata: CUSTOM_METADATA },
    };
  }
  return { kind: 'upload', bytes: PROBE_REPLACEMENT, fields: { contentType: SETTABLE_FIELDS.contentType } };
}

/** The probe match block, injected inside `match /b/{bucket}/o`. */
export function requestResourceRules(prefix: string): string {
  const lines = [`\n    // @pyric/storage-request-resource-fields/${prefix}`];
  lines.push(`    match /${prefix}/canary.bin { allow create: if true; }`);
  for (const probe of CREATE_PROBES) {
    const name = probePath(prefix, 'create', probe.id);
    lines.push(`    match /${name} { allow create: if ${probe.condition(name)}; }`);
  }
  for (const probe of UPDATE_PROBES) {
    const name = probePath(prefix, 'update', probe.id);
    lines.push(`    match /${name} { allow update: if ${probe.condition(name)}; }`);
  }
  for (const probe of OVERWRITE_PROBES) {
    const name = probePath(prefix, 'overwrite', probe.id);
    lines.push(`    match /${name} { allow ${probe.verb ?? 'write'}: if ${probe.condition(name)}; }`);
  }
  return `${lines.join('\n')}\n`;
}
