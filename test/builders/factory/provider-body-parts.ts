/**
 * The shape of a billable body's content, and where it may carry an image.
 * The price counts an image part at a fixed token figure and every other
 * byte as text (`provider-prices.ts`), so image data is counted only where
 * the API reads an image:
 *
 * - `contents[].parts[].inlineData` and `systemInstruction.parts[].inlineData`;
 * - an interaction's `input[]` item with `type: 'image'`.
 *
 * Content is checked by an allowlist: a content holds `role` and `parts`, a
 * part holds `text`, `inlineData` or `thoughtSignature`, and an interaction
 * item is text or an image. So a function call, a function response or any
 * other part is refused, and a `data` field anywhere else in the body is
 * refused. On the image and music models a response schema is refused, and
 * a response format may only name its type, aspect ratio, priced image size
 * and mime type.
 */
import type { ProviderCallKind } from './provider-prices.ts';

export interface ImageParts {
  count: number;
  /** Bytes of the parts' data, which the price counts as image parts, not text. */
  dataBytes: number;
}

export type PartsCheck =
  | { ok: true; images: ImageParts }
  | { ok: false; reason: 'field' | 'input'; field: string };

/**
 * The image sizes the table's image price covers: 512 (the app's 0.5K), 1K
 * and 2K. A larger size is refused. The price is bounded by
 * `maxOutputTokens`, so a smaller size costs no more than 1K.
 */
export const PRICED_IMAGE_SIZES: ReadonlySet<string> = new Set(['512', '1K', '2K']);

const CONTENT_FIELDS = new Set(['role', 'parts']);
const PART_FIELDS = new Set(['text', 'inlineData', 'thoughtSignature']);
const INLINE_DATA_FIELDS = new Set(['mimeType', 'data']);
const TEXT_ITEM_FIELDS = new Set(['type', 'text']);
const IMAGE_ITEM_FIELDS = new Set(['type', 'data', 'mimeType']);
const RESPONSE_FORMAT_FIELDS = new Set(['type', 'aspectRatio', 'imageSize', 'mimeType']);
/** The top-level fields whose content this file checks in full. */
const CONTENT_ROOTS = new Set(['contents', 'systemInstruction', 'input']);
const SCHEMA_FIELDS = ['responseSchema', 'responseJsonSchema'];
/** Longest string a response format field may hold. */
const FORMAT_VALUE_BYTES = 32;

type Fields = Record<string, unknown>;

/** A field name in either case the API reads, `generation_config` or `generationConfig`. */
export function camel(name: string): string {
  return name.replace(/_([a-z])/g, (_, letter: string) => letter.toUpperCase());
}

export function fieldsOf(value: unknown): Fields | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Fields) : undefined;
}

/** The value of `name` in `fields`, in either spelling. */
export function entryOf(fields: Fields, name: string): unknown {
  const key = Object.keys(fields).find((candidate) => camel(candidate) === name);
  return key === undefined ? undefined : fields[key];
}

function strayKey(fields: Fields, allowed: ReadonlySet<string>): string | undefined {
  return Object.keys(fields).find((key) => !allowed.has(camel(key)));
}

class Refusal {
  constructor(readonly reason: 'field' | 'input', readonly field: string) {}
}

function isImageMime(value: unknown): boolean {
  return typeof value === 'string' && value.startsWith('image/');
}

/** Counts one image's data, refusing data that isn't a string or an image. */
function countImage(fields: Fields, where: string, images: ImageParts): void {
  const data = entryOf(fields, 'data');
  if (typeof data !== 'string') throw new Refusal('field', `${where}.data`);
  if (!isImageMime(entryOf(fields, 'mimeType'))) throw new Refusal('input', `${where}.mimeType`);
  images.count += 1;
  images.dataBytes += Buffer.byteLength(data);
}

function checkPart(value: unknown, where: string, images: ImageParts): void {
  const part = fieldsOf(value);
  if (part === undefined) throw new Refusal('field', where);
  const stray = strayKey(part, PART_FIELDS);
  if (stray !== undefined) throw new Refusal('field', `${where}.${stray}`);
  const text = entryOf(part, 'text');
  const signature = entryOf(part, 'thoughtSignature');
  if (text !== undefined && typeof text !== 'string') throw new Refusal('field', `${where}.text`);
  if (signature !== undefined && typeof signature !== 'string') throw new Refusal('field', `${where}.thoughtSignature`);
  const rawInline = entryOf(part, 'inlineData');
  if (rawInline === undefined) return;
  const inline = fieldsOf(rawInline);
  const strayInline = inline === undefined ? 'inlineData' : strayKey(inline, INLINE_DATA_FIELDS);
  if (inline === undefined || strayInline !== undefined) throw new Refusal('field', `${where}.inlineData${inline === undefined ? '' : `.${strayInline}`}`);
  countImage(inline, `${where}.inlineData`, images);
}

function checkContent(value: unknown, where: string, images: ImageParts): void {
  const content = fieldsOf(value);
  if (content === undefined) throw new Refusal('field', where);
  const stray = strayKey(content, CONTENT_FIELDS);
  if (stray !== undefined) throw new Refusal('field', `${where}.${stray}`);
  const role = entryOf(content, 'role');
  if (role !== undefined && typeof role !== 'string') throw new Refusal('field', `${where}.role`);
  const parts = entryOf(content, 'parts');
  if (!Array.isArray(parts)) throw new Refusal('field', `${where}.parts`);
  parts.forEach((part, index) => checkPart(part, `${where}.parts[${index}]`, images));
}

function checkItem(value: unknown, where: string, images: ImageParts): void {
  const item = fieldsOf(value);
  if (item === undefined) throw new Refusal('field', where);
  const type = entryOf(item, 'type');
  const isText = type === 'text';
  if (!isText && type !== 'image') throw new Refusal('field', `${where}.type`);
  const stray = strayKey(item, isText ? TEXT_ITEM_FIELDS : IMAGE_ITEM_FIELDS);
  if (stray !== undefined) throw new Refusal('field', `${where}.${stray}`);
  if (isText) {
    if (typeof entryOf(item, 'text') !== 'string') throw new Refusal('field', `${where}.text`);
    return;
  }
  countImage(item, where, images);
}

function checkRoots(fields: Fields, images: ImageParts): void {
  const contents = entryOf(fields, 'contents');
  if (contents !== undefined) {
    if (!Array.isArray(contents)) throw new Refusal('field', 'contents');
    contents.forEach((content, index) => checkContent(content, `contents[${index}]`, images));
  }
  const system = entryOf(fields, 'systemInstruction');
  if (system !== undefined && typeof system !== 'string') checkContent(system, 'systemInstruction', images);
  const input = entryOf(fields, 'input');
  if (input === undefined || typeof input === 'string') return;
  if (!Array.isArray(input)) throw new Refusal('field', 'input');
  input.forEach((item, index) => checkItem(item, `input[${index}]`, images));
}

/** A `data` key outside the content roots, at any level. */
function strayData(value: unknown, where: string): string | undefined {
  if (Array.isArray(value)) return value.map((item, index) => strayData(item, `${where}[${index}]`)).find((found) => found !== undefined);
  const fields = fieldsOf(value);
  if (fields === undefined) return undefined;
  for (const [key, inner] of Object.entries(fields)) {
    const path = where === '' ? key : `${where}.${key}`;
    if (camel(key) === 'data') return path;
    const found = strayData(inner, path);
    if (found !== undefined) return found;
  }
  return undefined;
}

function checkResponseFormat(fields: Fields): void {
  const raw = entryOf(fields, 'responseFormat');
  if (raw === undefined) return;
  const format = fieldsOf(raw);
  if (format === undefined) throw new Refusal('field', 'responseFormat');
  const stray = strayKey(format, RESPONSE_FORMAT_FIELDS);
  if (stray !== undefined) throw new Refusal('field', `responseFormat.${stray}`);
  for (const [key, value] of Object.entries(format)) {
    const isShortString = typeof value === 'string' && Buffer.byteLength(value) <= FORMAT_VALUE_BYTES;
    if (!isShortString) throw new Refusal('field', `responseFormat.${key}`);
  }
  const size = entryOf(format, 'imageSize');
  if (size !== undefined && !PRICED_IMAGE_SIZES.has(size as string)) throw new Refusal('field', 'responseFormat.imageSize');
}

function checkMediaOutput(fields: Fields): void {
  const config = fieldsOf(entryOf(fields, 'generationConfig')) ?? {};
  const schema = SCHEMA_FIELDS.find((name) => entryOf(config, name) !== undefined);
  if (schema !== undefined) throw new Refusal('field', `generationConfig.${schema}`);
  checkResponseFormat(fields);
}

/**
 * The body's image parts, or the first field that the price can't cover.
 * `fields` has passed the forwarder's field allowlist.
 */
export function checkParts(fields: Fields, kind: ProviderCallKind): PartsCheck {
  const images: ImageParts = { count: 0, dataBytes: 0 };
  try {
    checkRoots(fields, images);
    const outside = Object.fromEntries(Object.entries(fields).filter(([key]) => !CONTENT_ROOTS.has(camel(key))));
    const stray = strayData(outside, '');
    if (stray !== undefined) throw new Refusal('field', stray);
    if (kind !== 'text') checkMediaOutput(fields);
  } catch (error) {
    if (error instanceof Refusal) return { ok: false, reason: error.reason, field: error.field };
    throw error;
  }
  return { ok: true, images };
}
