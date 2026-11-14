/**
 * Browser-clean static upload metadata extraction (`contentType`, HTTP headers,
 * `customMetadata`) for Cloud Storage write operations (`uploadBytes`,
 * `uploadBytesResumable`, `uploadString`, `updateMetadata`, and Admin `file.save`).
 */
import ts from 'typescript';
import type { Evaluator } from './evaluator.js';
import { payloadShape } from './payload.js';
import type { UploadPayloadSpec } from './service-models/types.js';
import {
  extractDataFacts,
  resolveEmptyUploadContentType,
  resolveUnsetBranchRuntimeContentType,
  type ContentTypeOutcome,
  type DataFacts,
} from './storage-upload-data-facts.js';
import type {
  PayloadField,
  PayloadShape,
  StorageHttpHeaderKey,
  StorageUploadMetadata,
} from './types.js';
import { alternatives, literalText, union, type AVal, type Env } from './values.js';

export interface ExtractedUploadInfo {
  readonly storageUpload?: StorageUploadMetadata;
  readonly metadataPayload?: PayloadShape;
}

const HTTP_METADATA_PROPS: readonly StorageHttpHeaderKey[] = [
  'cacheControl',
  'contentDisposition',
  'contentEncoding',
  'contentLanguage',
];

interface ExtractedHttpMetadata {
  readonly values: Partial<Record<StorageHttpHeaderKey, string>>;
  readonly unresolved: boolean;
  readonly unresolvedFields: readonly StorageHttpHeaderKey[];
}

interface ResolvedContentTypeFacts {
  readonly contentType?: string;
  readonly blobContentTypeUnresolved?: boolean;
}

function resolveEffectiveContentType(
  rawAlts: readonly AVal[] | undefined,
  hasUnresolvedMeta: boolean,
  spec: UploadPayloadSpec,
  dataFacts: DataFacts,
  force: (v: AVal) => AVal,
): ResolvedContentTypeFacts {
  const fromUnset = (): ResolvedContentTypeFacts => {
    const resolved = resolveUnsetBranchRuntimeContentType(spec, dataFacts);
    if (resolved !== undefined) return { contentType: resolved };
    if (dataFacts.runtimeBlobMime) return { blobContentTypeUnresolved: true };
    return {};
  };

  if (!rawAlts) return fromUnset();
  const nonNullAlts = rawAlts.filter((a) => a.k !== 'undefined' && a.k !== 'null');
  if (nonNullAlts.length === 0) return fromUnset();
  if (hasUnresolvedMeta) return {};

  const outcomes: ContentTypeOutcome[] = [];
  for (const alt of rawAlts) {
    if (alt.k === 'undefined' || alt.k === 'null') {
      outcomes.push({ kind: 'unset' });
      continue;
    }
    if (alt.k !== 'obj') {
      return {};
    }
    if (!alt.props.has('contentType')) {
      if (alt.open || alt.computed.length > 0) return {};
      outcomes.push({ kind: 'unset' });
      continue;
    }
    if (alt.optional.has('contentType')) {
      outcomes.push({ kind: 'unset' });
    }
    const ctAlts = alternatives(force(alt.props.get('contentType')!));
    if (ctAlts.length === 0) return {};
    for (const ctAlt of ctAlts) {
      if (ctAlt.k === 'undefined' || (ctAlt.k === 'null' && spec.dataArg !== undefined && !spec.stringData)) {
        outcomes.push({ kind: 'unset' });
        continue;
      }
      const text = literalText(ctAlt);
      if (text === null) return {};
      if (text === '' && spec.dataArg !== undefined) {
        outcomes.push(resolveEmptyUploadContentType(spec, dataFacts));
      } else {
        outcomes.push({ kind: 'lit', value: text });
      }
    }
  }

  if (outcomes.some((o) => o.kind === 'unknown')) {
    if (dataFacts.runtimeBlobMime) return { blobContentTypeUnresolved: true };
    return {};
  }
  if (outcomes.every((o) => o.kind === 'unset')) {
    return fromUnset();
  }

  const values = new Set<string>();
  for (const outcome of outcomes) {
    if (outcome.kind === 'lit') {
      values.add(outcome.value);
      continue;
    }
    const fallback = resolveUnsetBranchRuntimeContentType(spec, dataFacts);
    if (fallback === undefined) {
      if (dataFacts.runtimeBlobMime) return { blobContentTypeUnresolved: true };
      return {};
    }
    values.add(fallback);
  }
  if (values.size === 1) return { contentType: [...values][0]! };
  return {};
}

function extractHttpMetadataFields(
  rawAlts: readonly AVal[],
  metaObjects: readonly Extract<AVal, { k: 'obj' }>[],
  force: (v: AVal) => AVal,
): ExtractedHttpMetadata {
  const values: Partial<Record<StorageHttpHeaderKey, string>> = {};
  const unresolvedFields: StorageHttpHeaderKey[] = [];

  for (const prop of HTTP_METADATA_PROPS) {
    if (!metaObjects.some((obj) => obj.props.has(prop))) {
      continue;
    }
    let sawUnset = false;
    let sawUnknown = false;
    const literals = new Set<string>();
    for (const alt of rawAlts) {
      if (alt.k === 'undefined' || alt.k === 'null') {
        sawUnset = true;
        continue;
      }
      if (alt.k !== 'obj') {
        sawUnknown = true;
        continue;
      }
      if (!alt.props.has(prop)) {
        if (alt.open || alt.computed.length > 0) sawUnknown = true;
        else sawUnset = true;
        continue;
      }
      if (alt.optional.has(prop)) {
        sawUnset = true;
      }
      const propAlts = alternatives(force(alt.props.get(prop)!));
      if (propAlts.length === 0) {
        sawUnknown = true;
        continue;
      }
      for (const propAlt of propAlts) {
        if (propAlt.k === 'undefined' || propAlt.k === 'null') {
          sawUnset = true;
          continue;
        }
        const text = literalText(propAlt);
        if (text === null) {
          sawUnknown = true;
        } else {
          literals.add(text);
        }
      }
    }
    if (!sawUnknown && !sawUnset && literals.size === 1) {
      values[prop] = [...literals][0]!;
    } else if (sawUnknown || (literals.size > 0 && (sawUnset || literals.size > 1))) {
      unresolvedFields.push(prop);
    }
  }

  return {
    values,
    unresolved: unresolvedFields.length > 0,
    unresolvedFields,
  };
}

function applyHttpMetadataToFacts(
  target: {
    cacheControl?: string;
    contentDisposition?: string;
    contentEncoding?: string;
    contentLanguage?: string;
    httpMetadataUnresolved?: boolean;
    httpMetadataUnresolvedFields?: readonly StorageHttpHeaderKey[];
  },
  httpMeta: ExtractedHttpMetadata,
): void {
  if (httpMeta.values.cacheControl !== undefined) {
    target.cacheControl = httpMeta.values.cacheControl;
  }
  if (httpMeta.values.contentDisposition !== undefined) {
    target.contentDisposition = httpMeta.values.contentDisposition;
  }
  if (httpMeta.values.contentEncoding !== undefined) {
    target.contentEncoding = httpMeta.values.contentEncoding;
  }
  if (httpMeta.values.contentLanguage !== undefined) {
    target.contentLanguage = httpMeta.values.contentLanguage;
  }
  if (httpMeta.unresolved) {
    target.httpMetadataUnresolved = true;
    target.httpMetadataUnresolvedFields = httpMeta.unresolvedFields;
  }
}

interface ExtractedMetaFacts {
  hasMetadataArg: boolean;
  contentType?: string;
  blobContentTypeUnresolved?: boolean;
  cacheControl?: string;
  contentDisposition?: string;
  contentEncoding?: string;
  contentLanguage?: string;
  httpMetadataUnresolved?: boolean;
  httpMetadataUnresolvedFields?: readonly StorageHttpHeaderKey[];
  customMetadataKeys?: readonly string[];
  customMetadata?: Readonly<Record<string, PayloadField>>;
  customMetadataOpen?: boolean;
  customMetadataUnresolved?: boolean;
  metadataPayload?: PayloadShape;
}

function extractMetadataFacts(
  call: ts.CallExpression,
  spec: UploadPayloadSpec,
  dataFacts: DataFacts,
  ev: Evaluator,
  force: (v: AVal) => AVal,
  env: Env | undefined,
): ExtractedMetaFacts {
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

  const ctFacts = resolveEffectiveContentType(
    rawAlts,
    hasUnresolvedMeta,
    spec,
    dataFacts,
    force,
  );
  const httpMeta = extractHttpMetadataFields(rawAlts, metaObjects, force);

  const applyResolvedContentType = (target: ExtractedMetaFacts): void => {
    if (ctFacts.contentType !== undefined) target.contentType = ctFacts.contentType;
    if (ctFacts.blobContentTypeUnresolved) target.blobContentTypeUnresolved = true;
  };

  if (hasUnresolvedMeta) {
    const out: ExtractedMetaFacts = {
      hasMetadataArg: true,
      customMetadataUnresolved: true,
    };
    applyResolvedContentType(out);
    applyHttpMetadataToFacts(out, httpMeta);
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
    const out: ExtractedMetaFacts = {
      hasMetadataArg: true,
      customMetadataUnresolved: true,
    };
    applyResolvedContentType(out);
    applyHttpMetadataToFacts(out, httpMeta);
    return out;
  }

  const presentCustom = rawCustomValues.filter((v): v is AVal => v !== undefined);
  if (presentCustom.length === 0) {
    const out: ExtractedMetaFacts = { hasMetadataArg: true };
    applyResolvedContentType(out);
    if (metaSpreadWithoutCustom) out.customMetadataOpen = true;
    applyHttpMetadataToFacts(out, httpMeta);
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
    const out: ExtractedMetaFacts = { hasMetadataArg: true };
    applyResolvedContentType(out);
    if (metaSpreadWithoutCustom) out.customMetadataOpen = true;
    applyHttpMetadataToFacts(out, httpMeta);
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

  const out: ExtractedMetaFacts = {
    hasMetadataArg: true,
    customMetadataKeys: keys,
    customMetadata: customRecord,
    metadataPayload: shape,
  };
  applyResolvedContentType(out);
  if (shape.open || metaSpreadWithoutCustom) out.customMetadataOpen = true;
  applyHttpMetadataToFacts(out, httpMeta);
  return out;
}

/** Extract static Storage upload facts (`contentType`, `sizeBytes`, HTTP headers, `customMetadata`) for a call site. */
export function extractStorageUpload(
  ev: Evaluator,
  force: (v: AVal) => AVal,
  call: ts.CallExpression,
  spec: UploadPayloadSpec,
  env: Env | undefined,
): ExtractedUploadInfo {
  const dataFacts = extractDataFacts(call, spec, ev, force, env);
  const metaFacts = extractMetadataFacts(call, spec, dataFacts, ev, force, env);

  let contentType = resolveUnsetBranchRuntimeContentType(spec, dataFacts);
  let blobContentTypeUnresolved =
    contentType === undefined && dataFacts.runtimeBlobMime === true;
  if (metaFacts.hasMetadataArg) {
    contentType = metaFacts.contentType;
    blobContentTypeUnresolved = metaFacts.blobContentTypeUnresolved === true;
  }

  const hasAny =
    contentType !== undefined
    || blobContentTypeUnresolved
    || dataFacts.sizeBytes !== undefined
    || metaFacts.cacheControl !== undefined
    || metaFacts.contentDisposition !== undefined
    || metaFacts.contentEncoding !== undefined
    || metaFacts.contentLanguage !== undefined
    || metaFacts.httpMetadataUnresolved === true
    || metaFacts.customMetadataKeys !== undefined
    || metaFacts.customMetadataOpen === true
    || metaFacts.customMetadataUnresolved === true;

  if (!hasAny) {
    return {};
  }

  const upload: {
    contentType?: string;
    blobContentTypeUnresolved?: boolean;
    sizeBytes?: number;
    cacheControl?: string;
    contentDisposition?: string;
    contentEncoding?: string;
    contentLanguage?: string;
    httpMetadataUnresolved?: boolean;
    httpMetadataUnresolvedFields?: readonly StorageHttpHeaderKey[];
    customMetadataKeys?: readonly string[];
    customMetadata?: Readonly<Record<string, PayloadField>>;
    customMetadataOpen?: boolean;
    customMetadataUnresolved?: boolean;
  } = {};
  if (contentType !== undefined) upload.contentType = contentType;
  if (blobContentTypeUnresolved) upload.blobContentTypeUnresolved = true;
  if (dataFacts.sizeBytes !== undefined) upload.sizeBytes = dataFacts.sizeBytes;
  if (metaFacts.cacheControl !== undefined) upload.cacheControl = metaFacts.cacheControl;
  if (metaFacts.contentDisposition !== undefined) upload.contentDisposition = metaFacts.contentDisposition;
  if (metaFacts.contentEncoding !== undefined) upload.contentEncoding = metaFacts.contentEncoding;
  if (metaFacts.contentLanguage !== undefined) upload.contentLanguage = metaFacts.contentLanguage;
  if (metaFacts.httpMetadataUnresolved) {
    upload.httpMetadataUnresolved = true;
    if (metaFacts.httpMetadataUnresolvedFields !== undefined) {
      upload.httpMetadataUnresolvedFields = metaFacts.httpMetadataUnresolvedFields;
    }
  }
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
