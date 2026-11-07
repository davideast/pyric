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
//
// The Admin SDK (`firebase-admin/firestore`) reaches it through its own
// `FIRESTORE_EMULATOR_HOST`, and then sends `Authorization: Bearer owner` and
// names its library (`gccl/`) on every call. Those calls, and no client SDK
// call that sends the same bearer, are answered from `admin-firestore` exchanges
// (`admin-firestore.ts`): BatchGetDocuments, RunQuery, RunAggregationQuery,
// Commit, BeginTransaction, Rollback and Listen. Any other call, and any
// Admin call no exchange holds, is refused and listed in `unmatched`.
import { readdirSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { runInNewContext } from 'node:vm';
import { AdminFirestore, type AdminAnswer } from './admin-firestore.ts';
import { ADMIN_FIRESTORE_STREAMING, ADMIN_FIRESTORE_UNARY, type Json, type JsonObject } from './format.ts';
import { ListenStream, WriteStream, type ReplayState, type StreamSession } from './firestore.ts';
import type { StreamHandler } from './webchannel.ts';

/** The parts of `@grpc/grpc-js` this server uses. */
interface Grpc {
  Server: new () => GrpcServer;
  ServerCredentials: { createInsecure(): unknown };
}
interface GrpcServer {
  addService(service: Record<string, MethodDefinition>, handlers: Record<string, GrpcHandler>): void;
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
  /** The decoded request of a unary or server-streaming call. */
  request?: JsonObject;
  on(event: 'data', listener: (message: JsonObject) => void): void;
  on(event: 'end' | 'cancelled' | 'error', listener: () => void): void;
  write(message: unknown): boolean;
  end(): void;
  emit(event: 'error', status: { code: number; details: string }): boolean;
}

/** A unary call's callback: an error status, or no error and the answer. */
type UnaryCallback = (status: { code: number; details: string } | null, value?: unknown) => void;
type GrpcHandler = (call: DuplexCall, callback?: UnaryCallback) => void;

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

/** How an RPC streams, and its response type when it is not `<rpc>Response`. */
interface RpcShape {
  requestStream: boolean;
  responseStream: boolean;
  responseType?: string;
}

const BIDI: RpcShape = { requestStream: true, responseStream: true };

/** Response types that are not `google.firestore.v1.<rpc>Response`. */
const RESPONSE_TYPES: Readonly<Record<string, string>> = { Rollback: 'google.protobuf.Empty' };

function method(root: ProtoRoot, rpc: string, shape: RpcShape): MethodDefinition {
  const request = codec(root.lookupType(`google.firestore.v1.${rpc}Request`));
  const response = codec(root.lookupType(shape.responseType ?? `google.firestore.v1.${rpc}Response`));
  return {
    path: `/google.firestore.v1.Firestore/${rpc}`,
    requestStream: shape.requestStream,
    responseStream: shape.responseStream,
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

/**
 * Whether a call names `@google-cloud/firestore`, the library firebase-admin
 * wraps: it sends `gccl/<version>` in `x-goog-api-client` on every call. The
 * client SDK's Node build sends `gl-node/<version> fire/<version>
 * grpc/<version>` there (`createMetadata` in `@firebase/firestore`), with no
 * `gccl/`.
 */
function namesAdminLibrary(call: DuplexCall): boolean {
  const header = call.metadata.get('x-goog-api-client')[0];
  return typeof header === 'string' && /(^| )gccl\//.test(header);
}

/**
 * Whether a call came from the Admin SDK in emulator mode, which always sends
 * `Bearer owner`. A client SDK call can send the same bearer
 * (`connectFirestoreEmulator` with `mockUserToken: 'owner'`), so the call
 * must also name the Admin SDK's library, or it gets no Admin answer
 * (`admin-firestore.test.ts`). Any other bearer is refused before an Admin
 * exchange is tried (`admin-auth.test.ts`).
 */
function isAdminCall(call: DuplexCall): boolean {
  return call.metadata.get('authorization')[0] === 'Bearer owner' && namesAdminLibrary(call);
}

/** The handler for one Listen or Write stream: an Admin Listen, or a client stream as its bearer's uid. */
function streamHandler(state: ReplayState, admin: AdminFirestore, rpc: 'Listen' | 'Write', call: DuplexCall, session: StreamSession): StreamHandler {
  const isAdminListen = rpc === 'Listen' && isAdminCall(call);
  if (isAdminListen) return admin.listen(session);
  const as = uidOf(state, call);
  return rpc === 'Listen' ? new ListenStream(session, state, as) : new WriteStream(session, state, as);
}

function serve(state: ReplayState, admin: AdminFirestore, rpc: 'Listen' | 'Write', call: DuplexCall): void {
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
  const handler = streamHandler(state, admin, rpc, call, session);
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

/**
 * The Firestore v1 RPCs no exchange answers, and whether each streams its
 * answers. Each is answered UNIMPLEMENTED and listed in `unmatched`, where a
 * scenario's last check finds it.
 */
const OTHER_RPCS: Readonly<Record<string, boolean>> = {
  PartitionQuery: false,
  BatchWrite: false,
  GetDocument: false,
  ListDocuments: false,
  CreateDocument: false,
  UpdateDocument: false,
  DeleteDocument: false,
  ListCollectionIds: false,
};

const UNIMPLEMENTED = 12;
/** An Admin call no exchange holds fails with FAILED_PRECONDITION, as an unrecorded client stream message does (`firestore.ts`). */
const FAILED_PRECONDITION = 9;
const asBytes = (value: unknown): Buffer => (Buffer.isBuffer(value) ? value : Buffer.alloc(0));

/** Refuses a call no exchange answers with `code`, through the callback for a unary call. */
function refuse(call: DuplexCall, callback: UnaryCallback | undefined, details: string, code = UNIMPLEMENTED): void {
  const status = { code, details };
  if (callback) callback(status);
  else call.emit('error', status);
}

/** Sends an Admin answer: the unary response, or each streamed response, then its final status. */
function send(call: DuplexCall, callback: UnaryCallback | undefined, answer: AdminAnswer): void {
  const status = answer.error ? { code: answer.error.code, details: answer.error.message } : null;
  if (callback) {
    if (status) callback(status);
    else callback(null, answer.responses[0] ?? {});
    return;
  }
  for (const response of answer.responses) call.write(response);
  if (status) call.emit('error', status);
  else call.end();
}

/**
 * The RPCs `admin-firestore` exchanges answer, other than Listen. An Admin
 * call gets the recorded answer, or is refused when none matches; a client
 * SDK call is never answered from an Admin exchange, and is refused as an
 * RPC no recording holds.
 */
function adminRpcs(state: ReplayState, admin: AdminFirestore, root: ProtoRoot): { definitions: Record<string, MethodDefinition>; handlers: Record<string, GrpcHandler> } {
  const definitions: Record<string, MethodDefinition> = {};
  const handlers: Record<string, GrpcHandler> = {};
  const rpcs = [...ADMIN_FIRESTORE_UNARY.map((name) => [name, false] as const), ...ADMIN_FIRESTORE_STREAMING.map((name) => [name, true] as const)];
  for (const [name, streams] of rpcs) {
    definitions[name] = method(root, name, { requestStream: false, responseStream: streams, responseType: RESPONSE_TYPES[name] });
    handlers[name] = (call, callback) => {
      const request = call.request ?? {};
      if (!isAdminCall(call)) {
        state.unmatched.push({ rpc: 'grpc', as: uidOf(state, call), request: { method: name } });
        refuse(call, callback, `replay: no recording answers ${name}`);
        return;
      }
      const answer = admin.answer(name, request);
      if (answer) send(call, callback, answer);
      else refuse(call, callback, `replay: no admin-firestore exchange answers ${name} ${JSON.stringify(request)}`, FAILED_PRECONDITION);
    };
  }
  return { definitions, handlers };
}

/** The other RPCs' definitions, which read no message, and handlers that list each call and refuse it. */
function otherRpcs(state: ReplayState): { definitions: Record<string, MethodDefinition>; handlers: Record<string, GrpcHandler> } {
  const definitions: Record<string, MethodDefinition> = {};
  const handlers: Record<string, GrpcHandler> = {};
  for (const [name, streams] of Object.entries(OTHER_RPCS)) {
    definitions[name] = {
      path: `/google.firestore.v1.Firestore/${name}`,
      requestStream: false,
      responseStream: streams,
      requestSerialize: asBytes,
      requestDeserialize: (bytes) => bytes,
      responseSerialize: asBytes,
      responseDeserialize: (bytes) => bytes,
    };
    handlers[name] = (call, callback) => {
      state.unmatched.push({ rpc: 'grpc', as: uidOf(state, call), request: { method: name } });
      refuse(call, callback, `replay: no recording answers ${name}`);
    };
  }
  return { definitions, handlers };
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
  const admin = new AdminFirestore(state);
  const answered = adminRpcs(state, admin, root);
  const others = otherRpcs(state);
  server.addService(
    { Listen: method(root, 'Listen', BIDI), Write: method(root, 'Write', BIDI), ...answered.definitions, ...others.definitions },
    {
      Listen: (call) => serve(state, admin, 'Listen', call),
      Write: (call) => serve(state, admin, 'Write', call),
      ...answered.handlers,
      ...others.handlers,
    },
  );
  const port = await new Promise<number>((resolve, reject) => {
    server.bindAsync('127.0.0.1:0', sdk.grpc.ServerCredentials.createInsecure(), (error, bound) => (error ? reject(error) : resolve(bound)));
  });
  startServing(server);
  return { host: `127.0.0.1:${port}`, port, close: () => server.forceShutdown() };
}
