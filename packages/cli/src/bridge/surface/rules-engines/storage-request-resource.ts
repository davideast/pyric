/**
 * The `request.resource` a Storage simulate case builds, by verb, as the live
 * planes build it.
 *
 * - `create` (and the `write` umbrella) is an upload. An upload replaces the
 *   object, so its `request.resource` carries only what the case sends, with
 *   an upload's defaults for the rest. A stored object at the path is
 *   `resource`, never a source of `request.resource` fields.
 * - `update` is a metadata update: the stored object patched with the case's
 *   fields. Production builds it whether or not the call changes anything, so
 *   it is present when the case passes no `data`.
 * - `get`, `list`, `delete` and the `read` umbrella carry none, so a case that
 *   passes `data` with one is refused rather than evaluated against a binding
 *   the live request would not have.
 *
 * Every field of `data` is checked against `StorageRequestResource`. An
 * unknown or wrong-typed field is refused by name, because a default in its
 * place would answer a different question than the one asked.
 */
import { requestResourceFor, type StoredMetadata } from 'pyric/storage/internal';
import type { StorageReference, StorageRequest } from 'pyric/storage';

type RequestResource = NonNullable<StorageRequest['resource']>;

/** What a case's verb and data build: a binding, or why the case is refused. */
export type RequestResourceOutcome =
  | { ok: true; resource: RequestResource | undefined }
  | { ok: false; reason: string };

/** The fields a case's `data` can carry, in the order a refusal lists them. */
const FIELDS = [
  'name',
  'bucket',
  'size',
  'contentType',
  'contentDisposition',
  'contentEncoding',
  'contentLanguage',
  'cacheControl',
  'metadata',
  'customMetadata',
  'generation',
  'metageneration',
  'etag',
] as const;

type Field = (typeof FIELDS)[number];

/** The content fields a case may set to `null`, which the binding then reads as `null`. */
const NULLABLE_CONTENT = ['contentDisposition', 'contentEncoding', 'contentLanguage', 'cacheControl'] as const;

/** A case's `data`, checked and typed. `null` means the binding reads the field as `null`. */
interface CaseFields {
  name?: string;
  bucket?: string;
  size?: number;
  contentType?: string;
  contentDisposition?: string | null;
  contentEncoding?: string | null;
  contentLanguage?: string | null;
  cacheControl?: string | null;
  metadata?: Record<string, string> | null;
  generation?: number | null;
  metageneration?: number | null;
  etag?: null;
}

type Checked<T> = { ok: true; value: T } | { ok: false; reason: string };

const NUMERIC = /^\d+$/;

function refuse<T>(reason: string): Checked<T> {
  return { ok: false, reason };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function typeName(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'an array';
  return `a ${typeof value}`;
}

/** A count field: a number, or a numeric string as the Rules Test API tolerates. */
function countOf(field: string, value: unknown): Checked<number> {
  if (typeof value === 'number' && Number.isFinite(value)) return { ok: true, value };
  if (typeof value === 'string' && NUMERIC.test(value)) return { ok: true, value: Number(value) };
  return refuse(`data.${field} must be a number or a numeric string, and it is ${typeName(value)}.`);
}

function stringOf(field: string, value: unknown): Checked<string> {
  if (typeof value === 'string') return { ok: true, value };
  return refuse(`data.${field} must be a string, and it is ${typeName(value)}.`);
}

/** Custom metadata: a map of strings, or `null` for none. */
function metadataOf(field: string, value: unknown): Checked<Record<string, string> | null> {
  if (value === null) return { ok: true, value: null };
  if (!isRecord(value)) return refuse(`data.${field} must be a map of strings, and it is ${typeName(value)}.`);
  for (const [key, entry] of Object.entries(value)) {
    if (typeof entry !== 'string') {
      return refuse(`data.${field}.${key} must be a string, and it is ${typeName(entry)}.`);
    }
  }
  return { ok: true, value: value as Record<string, string> };
}

function isField(key: string): key is Field {
  return (FIELDS as readonly string[]).includes(key);
}

/** Check one field and write it onto `out`, or say why it is refused. */
function checkField(out: CaseFields, field: Field, value: unknown): string | null {
  const nullable = (NULLABLE_CONTENT as readonly string[]).includes(field);
  if (nullable && value === null) {
    out[field as (typeof NULLABLE_CONTENT)[number]] = null;
    return null;
  }
  switch (field) {
    case 'size': {
      const checked = countOf(field, value);
      if (!checked.ok) return checked.reason;
      out.size = checked.value;
      return null;
    }
    case 'generation':
    case 'metageneration': {
      if (value === null) {
        out[field] = null;
        return null;
      }
      const checked = countOf(field, value);
      if (!checked.ok) return checked.reason;
      out[field] = checked.value;
      return null;
    }
    case 'metadata':
    case 'customMetadata': {
      if (out.metadata !== undefined) return 'Pass data.metadata or data.customMetadata, not both.';
      const checked = metadataOf(field, value);
      if (!checked.ok) return checked.reason;
      out.metadata = checked.value;
      return null;
    }
    case 'etag':
      if (value !== null) return `data.etag can only be null, and it is ${typeName(value)}.`;
      out.etag = null;
      return null;
    default: {
      const checked = stringOf(field, value);
      if (!checked.ok) return checked.reason;
      out[field] = checked.value;
      return null;
    }
  }
}

/** Check a case's `data` against the fields `request.resource` has. */
function caseFieldsOf(data: unknown): Checked<CaseFields> {
  if (data === undefined) return { ok: true, value: {} };
  if (!isRecord(data)) return refuse(`data must be an object, and it is ${typeName(data)}.`);
  const out: CaseFields = {};
  for (const [key, value] of Object.entries(data)) {
    if (!isField(key)) {
      return refuse(`data.${key} is not a field of request.resource. Its fields are ${FIELDS.join(', ')}.`);
    }
    const reason = checkField(out, key, value);
    if (reason !== null) return refuse(reason);
  }
  return { ok: true, value: out };
}

/** Whether a verb writes, and which write builds its binding. */
function writeOf(operation: string): 'upload' | 'metadataUpdate' | null {
  if (operation === 'create' || operation === 'write') return 'upload';
  if (operation === 'update') return 'metadataUpdate';
  return null;
}

function presentOrUndefined<T>(value: T | null | undefined): T | undefined {
  return value === null ? undefined : value;
}

/** The binding an upload builds from the case alone, with an upload's defaults. */
function uploadResource(object: StorageReference, fields: CaseFields): RequestResource {
  return requestResourceFor(
    {
      fullPath: fields.name ?? object.fullPath,
      bucket: fields.bucket ?? object.bucket,
      size: fields.size ?? 0,
      contentType: fields.contentType ?? 'application/octet-stream',
      customMetadata: presentOrUndefined(fields.metadata),
      cacheControl: presentOrUndefined(fields.cacheControl),
      contentDisposition: presentOrUndefined(fields.contentDisposition),
      contentEncoding: presentOrUndefined(fields.contentEncoding),
      contentLanguage: presentOrUndefined(fields.contentLanguage),
    },
    'upload',
  );
}

/** A field the case names wins; one it leaves out keeps the stored value. */
function patched<T>(set: T | null | undefined, stored: T | undefined): T | undefined {
  if (set === null) return undefined;
  return set ?? stored;
}

/** The binding a metadata update builds: the stored object patched with the case. */
function updateResource(
  object: StorageReference,
  fields: CaseFields,
  existing: StoredMetadata | undefined,
): RequestResource {
  return requestResourceFor(
    {
      fullPath: fields.name ?? existing?.fullPath ?? object.fullPath,
      bucket: fields.bucket ?? existing?.bucket ?? object.bucket,
      size: fields.size ?? existing?.size ?? 0,
      contentType: fields.contentType ?? existing?.contentType,
      customMetadata: patched(fields.metadata, existing?.customMetadata),
      cacheControl: patched(fields.cacheControl, existing?.cacheControl),
      contentDisposition: patched(fields.contentDisposition, existing?.contentDisposition),
      contentEncoding: patched(fields.contentEncoding, existing?.contentEncoding),
      contentLanguage: patched(fields.contentLanguage, existing?.contentLanguage),
      generation: existing?.generation,
      metageneration: existing?.metageneration,
    },
    'metadataUpdate',
  );
}

/** Fields a case sets to `null` read as `null`, whatever the write's default. */
function applyNulls(resource: RequestResource, fields: CaseFields): RequestResource {
  for (const field of NULLABLE_CONTENT) {
    if (fields[field] === null) resource[field] = null;
  }
  if (fields.metadata === null) resource.metadata = null;
  if (fields.generation !== undefined) resource.generation = fields.generation;
  if (fields.metageneration !== undefined) resource.metageneration = fields.metageneration;
  if (fields.etag === null) resource.etag = null;
  return resource;
}

/**
 * The `request.resource` one simulate case builds for its verb, or why the
 * case is refused.
 */
export function simulatedRequestResource(
  object: StorageReference,
  operation: string,
  data: unknown,
  existing: StoredMetadata | undefined,
): RequestResourceOutcome {
  const write = writeOf(operation);
  if (write === null) {
    if (data === undefined) return { ok: true, resource: undefined };
    return { ok: false, reason: `a ${operation} request carries no request.resource; remove 'data'.` };
  }
  const fields = caseFieldsOf(data);
  if (!fields.ok) return fields;
  const built =
    write === 'upload' ? uploadResource(object, fields.value) : updateResource(object, fields.value, existing);
  return { ok: true, resource: applyNulls(built, fields.value) };
}
