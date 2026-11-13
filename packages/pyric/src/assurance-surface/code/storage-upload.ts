/**
 * Browser-clean static upload metadata and byte-length extraction for
 * Cloud Storage write operations (`uploadBytes`, `uploadBytesResumable`,
 * `uploadString`, `updateMetadata`, and Admin `file.save` / `setMetadata`).
 */
import ts from 'typescript';
import { BASE64_RE, utf8ByteLength } from './binary-constructors.js';
import type { Evaluator } from './evaluator.js';
import { payloadShape } from './payload.js';
import type { UploadPayloadSpec } from './service-models/types.js';
import type { PayloadField, PayloadShape, StorageUploadMetadata } from './types.js';
import { alternatives, literalText, ownRecordValue, union, type AVal, type Env } from './values.js';

type StringEncodingFormat = 'raw' | 'base64' | 'base64url' | 'data_url';

const STRING_FORMAT_NAMES: Readonly<Record<string, StringEncodingFormat>> = {
  raw: 'raw',
  base64: 'base64',
  base64url: 'base64url',
  data_url: 'data_url',
  'StringFormat.RAW': 'raw',
  'StringFormat.BASE64': 'base64',
  'StringFormat.BASE64URL': 'base64url',
  'StringFormat.DATA_URL': 'data_url',
};

const BASE64URL_RE = /^[A-Za-z0-9_-]*={0,2}$/;

export interface ExtractedUploadInfo {
  readonly storageUpload?: StorageUploadMetadata;
  readonly metadataPayload?: PayloadShape;
}

function decodeBase64ByteLength(raw: string): number | undefined {
  const clean = raw.replace(/[\t\n\r ]+/g, '');
  if (clean.length === 0) return 0;
  if (clean.length % 4 !== 0 || !BASE64_RE.test(clean)) return undefined;
  let padding = 0;
  if (clean.endsWith('==')) padding = 2;
  else if (clean.endsWith('=')) padding = 1;
  return (clean.length / 4) * 3 - padding;
}

function decodeBase64UrlByteLength(raw: string): number | undefined {
  const clean = raw.replace(/[\t\n\r ]+/g, '');
  if (clean.length === 0) return 0;
  if (!BASE64URL_RE.test(clean)) return undefined;
  const unpadded = clean.replace(/=+$/, '');
  const rem = unpadded.length % 4;
  if (rem === 1) return undefined;
  if (rem === 0) return (unpadded.length / 4) * 3;
  return Math.floor((unpadded.length * 3) / 4);
}

function parseDataUrl(raw: string): { sizeBytes?: number; mediaType?: string } | undefined {
  const comma = raw.indexOf(',');
  if (!raw.startsWith('data:') || comma === -1) return undefined;
  const header = raw.slice(5, comma);
  const body = raw.slice(comma + 1);
  const isBase64 = header.endsWith(';base64');
  let mediaHeader = header;
  if (isBase64) mediaHeader = header.slice(0, -7);
  const mediaType = mediaHeader || 'application/octet-stream';
  if (isBase64) {
    const sizeBytes = decodeBase64ByteLength(body);
    return { sizeBytes, mediaType };
  }
  try {
    const decoded = decodeURIComponent(body);
    return { sizeBytes: utf8ByteLength(decoded), mediaType };
  } catch {
    return { mediaType };
  }
}

function resolveStringFormat(
  call: ts.CallExpression,
  spec: UploadPayloadSpec,
  ev: Evaluator,
  force: (v: AVal) => AVal,
  env: Env | undefined,
): StringEncodingFormat | null {
  if (spec.formatArg === undefined) return 'raw';
  const expr = call.arguments[spec.formatArg];
  if (!expr) return 'raw';
  if (ts.isSpreadElement(expr)) return null;
  const alts = alternatives(force(ev.eval(expr, env))).filter((a) => a.k !== 'undefined');
  if (alts.length === 0) return 'raw';
  if (alts.length !== 1) return null;
  const only = alts[0]!;
  if (only.k === 'api') {
    return ownRecordValue(STRING_FORMAT_NAMES, only.name) ?? null;
  }
  const text = literalText(only);
  if (text === null) return null;
  return ownRecordValue(STRING_FORMAT_NAMES, text) ?? null;
}

function exactNumberProp(
  obj: Extract<AVal, { k: 'obj' }>,
  prop: string,
  force: (v: AVal) => AVal,
): number | undefined {
  const raw = obj.props.get(prop);
  if (!raw) return undefined;
  const forced = force(raw);
  if (forced.k === 'num' && forced.value !== undefined && Number.isInteger(forced.value) && forced.value >= 0) {
    return forced.value;
  }
  return undefined;
}

interface DataFacts {
  readonly sizeBytes?: number;
  readonly inferredContentType?: string;
  readonly knownNoIntrinsicMime?: boolean;
}

type ContentTypeOutcome =
  | { readonly kind: 'unset' }
  | { readonly kind: 'lit'; readonly value: string }
  | { readonly kind: 'unknown' };

function extractDataFacts(
  call: ts.CallExpression,
  spec: UploadPayloadSpec,
  ev: Evaluator,
  force: (v: AVal) => AVal,
  env: Env | undefined,
): DataFacts {
  if (spec.dataArg === undefined) return {};
  const dataExpr = call.arguments[spec.dataArg];
  if (!dataExpr || ts.isSpreadElement(dataExpr)) return {};

  const format = resolveStringFormat(call, spec, ev, force, env);
  const alts = alternatives(force(ev.eval(dataExpr, env)));
  if (alts.length !== 1) {
    if (spec.stringData) return { knownNoIntrinsicMime: true };
    return {};
  }
  const only = alts[0]!;

  if (only.k === 'obj') {
    const byteLen = exactNumberProp(only, 'byteLength', force) ?? exactNumberProp(only, 'size', force);
    const rawType = only.props.get('type');
    let blobType: string | undefined;
    let knownNoIntrinsicMime = false;
    if (!rawType) {
      knownNoIntrinsicMime = !only.open && only.computed.length === 0;
    } else if (!only.optional.has('type')) {
      const text = literalText(force(rawType));
      if (text !== null) {
        if (text.length > 0) blobType = text;
        else knownNoIntrinsicMime = true;
      }
    }
    const out: { sizeBytes?: number; inferredContentType?: string; knownNoIntrinsicMime?: boolean } = {};
    if (byteLen !== undefined) out.sizeBytes = byteLen;
    if (blobType !== undefined) out.inferredContentType = blobType;
    if (knownNoIntrinsicMime) out.knownNoIntrinsicMime = true;
    return out;
  }

  if (spec.stringData) {
    const text = literalText(only);
    if (text === null || format === null) return { knownNoIntrinsicMime: true };
    if (format === 'raw') return { sizeBytes: utf8ByteLength(text), knownNoIntrinsicMime: true };
    if (format === 'base64') return { sizeBytes: decodeBase64ByteLength(text), knownNoIntrinsicMime: true };
    if (format === 'base64url') return { sizeBytes: decodeBase64UrlByteLength(text), knownNoIntrinsicMime: true };
    const parsed = parseDataUrl(text);
    if (!parsed) return {};
    const out: { sizeBytes?: number; inferredContentType?: string } = {};
    if (parsed.sizeBytes !== undefined) out.sizeBytes = parsed.sizeBytes;
    if (parsed.mediaType !== undefined) out.inferredContentType = parsed.mediaType;
    return out;
  }

  return {};
}

function resolveEmptyUploadContentType(spec: UploadPayloadSpec, dataFacts: DataFacts): ContentTypeOutcome {
  if (spec.stringData) {
    return { kind: 'lit', value: 'application/octet-stream' };
  }
  if (dataFacts.inferredContentType !== undefined) {
    return { kind: 'lit', value: dataFacts.inferredContentType };
  }
  if (dataFacts.knownNoIntrinsicMime) {
    return { kind: 'lit', value: 'application/octet-stream' };
  }
  return { kind: 'unknown' };
}

function resolveUnsetBranchRuntimeContentType(
  spec: UploadPayloadSpec,
  dataFacts: DataFacts,
): string | undefined {
  if (spec.dataArg === undefined) return undefined;
  if (dataFacts.inferredContentType !== undefined) return dataFacts.inferredContentType;
  if (!spec.stringData && dataFacts.knownNoIntrinsicMime) return 'application/octet-stream';
  return undefined;
}

function resolveEffectiveContentType(
  rawAlts: readonly AVal[] | undefined,
  hasUnresolvedMeta: boolean,
  spec: UploadPayloadSpec,
  dataFacts: DataFacts,
  force: (v: AVal) => AVal,
): string | undefined {
  if (!rawAlts) return dataFacts.inferredContentType;
  const nonNullAlts = rawAlts.filter((a) => a.k !== 'undefined' && a.k !== 'null');
  if (nonNullAlts.length === 0) return dataFacts.inferredContentType;
  if (hasUnresolvedMeta) return undefined;

  const outcomes: ContentTypeOutcome[] = [];
  for (const alt of rawAlts) {
    if (alt.k === 'undefined' || alt.k === 'null') {
      outcomes.push({ kind: 'unset' });
      continue;
    }
    if (alt.k !== 'obj') {
      return undefined;
    }
    if (!alt.props.has('contentType')) {
      if (alt.open || alt.computed.length > 0) return undefined;
      outcomes.push({ kind: 'unset' });
      continue;
    }
    if (alt.optional.has('contentType')) {
      outcomes.push({ kind: 'unset' });
    }
    const ctAlts = alternatives(force(alt.props.get('contentType')!));
    if (ctAlts.length === 0) return undefined;
    for (const ctAlt of ctAlts) {
      if (ctAlt.k === 'undefined' || (ctAlt.k === 'null' && spec.dataArg !== undefined && !spec.stringData)) {
        outcomes.push({ kind: 'unset' });
        continue;
      }
      const text = literalText(ctAlt);
      if (text === null) return undefined;
      if (text === '' && spec.dataArg !== undefined) {
        outcomes.push(resolveEmptyUploadContentType(spec, dataFacts));
      } else {
        outcomes.push({ kind: 'lit', value: text });
      }
    }
  }

  if (outcomes.some((o) => o.kind === 'unknown')) return undefined;
  if (outcomes.every((o) => o.kind === 'unset')) {
    return dataFacts.inferredContentType;
  }

  const values = new Set<string>();
  for (const outcome of outcomes) {
    if (outcome.kind === 'lit') {
      values.add(outcome.value);
      continue;
    }
    const fallback = resolveUnsetBranchRuntimeContentType(spec, dataFacts);
    if (fallback === undefined) return undefined;
    values.add(fallback);
  }
  if (values.size === 1) return [...values][0];
  return undefined;
}

function extractMetadataFacts(
  call: ts.CallExpression,
  spec: UploadPayloadSpec,
  dataFacts: DataFacts,
  ev: Evaluator,
  force: (v: AVal) => AVal,
  env: Env | undefined,
): {
  hasMetadataArg: boolean;
  contentType?: string;
  customMetadataKeys?: readonly string[];
  customMetadata?: Readonly<Record<string, PayloadField>>;
  customMetadataOpen?: boolean;
  customMetadataUnresolved?: boolean;
  metadataPayload?: PayloadShape;
} {
  if (spec.metadataArg === undefined) return { hasMetadataArg: false };
  const metaExpr = call.arguments[spec.metadataArg];
  if (!metaExpr) return { hasMetadataArg: false };
  if (ts.isSpreadElement(metaExpr)) {
    return { hasMetadataArg: true, customMetadataUnresolved: true };
  }

  const rawAlts = alternatives(force(ev.eval(metaExpr, env)));
  const nonNullAlts = rawAlts.filter((a) => a.k !== 'undefined' && a.k !== 'null');
  if (nonNullAlts.length === 0) {
    return { hasMetadataArg: false };
  }

  const metaObjects = nonNullAlts.filter((a): a is Extract<AVal, { k: 'obj' }> => a.k === 'obj');
  const hasUnresolvedMeta = metaObjects.length !== nonNullAlts.length;
  if (metaObjects.length === 0) {
    return { hasMetadataArg: true, customMetadataUnresolved: true };
  }

  const contentType = resolveEffectiveContentType(
    rawAlts,
    hasUnresolvedMeta,
    spec,
    dataFacts,
    force,
  );

  if (hasUnresolvedMeta) {
    const out: {
      hasMetadataArg: boolean;
      contentType?: string;
      customMetadataUnresolved: boolean;
    } = {
      hasMetadataArg: true,
      customMetadataUnresolved: true,
    };
    if (contentType !== undefined) out.contentType = contentType;
    return out;
  }

  const customProp = spec.customMetadataProp ?? 'customMetadata';
  let metaSpreadWithoutCustom = false;
  let customUnresolved = false;
  const rawCustomValues: (AVal | undefined)[] = [];
  for (const obj of metaObjects) {
    const rawCustom = obj.props.get(customProp);
    if (rawCustom) {
      const forcedCustom = force(rawCustom);
      const customAlts = alternatives(forcedCustom).filter(
        (a) => a.k !== 'undefined' && a.k !== 'null',
      );
      if (customAlts.some((a) => a.k !== 'obj')) {
        customUnresolved = true;
      }
      rawCustomValues.push(forcedCustom);
    } else {
      if (obj.open || obj.computed.length > 0) metaSpreadWithoutCustom = true;
      rawCustomValues.push(undefined);
    }
  }

  if (customUnresolved) {
    const out: {
      hasMetadataArg: boolean;
      contentType?: string;
      customMetadataUnresolved: boolean;
    } = {
      hasMetadataArg: true,
      customMetadataUnresolved: true,
    };
    if (contentType !== undefined) out.contentType = contentType;
    return out;
  }

  const presentCustom = rawCustomValues.filter((v): v is AVal => v !== undefined);
  if (presentCustom.length === 0) {
    const out: { hasMetadataArg: boolean; contentType?: string; customMetadataOpen?: boolean } = {
      hasMetadataArg: true,
    };
    if (contentType !== undefined) out.contentType = contentType;
    if (metaSpreadWithoutCustom) out.customMetadataOpen = true;
    return out;
  }

  const customVals: AVal[] = rawCustomValues.map((v) => {
    if (v !== undefined) return v;
    return { k: 'obj', props: new Map(), computed: [], open: false, optional: new Set() };
  });
  if (rawAlts.length > nonNullAlts.length) {
    customVals.push({ k: 'obj', props: new Map(), computed: [], open: false, optional: new Set() });
  }

  const customObjects = customVals.flatMap((v) =>
    alternatives(v).filter((a): a is Extract<AVal, { k: 'obj' }> => a.k === 'obj'),
  );
  if (customObjects.length === 0) {
    const out: { hasMetadataArg: boolean; contentType?: string; customMetadataOpen?: boolean } = {
      hasMetadataArg: true,
    };
    if (contentType !== undefined) out.contentType = contentType;
    if (metaSpreadWithoutCustom) out.customMetadataOpen = true;
    return out;
  }

  const shape = payloadShape(union(customVals), force, '.');
  const topLevelFields = shape.fields.filter((f) => !f.name.includes('.'));
  const sortedFields = [...topLevelFields].sort((a, b) => {
    if (a.name < b.name) return -1;
    if (a.name > b.name) return 1;
    return 0;
  });
  const keys = sortedFields.map((f) => f.name);
  const customRecord: Record<string, PayloadField> = {};
  for (const f of sortedFields) {
    Object.defineProperty(customRecord, f.name, {
      value: f,
      enumerable: true,
      writable: true,
      configurable: true,
    });
  }

  const out: {
    hasMetadataArg: boolean;
    contentType?: string;
    customMetadataKeys?: readonly string[];
    customMetadata?: Readonly<Record<string, PayloadField>>;
    customMetadataOpen?: boolean;
    metadataPayload?: PayloadShape;
  } = {
    hasMetadataArg: true,
    customMetadataKeys: keys,
    customMetadata: customRecord,
    metadataPayload: shape,
  };
  if (contentType !== undefined) out.contentType = contentType;
  if (shape.open || metaSpreadWithoutCustom) out.customMetadataOpen = true;
  return out;
}

/** Extract static Storage upload facts (`contentType`, `sizeBytes`, `customMetadata`) for a call site. */
export function extractStorageUpload(
  ev: Evaluator,
  force: (v: AVal) => AVal,
  call: ts.CallExpression,
  spec: UploadPayloadSpec,
  env: Env | undefined,
): ExtractedUploadInfo {
  const dataFacts = extractDataFacts(call, spec, ev, force, env);
  const metaFacts = extractMetadataFacts(call, spec, dataFacts, ev, force, env);

  let contentType = dataFacts.inferredContentType;
  if (metaFacts.hasMetadataArg) {
    contentType = metaFacts.contentType;
  }
  const hasAny =
    contentType !== undefined
    || dataFacts.sizeBytes !== undefined
    || metaFacts.customMetadataKeys !== undefined
    || metaFacts.customMetadataOpen === true
    || metaFacts.customMetadataUnresolved === true;

  if (!hasAny) {
    return {};
  }

  const upload: {
    contentType?: string;
    sizeBytes?: number;
    customMetadataKeys?: readonly string[];
    customMetadata?: Readonly<Record<string, PayloadField>>;
    customMetadataOpen?: boolean;
    customMetadataUnresolved?: boolean;
  } = {};
  if (contentType !== undefined) upload.contentType = contentType;
  if (dataFacts.sizeBytes !== undefined) upload.sizeBytes = dataFacts.sizeBytes;
  if (metaFacts.customMetadataKeys !== undefined) upload.customMetadataKeys = metaFacts.customMetadataKeys;
  if (metaFacts.customMetadata !== undefined) upload.customMetadata = metaFacts.customMetadata;
  if (metaFacts.customMetadataOpen) upload.customMetadataOpen = true;
  if (metaFacts.customMetadataUnresolved) upload.customMetadataUnresolved = true;

  const result: { storageUpload?: StorageUploadMetadata; metadataPayload?: PayloadShape } = {
    storageUpload: upload,
  };
  if (metaFacts.metadataPayload !== undefined) {
    result.metadataPayload = metaFacts.metadataPayload;
  }
  return result;
}
