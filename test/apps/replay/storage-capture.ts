// Capture S (`packages/conformance/src/capture/storage-live/recordings/capture-s-wire.json`)
// as `storage` exchanges, converted when a replay server loads it, so no copied
// fixture can drift from what production sent.
//
// Every Storage exchange in the capture becomes one exchange on the default
// bucket, `<project>.firebasestorage.app`, and one more on a second bucket,
// `<project>-live-second`, with the bucket renamed. Production answers both
// the same way for the same rules, and an app's row takes its bucket from the
// reference, so a second production bucket would add nothing. The capture's
// Auth exchanges become none: two anonymous sign-ups send the same request,
// which the replay answers with one recording, so a caller signs its clients
// in with custom tokens of its own.
//
// The capture's placeholders become test-project values: `<project>` the
// project, `<bucket>` the bucket, `<run>` `replay`, `<uid-N>` `user-N`, and
// `<etag>` a fixed test value. `<generation>`, `<time-created>` and
// `<download-token>` become the `generation`, `timeCreated` and
// `downloadToken` placeholders, filled once per object. `<time-updated>`
// becomes `timeCreated` too: the replay keeps no write times, so an object's
// `updated` reads as its creation time even after updateMetadata. An upload
// id and an upload URL become `uploadSession` placeholders. A list page's
// `<page-token>` becomes a fixed token, `replay-page-N`, and the request that
// sends it back names the token of the latest page before it with the same
// prefix.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { assertShapesOnly, FORMAT, type Json, type JsonObject, type Recording, type StorageExchange } from './format.ts';
import { MEDIA_KEY, storagePathOf, uploadOf } from './storage.ts';

export const CAPTURE_S = fileURLToPath(new URL('../../../packages/conformance/src/capture/storage-live/recordings/capture-s-wire.json', import.meta.url));
/** What the capture's `<run>` becomes: every object it wrote sits under `pyric_oracle/<run>`. */
export const CAPTURE_S_RUN = 'replay';
/** The etag a converted answer carries: the capture redacts production's. */
export const CAPTURE_S_ETAG = 'replay-etag';

/** One HTTP body as capture S writes it. */
export type CaptureBody =
  | { kind: 'json'; json: Json }
  | { kind: 'bytes'; length: number; sha256: string; base64?: string }
  | { kind: 'multipart'; parts: Array<{ contentType: string; body: CaptureBody }> }
  | { kind: 'text'; text: string };

/** One HTTP exchange as capture S writes it. */
export interface CaptureSExchange {
  seq: number;
  op: string;
  client: string;
  service: string;
  /** The uid the Authorization header named, `<uid-N>`, or null for none. */
  account: string | null;
  method: string;
  host: string;
  path: string;
  query: Record<string, string>;
  request: { headers: Record<string, string>; body?: CaptureBody };
  response: { status: number; headers: Record<string, string>; body?: CaptureBody };
}

export interface CaptureS {
  sdkVersion: string;
  exchanges: CaptureSExchange[];
}

export function readCaptureS(path: string = CAPTURE_S): CaptureS {
  return JSON.parse(readFileSync(path, 'utf8')) as CaptureS;
}

/** The two buckets a converted capture serves for `project`: the default one and the second. */
export function captureSBuckets(project: string): { default: string; second: string } {
  return { default: `${project}.firebasestorage.app`, second: `${project}-live-second` };
}

/** Capture S as a replay recording for `project`, on both buckets, checked like any recording. */
export function loadCaptureS(project: string, path: string = CAPTURE_S): Recording {
  const recording = captureSRecording(readCaptureS(path), project);
  assertShapesOnly(recording);
  return recording;
}

export function captureSRecording(capture: CaptureS, project: string): Recording {
  const buckets = captureSBuckets(project);
  const exchanges = [
    ...convertBucket(capture, project, buckets.default, 'default'),
    ...convertBucket(capture, project, buckets.second, 'second'),
  ];
  const leftover = /<[a-z]+(-[a-z0-9]+)*>/.exec(JSON.stringify(exchanges));
  if (leftover) throw new Error(`capture S: ${leftover[0]} is a capture placeholder the conversion does not replace`);
  return {
    format: FORMAT,
    project,
    source: `capture S (packages/conformance/src/capture/storage-live/recordings/capture-s-wire.json, firebase ${capture.sdkVersion}), converted when loaded, on ${buckets.default} and ${buckets.second}`,
    exchanges,
  };
}

/** Whole capture values that become a replay placeholder or a fixed value. */
const WHOLE_VALUES: Record<string, Json> = {
  '<generation>': { $: 'generation' },
  '<time-created>': { $: 'timeCreated' },
  '<time-updated>': { $: 'timeCreated' },
  '<download-token>': { $: 'downloadToken' },
  '<upload-session>': { $: 'uploadSession' },
  '<etag>': CAPTURE_S_ETAG,
};

/** Response headers whose value is an upload URL production issued. */
const UPLOAD_URL_HEADERS = new Set(['x-goog-upload-url', 'x-goog-upload-control-url']);

/** Every Storage exchange of the capture, on `bucket`, with ids that start with `label`. */
function convertBucket(capture: CaptureS, project: string, bucket: string, label: string): StorageExchange[] {
  const conversion = new BucketConversion(project, bucket, label);
  return capture.exchanges.filter((exchange) => exchange.service === 'storage').map((exchange) => conversion.exchange(exchange));
}

type SentContent = Pick<StorageExchange['request'], 'metadata' | 'bytes'>;

/** One bucket's conversion. It keeps the page tokens that bucket's list pages issued. */
class BucketConversion {
  private readonly pages = new PageTokens();

  constructor(private readonly project: string, private readonly bucket: string, private readonly label: string) {}

  exchange(exchange: CaptureSExchange): StorageExchange {
    const target = storagePathOf(this.text(exchange.path));
    if (!target) throw new Error(`capture S: exchange ${exchange.seq} path ${exchange.path} is not an object or bucket path`);
    const query = this.template(exchange.query) as JsonObject;
    if (query.pageToken !== undefined) query.pageToken = this.pages.sentBack(query);
    const request: StorageExchange['request'] = { method: exchange.method, ...target, query };
    const { headers: sent } = exchange.request;
    const upload = uploadOf(sent['x-goog-upload-protocol'], sent['x-goog-upload-command'], query);
    if (upload) request.upload = upload;
    Object.assign(request, this.sentContent(exchange.request.body));
    const body = this.answerBody(exchange.response.body);
    if (isObject(body) && body.nextPageToken !== undefined) body.nextPageToken = this.pages.issue(query);
    const headers = Object.fromEntries(Object.entries(exchange.response.headers).map(([name, value]) => [name, UPLOAD_URL_HEADERS.has(name) ? { $: 'uploadSession' } : this.template(value)]));
    return {
      kind: 'storage',
      id: `${this.label}-s${exchange.seq}`,
      as: exchange.account === null ? null : this.text(exchange.account),
      request,
      response: { status: exchange.response.status, headers, body },
    };
  }

  /** A capture string with its placeholders as this bucket's test values. */
  private text(value: string): string {
    return value
      .replaceAll('<project>', this.project)
      .replaceAll('<bucket>', this.bucket)
      .replaceAll('<run>', CAPTURE_S_RUN)
      .replace(/<uid-(\d+)>/g, (_, n: string) => `user-${n}`);
  }

  /** A capture value with every placeholder replaced: a whole value by its replay placeholder, any other string by `text`. */
  private template(value: Json): Json {
    if (typeof value === 'string') return Object.hasOwn(WHOLE_VALUES, value) ? WHOLE_VALUES[value]! : this.text(value);
    if (Array.isArray(value)) return value.map((item) => this.template(item));
    if (!isObject(value)) return value;
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, this.template(item)]));
  }

  /** The metadata JSON and object bytes a captured request body sent. */
  private sentContent(body: CaptureBody | undefined): SentContent {
    if (body?.kind === 'json') return { metadata: this.template(body.json) as JsonObject };
    if (body?.kind === 'bytes') return { bytes: { length: body.length, sha256: body.sha256 } };
    if (body?.kind !== 'multipart') return {};
    const [metadata, bytes] = body.parts.map((part) => part.body);
    const content: SentContent = {};
    if (metadata?.kind === 'json') content.metadata = this.template(metadata.json) as JsonObject;
    if (bytes?.kind === 'bytes') content.bytes = { length: bytes.length, sha256: bytes.sha256 };
    return content;
  }

  /** A captured answer body as a recording holds it: JSON, text, the object's bytes, or null for none. */
  private answerBody(body: CaptureBody | undefined): Json {
    if (!body) return null;
    if (body.kind === 'json') return this.template(body.json);
    if (body.kind === 'text') return body.text;
    if (body.kind !== 'bytes') throw new Error('capture S: a multipart answer is not one Storage sends');
    if (body.base64 === undefined) throw new Error('capture S: an answer\'s bytes were captured without their content');
    return { [MEDIA_KEY]: body.base64 };
  }
}

function isObject(value: Json): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** The fixed page tokens one bucket's list pages carry, by the prefix each list named. */
class PageTokens {
  private count = 0;
  private readonly latest = new Map<string, string>();

  issue(query: JsonObject): string {
    this.count += 1;
    const token = `replay-page-${this.count}`;
    this.latest.set(String(query.prefix ?? ''), token);
    return token;
  }

  sentBack(query: JsonObject): string {
    const token = this.latest.get(String(query.prefix ?? ''));
    if (!token) throw new Error(`capture S: a list sent a page token for ${String(query.prefix)} before any page carried one`);
    return token;
  }
}
