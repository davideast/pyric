/**
 * Static payload byte-length and default runtime `contentType` resolution for
 * Cloud Storage upload data arguments (`uploadBytes`, `uploadBytesResumable`,
 * `uploadString`, and Admin `file.save`).
 */
import ts from 'typescript';
import { BASE64_RE, utf8ByteLength } from './binary-constructors.js';
import type { Evaluator } from './evaluator.js';
import type { UploadPayloadSpec } from './service-models/types.js';
import { alternatives, literalText, ownRecordValue, type AVal, type Env } from './values.js';

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

export interface DataFacts {
  readonly sizeBytes?: number;
  readonly inferredContentType?: string;
  readonly knownNoIntrinsicMime?: boolean;
}

export type ContentTypeOutcome =
  | { readonly kind: 'unset' }
  | { readonly kind: 'lit'; readonly value: string }
  | { readonly kind: 'unknown' };

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

function defaultUploadStringContentType(
  spec: UploadPayloadSpec,
  format: StringEncodingFormat | null,
): string | undefined {
  if (spec.formatArg === undefined) return 'application/octet-stream';
  if (format === 'raw') return 'text/plain;charset=utf-8';
  if (format === 'base64' || format === 'base64url') return 'application/octet-stream';
  return undefined;
}

export function extractDataFacts(
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
    if (spec.stringData) {
      const defaultMime = defaultUploadStringContentType(spec, format);
      if (defaultMime !== undefined) {
        return { inferredContentType: defaultMime, knownNoIntrinsicMime: true };
      }
      return { knownNoIntrinsicMime: true };
    }
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
    if (format === null) return { knownNoIntrinsicMime: true };
    if (text === null) {
      const defaultMime = defaultUploadStringContentType(spec, format);
      if (defaultMime !== undefined) {
        return { inferredContentType: defaultMime, knownNoIntrinsicMime: true };
      }
      return {};
    }
    if (format === 'raw') {
      return {
        sizeBytes: utf8ByteLength(text),
        inferredContentType: defaultUploadStringContentType(spec, 'raw'),
        knownNoIntrinsicMime: true,
      };
    }
    if (format === 'base64') {
      return {
        sizeBytes: decodeBase64ByteLength(text),
        inferredContentType: 'application/octet-stream',
        knownNoIntrinsicMime: true,
      };
    }
    if (format === 'base64url') {
      return {
        sizeBytes: decodeBase64UrlByteLength(text),
        inferredContentType: 'application/octet-stream',
        knownNoIntrinsicMime: true,
      };
    }
    const parsed = parseDataUrl(text);
    if (!parsed) return {};
    const out: { sizeBytes?: number; inferredContentType?: string } = {};
    if (parsed.sizeBytes !== undefined) out.sizeBytes = parsed.sizeBytes;
    if (parsed.mediaType !== undefined) out.inferredContentType = parsed.mediaType;
    return out;
  }

  return {};
}

export function resolveEmptyUploadContentType(
  spec: UploadPayloadSpec,
  dataFacts: DataFacts,
): ContentTypeOutcome {
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

export function resolveUnsetBranchRuntimeContentType(
  spec: UploadPayloadSpec,
  dataFacts: DataFacts,
): string | undefined {
  if (spec.dataArg === undefined) return undefined;
  if (dataFacts.inferredContentType !== undefined) return dataFacts.inferredContentType;
  if (!spec.stringData && dataFacts.knownNoIntrinsicMime) return 'application/octet-stream';
  return undefined;
}
