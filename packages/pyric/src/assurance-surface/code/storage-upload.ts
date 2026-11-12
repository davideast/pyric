/**
 * Browser-clean static upload metadata and byte-length extraction for
 * Cloud Storage write operations (`uploadBytes`, `uploadBytesResumable`,
 * `uploadString`, `updateMetadata`, and Admin `file.save` / `setMetadata`).
 */
import ts from 'typescript';
import type { Evaluator } from './evaluator.js';
import { payloadShape } from './payload.js';
import type { UploadPayloadSpec } from './service-models/types.js';
import type { PayloadField, PayloadShape, StorageUploadMetadata } from './types.js';
import { alternatives, lit, literalText, ownRecordValue, union, type AVal, type Env } from './values.js';

type StringEncodingFormat = 'raw' | 'base64' | 'base64url' | 'data_url';

const UTF8_ENCODER = new TextEncoder();

const TYPED_ARRAY_ELEMENT_BYTES: Readonly<Record<string, number>> = {
  Int8Array: 1,
  Uint8Array: 1,
  Uint8ClampedArray: 1,
  Int16Array: 2,
  Uint16Array: 2,
  Int32Array: 4,
  Uint32Array: 4,
  Float32Array: 4,
  Float64Array: 8,
  BigInt64Array: 8,
  BigUint64Array: 8,
};

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

const BASE64_RE = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;
const BASE64URL_RE = /^[A-Za-z0-9_-]*={0,2}$/;
const BASE64_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
const MAX_TRACKED_QUERY_BYTES = 1024;
const UINT8_LITERAL_BYTES = new WeakMap<Extract<AVal, { k: 'obj' }>, readonly number[]>();

export function literalUint8Bytes(val: AVal): readonly number[] | undefined {
  return val.k === 'obj' ? UINT8_LITERAL_BYTES.get(val) : undefined;
}

export function decodeBase64Bytes(raw: string): number[] | undefined {
  const clean = raw.replace(/[\t\n\r ]+/g, '');
  if (clean.length === 0) return [];
  if (clean.length % 4 !== 0 || !BASE64_RE.test(clean)) return undefined;
  const out: number[] = [];
  for (let i = 0; i < clean.length; i += 4) {
    const c0 = BASE64_ALPHABET.indexOf(clean[i]!);
    const c1 = BASE64_ALPHABET.indexOf(clean[i + 1]!);
    const ch2 = clean[i + 2]!;
    const ch3 = clean[i + 3]!;
    const c2 = ch2 === '=' ? 0 : BASE64_ALPHABET.indexOf(ch2);
    const c3 = ch3 === '=' ? 0 : BASE64_ALPHABET.indexOf(ch3);
    if (c0 < 0 || c1 < 0 || c2 < 0 || c3 < 0) return undefined;
    const triple = (c0 << 18) | (c1 << 12) | (c2 << 6) | c3;
    out.push((triple >> 16) & 0xff);
    if (ch2 !== '=') out.push((triple >> 8) & 0xff);
    if (ch3 !== '=') out.push(triple & 0xff);
    if (out.length > MAX_TRACKED_QUERY_BYTES) return undefined;
  }
  return out;
}

export interface ExtractedUploadInfo {
  readonly storageUpload?: StorageUploadMetadata;
  readonly metadataPayload?: PayloadShape;
}

export function utf8ByteLength(text: string): number {
  return UTF8_ENCODER.encode(text).byteLength;
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
  if (rem === 2) return Math.floor((unpadded.length * 3) / 4);
  return Math.floor((unpadded.length * 3) / 4);
}

function parseDataUrl(raw: string): { sizeBytes?: number; mediaType?: string } | undefined {
  const comma = raw.indexOf(',');
  if (!raw.startsWith('data:') || comma === -1) return undefined;
  const header = raw.slice(5, comma);
  const body = raw.slice(comma + 1);
  const isBase64 = header.endsWith(';base64');
  const mediaHeader = isBase64 ? header.slice(0, -7) : header;
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
  if (alts.length !== 1) return spec.stringData ? { knownNoIntrinsicMime: true } : {};
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
  return values.size === 1 ? [...values][0] : undefined;
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

  const contentType = metaFacts.hasMetadataArg
    ? metaFacts.contentType
    : dataFacts.inferredContentType;
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

function closedObj(entries: readonly [string, AVal][]): AVal {
  return {
    k: 'obj',
    props: new Map(entries),
    computed: [],
    open: false,
    optional: new Set(),
  };
}

function exactNonNegativeInt(v: AVal): number | undefined {
  if (v.k === 'num' && v.value !== undefined && Number.isInteger(v.value) && v.value >= 0) {
    return v.value;
  }
  return undefined;
}

function hasUnknownArraySpread(ev: Evaluator, expr: ts.Expression, env: Env | undefined): boolean {
  if (!ts.isArrayLiteralExpression(expr)) return false;
  for (const el of expr.elements) {
    if (!ts.isSpreadElement(el)) continue;
    const spreadVal = ev.force(ev.eval(el.expression, env));
    const alts = alternatives(spreadVal);
    if (alts.length !== 1 || alts[0]!.k !== 'arr' || alts[0]!.open) return true;
  }
  return false;
}

function attachUint8Bytes(
  obj: AVal,
  bytes: readonly number[] | undefined,
): AVal {
  if (bytes !== undefined && obj.k === 'obj') {
    UINT8_LITERAL_BYTES.set(obj, bytes);
  }
  return obj;
}

function extractUint8ArrayBytes(
  ev: Evaluator,
  items: readonly AVal[],
): number[] | undefined {
  if (items.length > MAX_TRACKED_QUERY_BYTES) return undefined;
  const bytes: number[] = [];
  for (const item of items) {
    const forced = ev.force(item);
    if (forced.k !== 'num' || forced.value === undefined || !Number.isFinite(forced.value)) {
      return undefined;
    }
    bytes.push(((Math.trunc(forced.value) % 256) + 256) % 256);
  }
  return bytes;
}

function evalTypedArrayOrBuffer(
  ev: Evaluator,
  name: string,
  args: readonly ts.Expression[],
  env: Env | undefined,
): AVal | undefined {
  if (name === 'TextEncoder') {
    return {
      k: 'obj',
      props: new Map([['__textEncoder', { k: 'bool', value: true }]]),
      computed: [],
      open: true,
      optional: new Set(),
    };
  }
  if (name === 'ArrayBuffer') {
    let first: AVal = { k: 'num', value: 0 };
    if (args[0] && !ts.isSpreadElement(args[0])) {
      first = ev.force(ev.eval(args[0], env));
    } else if (args[0]) {
      first = { k: 'num' };
    }
    const exact = exactNonNegativeInt(first);
    let lenVal: AVal = { k: 'num' };
    if (exact !== undefined) lenVal = { k: 'num', value: exact };
    return closedObj([['byteLength', lenVal]]);
  }
  const elemBytes = ownRecordValue(TYPED_ARRAY_ELEMENT_BYTES, name);
  if (elemBytes === undefined) return undefined;
  if (args.length === 0) {
    return attachUint8Bytes(
      closedObj([
        ['byteLength', { k: 'num', value: 0 }],
        ['length', { k: 'num', value: 0 }],
      ]),
      name === 'Uint8Array' ? [] : undefined,
    );
  }
  const firstExpr = args[0]!;
  if (!ts.isSpreadElement(firstExpr)) {
    const first = ev.force(ev.eval(firstExpr, env));
    const exactCount = exactNonNegativeInt(first);
    if (exactCount !== undefined) {
      const zeroBytes =
        name === 'Uint8Array' && exactCount <= MAX_TRACKED_QUERY_BYTES
          ? new Array<number>(exactCount).fill(0)
          : undefined;
      return attachUint8Bytes(
        closedObj([
          ['byteLength', { k: 'num', value: exactCount * elemBytes }],
          ['length', { k: 'num', value: exactCount }],
        ]),
        zeroBytes,
      );
    }
    if (first.k === 'arr' && !first.open && !hasUnknownArraySpread(ev, firstExpr, env)) {
      const count = first.items.length;
      const arrBytes = name === 'Uint8Array' ? extractUint8ArrayBytes(ev, first.items) : undefined;
      return attachUint8Bytes(
        closedObj([
          ['byteLength', { k: 'num', value: count * elemBytes }],
          ['length', { k: 'num', value: count }],
        ]),
        arrBytes,
      );
    }
    if (args.length === 1 && first.k === 'obj') {
      const bufLen = first.props.get('byteLength');
      let exactBuf: number | undefined;
      if (bufLen) exactBuf = exactNonNegativeInt(ev.force(bufLen));
      if (exactBuf !== undefined) {
        const copiedBytes = name === 'Uint8Array' ? literalUint8Bytes(first) : undefined;
        return attachUint8Bytes(
          closedObj([
            ['byteLength', { k: 'num', value: exactBuf }],
            ['length', { k: 'num', value: Math.floor(exactBuf / elemBytes) }],
          ]),
          copiedBytes,
        );
      }
    }
  }
  return closedObj([
    ['byteLength', { k: 'num' }],
    ['length', { k: 'num' }],
  ]);
}

function evalBlobConstructor(
  ev: Evaluator,
  args: readonly ts.Expression[],
  env: Env | undefined,
): AVal {
  let totalBytes: number | undefined = 0;
  if (args[0] && !ts.isSpreadElement(args[0])) {
    const partsVal = ev.force(ev.eval(args[0], env));
    if (partsVal.k === 'arr' && !partsVal.open && !hasUnknownArraySpread(ev, args[0], env)) {
      for (const item of partsVal.items) {
        const forcedItem = ev.force(item);
        const itemText = literalText(forcedItem);
        if (itemText !== null) {
          totalBytes += utf8ByteLength(itemText);
          continue;
        }
        if (forcedItem.k === 'obj') {
          const rawLen = forcedItem.props.get('byteLength') ?? forcedItem.props.get('size');
          let exactLen: number | undefined;
          if (rawLen) exactLen = exactNonNegativeInt(ev.force(rawLen));
          if (exactLen !== undefined) {
            totalBytes += exactLen;
            continue;
          }
        }
        totalBytes = undefined;
        break;
      }
    } else {
      totalBytes = undefined;
    }
  } else if (args[0]) {
    totalBytes = undefined;
  }
  let sizeVal: AVal = { k: 'num' };
  if (totalBytes !== undefined) sizeVal = { k: 'num', value: totalBytes };
  const dynamicBlobType: AVal = { k: 'str', parts: [{ kind: 'hole', name: 'type', auth: [] }] };
  const entries: [string, AVal][] = [['size', sizeVal]];
  if (args[1]) {
    if (ts.isSpreadElement(args[1])) {
      entries.push(['type', dynamicBlobType]);
    } else {
      const optsAlts = alternatives(ev.force(ev.eval(args[1], env))).filter(
        (a) => a.k !== 'undefined' && a.k !== 'null',
      );
      if (optsAlts.some((a) => a.k !== 'obj')) {
        entries.push(['type', dynamicBlobType]);
      } else {
        const objOpts = optsAlts.filter((a): a is Extract<AVal, { k: 'obj' }> => a.k === 'obj');
        if (objOpts.length === 1 && !objOpts[0]!.open && objOpts[0]!.computed.length === 0) {
          const single = objOpts[0]!;
          if (single.props.has('type') && !single.optional.has('type')) {
            const typeText = literalText(ev.force(single.props.get('type')!));
            if (typeText !== null) {
              entries.push(['type', lit(typeText)]);
            } else {
              entries.push(['type', dynamicBlobType]);
            }
          } else if (single.props.has('type')) {
            entries.push(['type', dynamicBlobType]);
          }
        } else if (objOpts.length > 0) {
          entries.push(['type', dynamicBlobType]);
        }
      }
    }
  }
  return closedObj(entries);
}

/** Model typed arrays, `ArrayBuffer`, `Blob`, and `TextEncoder#encode` for static byte-length tracking. */
export function evalBinaryBuiltin(
  ev: Evaluator,
  node: ts.CallExpression | ts.NewExpression,
  env: Env | undefined,
): AVal | undefined {
  const callee = node.expression;
  const args = node.arguments ?? ts.factory.createNodeArray<ts.Expression>();
  if (ts.isNewExpression(node) && ts.isIdentifier(callee)) {
    if (callee.text === 'Blob') return evalBlobConstructor(ev, args, env);
    return evalTypedArrayOrBuffer(ev, callee.text, args, env);
  }
  if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(callee) && callee.name.text === 'encode') {
    const recv = ev.force(ev.eval(callee.expression, env));
    const isEncoder = alternatives(recv).some(
      (a) => a.k === 'obj' && a.props.get('__textEncoder')?.k === 'bool',
    );
    if (!isEncoder) return undefined;
    if (args.length === 0) {
      return closedObj([
        ['byteLength', { k: 'num', value: 0 }],
        ['length', { k: 'num', value: 0 }],
      ]);
    }
    const arg0 = args[0]!;
    if (!ts.isSpreadElement(arg0)) {
      const text = literalText(ev.force(ev.eval(arg0, env)));
      if (text !== null) {
        const n = utf8ByteLength(text);
        return closedObj([
          ['byteLength', { k: 'num', value: n }],
          ['length', { k: 'num', value: n }],
        ]);
      }
    }
    return closedObj([
      ['byteLength', { k: 'num' }],
      ['length', { k: 'num' }],
    ]);
  }
  return undefined;
}
