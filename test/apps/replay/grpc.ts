// Firestore's Listen and Write streams over gRPC, the transport the Node
// build of the Firestore SDK uses, answered from the same recorded exchanges
// as the WebChannel streams. The server is `@grpc/grpc-js` with the protos
// the installed `@firebase/firestore` Node build carries, both loaded from
// the SDK a project installed, so the wire format is that SDK's own.
//
// Recordings hold proto3 JSON, as WebChannel carries it. The Node SDK speaks
// binary protobuf, so each request is decoded and written as proto3 JSON
// before it is matched (timestamps as RFC 3339, bytes as base64, enums by
// name), and each answer is converted back. A stream error is the gRPC status
// the recording names.
//
// A Node app reaches it with the SDK's own emulator connector,
// `connectFirestoreEmulator(db, '127.0.0.1', port)`: the app's config, which
// live mode passes through unchanged.
import { readdirSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { runInNewContext } from 'node:vm';
import type { Json, JsonObject } from './format.ts';
import { ListenStream, WriteStream, type ReplayState, type StreamSession } from './firestore.ts';
import type { StreamHandler } from './webchannel.ts';

/** The parts of `@grpc/grpc-js` this server uses. */
interface Grpc {
  Server: new () => GrpcServer;
  ServerCredentials: { createInsecure(): unknown };
}
interface GrpcServer {
  addService(service: Record<string, MethodDefinition>, handlers: Record<string, (call: DuplexCall) => void>): void;
  bindAsync(address: string, credentials: unknown, done: (error: Error | null, port: number) => void): void;
  forceShutdown(): void;
  /** Required before serving by grpc-js before 1.10, deprecated after. */
  start?(): void;
}
interface MethodDefinition {
  path: string;
  requestStream: boolean;
  responseStream: boolean;
  requestSerialize(value: unknown): Buffer;
  requestDeserialize(bytes: Buffer): unknown;
  responseSerialize(value: unknown): Buffer;
  responseDeserialize(bytes: Buffer): unknown;
}
interface DuplexCall {
  metadata: { get(key: string): unknown[] };
  on(event: 'data', listener: (message: JsonObject) => void): void;
  on(event: 'end' | 'cancelled' | 'error', listener: () => void): void;
  write(message: unknown): boolean;
  end(): void;
  emit(event: 'error', status: { code: number; details: string }): boolean;
}

/** The parts of protobufjs this server uses. */
interface ProtoType {
  fullName: string;
  fields: Record<string, ProtoField>;
  decode(bytes: Uint8Array): unknown;
  encode(message: unknown): { finish(): Uint8Array };
  fromObject(object: unknown): unknown;
  toObject(message: unknown, options: Record<string, unknown>): Record<string, unknown>;
}
interface ProtoField {
  map?: boolean;
  repeated: boolean;
  resolve(): ProtoField;
  resolvedType: ProtoType | { values: Record<string, number> } | null;
}
interface ProtoRoot {
  lookupType(name: string): ProtoType;
}
interface Protobuf {
  Root: { fromJSON(json: unknown): ProtoRoot };
}

export interface GrpcReplay {
  /** `127.0.0.1:<port>`, the host `connectFirestoreEmulator` takes. */
  host: string;
  port: number;
  close(): void;
}

/** The SDK pieces the gRPC server needs, from the `firebase` installed at `projectDir`. */
interface InstalledSdk {
  grpc: Grpc;
  protobuf: Protobuf;
  protos: unknown;
}

function installedSdk(projectDir: string): InstalledSdk {
  const fromProject = createRequire(join(projectDir, 'package.json'));
  const fromFirebase = createRequire(fromProject.resolve('firebase/firestore'));
  const firestoreEntry = fromFirebase.resolve('@firebase/firestore');
  const fromFirestore = createRequire(firestoreEntry);
  const protoLoader = fromFirestore.resolve('@grpc/proto-loader');
  return {
    grpc: fromFirestore('@grpc/grpc-js') as Grpc,
    protobuf: createRequire(protoLoader)('protobufjs') as Protobuf,
    protos: firestoreProtos(dirname(firestoreEntry)),
  };
}

/** Where the bundle's protos object starts: `var protos = { [options: options,] nested: nested };`. */
const PROTOS_OBJECT = '\nvar protos = {';
/** The proto tree the protos object names, declared just before it. */
const NESTED = '\nconst nested = ';

/**
 * The proto definitions the Firestore Node build loads with
 * `protoLoader.fromJSON`, read from that build's own file: the `nested`
 * object literal the bundle inlines and does not export. Builds since
 * `@firebase/firestore` 4.17 also declare `options` (`syntax: "proto3"`),
 * which protobufjs does not need.
 */
export function firestoreProtos(distDir: string): unknown {
  for (const file of readdirSync(distDir).filter((name) => name.endsWith('.node.mjs'))) {
    const text = readFileSync(join(distDir, file), 'utf8');
    const end = text.indexOf(PROTOS_OBJECT);
    const start = end === -1 ? -1 : text.lastIndexOf(NESTED, end);
    if (start === -1) continue;
    const literal = text.slice(start + NESTED.length, end).trim().replace(/;$/, '');
    return { nested: runInNewContext(`(${literal})`) };
  }
  throw new Error(`replay: no Firestore protos in the Node build in ${distDir}`);
}

const TIMESTAMP = '.google.protobuf.Timestamp';
const WRAPPERS = new Set(['.google.protobuf.Int32Value', '.google.protobuf.Int64Value', '.google.protobuf.BoolValue', '.google.protobuf.StringValue']);

/** RFC 3339 with the nanoseconds Firestore keeps, from a Timestamp's seconds and nanos. */
export function timestampJson(value: { seconds?: string | number; nanos?: number }): string {
  const seconds = Number(value.seconds ?? 0);
  const iso = new Date(seconds * 1000).toISOString().replace(/\.\d{3}Z$/, '');
  const nanos = value.nanos ?? 0;
  // Firestore keeps microseconds; a time with finer nanoseconds keeps all nine digits.
  const fraction = nanos % 1000 === 0 ? String(nanos / 1000).padStart(6, '0') : String(nanos).padStart(9, '0');
  return `${iso}.${fraction}Z`;
}

/** A Timestamp's seconds and nanos, from RFC 3339. */
export function timestampProto(text: string): { seconds: string; nanos: number } {
  const match = /^(.*?)(?:\.(\d{1,9}))?Z$/.exec(text);
  if (!match) throw new Error(`replay: ${text} is not an RFC 3339 time`);
  const seconds = Math.floor(Date.parse(`${match[1]}Z`) / 1000);
  return { seconds: String(seconds), nanos: Number((match[2] ?? '').padEnd(9, '0')) };
}

function messageType(field: ProtoField): ProtoType | null {
  const resolved = field.resolve().resolvedType;
  return resolved !== null && 'fields' in resolved ? resolved : null;
}

/** Walks a decoded message (protobufjs object form) into proto3 JSON. */
function toJson(type: ProtoType, object: Record<string, unknown>): JsonObject {
  if (`.${type.fullName.replace(/^\./, '')}` === TIMESTAMP) return timestampJson(object) as unknown as JsonObject;
  const json: JsonObject = {};
  for (const [name, value] of Object.entries(object)) {
    const field = type.fields[name];
    const inner = field ? messageType(field) : null;
    json[name] = inner ? convertValue(inner, value, field!, toJsonValue) : value as Json;
  }
  return json;
}

function toJsonValue(type: ProtoType, value: unknown): Json {
  const name = `.${type.fullName.replace(/^\./, '')}`;
  if (name === TIMESTAMP) return timestampJson(value as { seconds?: string; nanos?: number });
  if (WRAPPERS.has(name)) return (value as { value?: Json }).value ?? null;
  return toJson(type, value as Record<string, unknown>);
}

/** Walks proto3 JSON into the object form protobufjs `fromObject` takes. */
function fromJsonValue(type: ProtoType, value: unknown): unknown {
  const name = `.${type.fullName.replace(/^\./, '')}`;
  if (name === TIMESTAMP) return timestampProto(value as string);
  if (WRAPPERS.has(name)) return { value };
  const object: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    const field = type.fields[key];
    const inner = field ? messageType(field) : null;
    object[key] = inner ? convertValue(inner, item, field!, fromJsonValue) : item;
  }
  return object;
}

function convertValue<T>(type: ProtoType, value: unknown, field: ProtoField, convert: (type: ProtoType, value: unknown) => T): unknown {
  if (value === null || value === undefined) return value;
  if (field.map) return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([key, item]) => [key, convert(type, item)]));
  if (field.repeated && Array.isArray(value)) return value.map((item) => convert(type, item));
  return convert(type, value);
}

function codec(type: ProtoType): Pick<MethodDefinition, 'requestSerialize' | 'requestDeserialize'> {
  return {
    requestSerialize: (value) => Buffer.from(type.encode(type.fromObject(fromJsonValue(type, value))).finish()),
    requestDeserialize: (bytes) => toJson(type, type.toObject(type.decode(bytes), { longs: String, enums: String, bytes: String })),
  };
}

function method(root: ProtoRoot, rpc: 'Listen' | 'Write'): MethodDefinition {
  const request = codec(root.lookupType(`google.firestore.v1.${rpc}Request`));
  const response = codec(root.lookupType(`google.firestore.v1.${rpc}Response`));
  return {
    path: `/google.firestore.v1.Firestore/${rpc}`,
    requestStream: true,
    responseStream: true,
    requestSerialize: request.requestSerialize,
    requestDeserialize: request.requestDeserialize,
    responseSerialize: response.requestSerialize,
    responseDeserialize: response.requestDeserialize,
  };
}

/** The uid of the stream's bearer token, as the WebChannel handshake reads it. */
function uidOf(state: ReplayState, call: DuplexCall): string | null {
  const header = call.metadata.get('authorization')[0];
  const bearer = typeof header === 'string' ? /^Bearer (.+)$/.exec(header)?.[1] : undefined;
  return state.tokens.uidOf(bearer);
}

function serve(state: ReplayState, rpc: 'Listen' | 'Write', call: DuplexCall): void {
  let open = true;
  const session: StreamSession = {
    send: (message) => {
      if (open) call.write(message);
    },
    fail: (error) => {
      if (!open) return;
      open = false;
      call.emit('error', { code: error.code, details: error.message });
    },
  };
  const as = uidOf(state, call);
  const handler: StreamHandler = rpc === 'Listen' ? new ListenStream(session, state, as) : new WriteStream(session, state, as);
  call.on('data', (message) => handler.onMessage(message));
  const close = () => {
    if (!open) return;
    open = false;
    handler.onClose();
    call.end();
  };
  call.on('end', close);
  call.on('cancelled', close);
  call.on('error', close);
}

/** grpc-js before 1.10 serves only after `start()`; later versions start on bind and only warn. */
function startServing(server: GrpcServer): void {
  try {
    server.start?.();
  } catch {
    // Already started by the bind.
  }
}

/** Starts the gRPC streams on 127.0.0.1, sharing `state` with the WebChannel and Auth server. */
export async function startGrpcReplay(state: ReplayState, projectDir: string): Promise<GrpcReplay> {
  const sdk = installedSdk(projectDir);
  const root = sdk.protobuf.Root.fromJSON(sdk.protos);
  const server = new sdk.grpc.Server();
  server.addService(
    { Listen: method(root, 'Listen'), Write: method(root, 'Write') },
    { Listen: (call) => serve(state, 'Listen', call), Write: (call) => serve(state, 'Write', call) },
  );
  const port = await new Promise<number>((resolve, reject) => {
    server.bindAsync('127.0.0.1:0', sdk.grpc.ServerCredentials.createInsecure(), (error, bound) => (error ? reject(error) : resolve(bound)));
  });
  startServing(server);
  return { host: `127.0.0.1:${port}`, port, close: () => server.forceShutdown() };
}
