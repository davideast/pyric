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
  const match = /^data:([^,]*),(.*)$/s.exec(raw);
  if (!match) return undefined;
  const header = match[1]!;
  const body = match[2]!;
  const parts = header.split(';');
  const firstToken = parts[0]?.trim() ?? '';
  let mediaType: string | undefined;
  if (firstToken.includes('/')) {
    mediaType = firstToken;
  }
  const isBase64 = parts.slice(1).some((p) => p.trim().toLowerCase() === 'base64');
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

function exactStringProp(
  obj: Extract<AVal, { k: 'obj' }>,
  prop: string,
  force: (v: AVal) => AVal,
): string | undefined {
  const raw = obj.props.get(prop);
  if (!raw) return undefined;
  const text = literalText(force(raw));
  if (text !== null && text.length > 0) return text;
  return undefined;
}

function extractDataFacts(
  call: ts.CallExpression,
  spec: UploadPayloadSpec,
  ev: Evaluator,
  force: (v: AVal) => AVal,
  env: Env | undefined,
): { sizeBytes?: number; inferredContentType?: string } {
  if (spec.dataArg === undefined) return {};
  const dataExpr = call.arguments[spec.dataArg];
  if (!dataExpr || ts.isSpreadElement(dataExpr)) return {};

  const format = resolveStringFormat(call, spec, ev, force, env);
  const alts = alternatives(force(ev.eval(dataExpr, env)));
  if (alts.length !== 1) return {};
  const only = alts[0]!;

  if (only.k === 'obj') {
    const byteLen = exactNumberProp(only, 'byteLength', force) ?? exactNumberProp(only, 'size', force);
    const blobType = exactStringProp(only, 'type', force);
    const out: { sizeBytes?: number; inferredContentType?: string } = {};
    if (byteLen !== undefined) out.sizeBytes = byteLen;
    if (blobType !== undefined) out.inferredContentType = blobType;
    return out;
  }

  if (spec.stringData) {
    const text = literalText(only);
    if (text === null || format === null) return {};
    if (format === 'raw') return { sizeBytes: utf8ByteLength(text) };
    if (format === 'base64') return { sizeBytes: decodeBase64ByteLength(text) };
    if (format === 'base64url') return { sizeBytes: decodeBase64UrlByteLength(text) };
    const parsed = parseDataUrl(text);
    if (!parsed) return {};
    const out: { sizeBytes?: number; inferredContentType?: string } = {};
    if (parsed.sizeBytes !== undefined) out.sizeBytes = parsed.sizeBytes;
    if (parsed.mediaType !== undefined) out.inferredContentType = parsed.mediaType;
    return out;
  }

  return {};
}

function extractMetadataFacts(
  call: ts.CallExpression,
  spec: UploadPayloadSpec,
  ev: Evaluator,
  force: (v: AVal) => AVal,
  env: Env | undefined,
): {
  contentType?: string;
  customMetadataKeys?: readonly string[];
  customMetadata?: Readonly<Record<string, PayloadField>>;
  customMetadataOpen?: boolean;
  metadataPayload?: PayloadShape;
} {
  if (spec.metadataArg === undefined) return {};
  const metaExpr = call.arguments[spec.metadataArg];
  if (!metaExpr || ts.isSpreadElement(metaExpr)) return {};

  const metaAlts = alternatives(force(ev.eval(metaExpr, env))).filter(
    (a) => a.k !== 'undefined' && a.k !== 'null',
  );
  const metaObjects = metaAlts.filter((a): a is Extract<AVal, { k: 'obj' }> => a.k === 'obj');
  if (metaObjects.length === 0) return {};

  let contentType: string | undefined;
  const contentTypes = new Set<string>();
  let allHaveContentType = true;
  for (const obj of metaObjects) {
    const ct = exactStringProp(obj, 'contentType', force);
    if (ct === undefined) {
      allHaveContentType = false;
    } else {
      contentTypes.add(ct);
    }
  }
  if (allHaveContentType && contentTypes.size === 1) {
    contentType = [...contentTypes][0];
  }

  const customProp = spec.customMetadataProp ?? 'customMetadata';
  const customVals: AVal[] = [];
  for (const obj of metaObjects) {
    const rawCustom = obj.props.get(customProp);
    if (rawCustom) customVals.push(force(rawCustom));
  }
  if (customVals.length === 0) {
    const out: { contentType?: string } = {};
    if (contentType !== undefined) out.contentType = contentType;
    return out;
  }

  const customObjects = customVals.flatMap((v) =>
    alternatives(v).filter((a): a is Extract<AVal, { k: 'obj' }> => a.k === 'obj'),
  );
  if (customObjects.length === 0) {
    const out: { contentType?: string } = {};
    if (contentType !== undefined) out.contentType = contentType;
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
    contentType?: string;
    customMetadataKeys?: readonly string[];
    customMetadata?: Readonly<Record<string, PayloadField>>;
    customMetadataOpen?: boolean;
    metadataPayload?: PayloadShape;
  } = {
    customMetadataKeys: keys,
    customMetadata: customRecord,
    metadataPayload: shape,
  };
  if (contentType !== undefined) out.contentType = contentType;
  if (shape.open) out.customMetadataOpen = true;
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
  const metaFacts = extractMetadataFacts(call, spec, ev, force, env);

  const contentType = metaFacts.contentType ?? dataFacts.inferredContentType;
  const hasAny =
    contentType !== undefined
    || dataFacts.sizeBytes !== undefined
    || metaFacts.customMetadataKeys !== undefined
    || metaFacts.customMetadataOpen === true;

  if (!hasAny) {
    return {};
  }

  const upload: {
    contentType?: string;
    sizeBytes?: number;
    customMetadataKeys?: readonly string[];
    customMetadata?: Readonly<Record<string, PayloadField>>;
    customMetadataOpen?: boolean;
  } = {};
  if (contentType !== undefined) upload.contentType = contentType;
  if (dataFacts.sizeBytes !== undefined) upload.sizeBytes = dataFacts.sizeBytes;
  if (metaFacts.customMetadataKeys !== undefined) upload.customMetadataKeys = metaFacts.customMetadataKeys;
  if (metaFacts.customMetadata !== undefined) upload.customMetadata = metaFacts.customMetadata;
  if (metaFacts.customMetadataOpen) upload.customMetadataOpen = true;

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
    if (alts.length === 0 || !alts.every((a) => a.k === 'arr')) return true;
  }
  return false;
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
    return closedObj([
      ['byteLength', { k: 'num', value: 0 }],
      ['length', { k: 'num', value: 0 }],
    ]);
  }
  const firstExpr = args[0]!;
  if (!ts.isSpreadElement(firstExpr)) {
    const first = ev.force(ev.eval(firstExpr, env));
    const exactCount = exactNonNegativeInt(first);
    if (exactCount !== undefined) {
      return closedObj([
        ['byteLength', { k: 'num', value: exactCount * elemBytes }],
        ['length', { k: 'num', value: exactCount }],
      ]);
    }
    if (first.k === 'arr' && !hasUnknownArraySpread(ev, firstExpr, env)) {
      const count = first.items.length;
      return closedObj([
        ['byteLength', { k: 'num', value: count * elemBytes }],
        ['length', { k: 'num', value: count }],
      ]);
    }
    if (args.length === 1 && first.k === 'obj') {
      const bufLen = first.props.get('byteLength');
      let exactBuf: number | undefined;
      if (bufLen) exactBuf = exactNonNegativeInt(ev.force(bufLen));
      if (exactBuf !== undefined) {
        return closedObj([
          ['byteLength', { k: 'num', value: exactBuf }],
          ['length', { k: 'num', value: Math.floor(exactBuf / elemBytes) }],
        ]);
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
    if (partsVal.k === 'arr' && !hasUnknownArraySpread(ev, args[0], env)) {
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
  const entries: [string, AVal][] = [['size', sizeVal]];
  if (args[1] && !ts.isSpreadElement(args[1])) {
    const opts = ev.force(ev.eval(args[1], env));
    if (opts.k === 'obj' && opts.props.has('type')) {
      const typeText = literalText(ev.force(opts.props.get('type')!));
      if (typeText !== null) entries.push(['type', lit(typeText)]);
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
