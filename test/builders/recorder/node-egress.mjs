// The builder recorder's Node layer. The harness loads it into every process
// a builder starts, through NODE_OPTIONS=--import <this file>, beside the
// PYRIC_BUILDER_NETWORK_LOG it writes to.
//
// It records, one JSON line each:
//   - every outbound request when it is created (the `undici:request:create`
//     channel for fetch and undici, the `http.client.request.*` channels for
//     `http.request` and `https.request`);
//   - every DNS query (`dns.lookup` and the `resolve*` family, callback and
//     promise forms);
//   - every client socket connect (`net.Socket.prototype.connect`, which
//     `net.connect`, `tls.connect`, the http Agents and undici all reach).
//
// For a Google host or the GCE metadata server it writes the line first and
// then refuses: the query fails and the socket is destroyed before it
// connects, so a run fails closed. It does not use pyric's net guard, which is
// part of what the builders test (#1475), and it never reads PYRIC_GUARD.
//
// Without PYRIC_BUILDER_NETWORK_LOG it throws, so a process the harness meant
// to record never runs unrecorded.
import { appendFileSync } from 'node:fs';
import diagnosticsChannel from 'node:diagnostics_channel';
import dns from 'node:dns';
import { syncBuiltinESMExports } from 'node:module';
import net from 'node:net';
import { fileURLToPath } from 'node:url';
import workerThreads from 'node:worker_threads';
import { classifyHost } from './google-hosts.ts';

const LOG_ENV = 'PYRIC_BUILDER_NETWORK_LOG';
const INSTALLED = Symbol.for('pyric.builders.node-egress');
const REFUSED_CODE = 'PYRIC_BUILDER_REFUSED';

const logPath = process.env[LOG_ENV];
if (!logPath) throw new Error(`${LOG_ENV} is not set: the builder recorder has nowhere to record, so this process does not start`);

const processLabel = [process.argv0, ...process.argv.slice(1)].join(' ').slice(0, 240);

/** Appends one event. Synchronous, so the line is on disk before a refusal. */
function record(event) {
  const line = { time: new Date().toISOString(), layer: 'node', pid: process.pid, thread: workerThreads.threadId, process: processLabel, ...event };
  appendFileSync(logPath, `${JSON.stringify(line)}\n`);
}

/** The host's classification, as the fields every event carries. */
function hostFields(host) {
  const verdict = classifyHost(host);
  return {
    host: verdict.host,
    google: verdict.google,
    catalogGap: verdict.catalogGap,
    metadata: verdict.metadata,
    ...(verdict.service ? { service: verdict.service } : {}),
  };
}

/** The recorder refuses every Google host and the metadata server. */
const isRefusedHost = (fields) => fields.google || fields.metadata;

/**
 * What the recorder did: `refused` or `allowed` for a DNS query, a socket and
 * a proxied request, which it can stop; `recorded` for a request at creation,
 * whose refusal comes at its DNS query or socket.
 */
const REFUSED = 'refused';
const ALLOWED = 'allowed';
const RECORDED = 'recorded';

function decided(event) {
  return { ...event, action: isRefusedHost(event) ? REFUSED : ALLOWED };
}

function refusalError(host, via) {
  const error = new Error(`the pyric builder recorder refused ${via} to ${host}: builder runs never reach Google or the metadata server`);
  error.code = REFUSED_CODE;
  return error;
}

function announce(host, via) {
  process.stderr.write(`[pyric-builders recorder] refused ${via} to ${host}\n`);
}

// ---------------------------------------------------------------- sockets

const isPort = (value) => typeof value === 'number' || (typeof value === 'string' && /^\d+$/.test(value));

/** An http Agent's options carry a request `path` beside a port; only a `path` with no port is an IPC socket. */
const isIpcOptions = (options) => options.path !== undefined && options.port === undefined;

/**
 * The hosts and port one `connect` call names, or null for an IPC socket.
 * `net.connect` hands the socket its arguments normalized into one array; a
 * TLS connection through a tunnel names its destination only in `servername`.
 */
function connectTarget(args) {
  const list = Array.isArray(args[0]) ? args[0] : args;
  const first = list[0];
  if (typeof first === 'object' && first !== null) {
    if (isIpcOptions(first)) return null;
    const hosts = new Set([first.host ?? 'localhost']);
    if (typeof first.servername === 'string' && first.servername !== '') hosts.add(first.servername);
    return { hosts: [...hosts], port: first.port };
  }
  if (isPort(first)) return { hosts: [typeof list[1] === 'string' ? list[1] : 'localhost'], port: first };
  return null;
}

function installSocketHook() {
  const originalConnect = net.Socket.prototype.connect;
  net.Socket.prototype.connect = function connect(...args) {
    const target = connectTarget(args);
    if (target === null) return originalConnect.apply(this, args);
    const hosts = target.hosts.map(hostFields);
    const refused = hosts.find(isRefusedHost);
    const action = refused === undefined ? ALLOWED : REFUSED;
    for (const fields of hosts) record({ kind: 'connect', via: 'socket', port: Number(target.port), ...fields, action });
    if (refused === undefined) return originalConnect.apply(this, args);
    announce(refused.host, 'a socket connect');
    const error = refusalError(refused.host, 'a socket connect');
    process.nextTick(() => this.destroy(error));
    return this;
  };
}

// ---------------------------------------------------------------- DNS

/** `lookup` and every `resolve*` function: each takes the hostname first. */
function queryNames(target) {
  return Object.keys(target).filter((name) => (name === 'lookup' || name.startsWith('resolve')) && typeof target[name] === 'function');
}

function patchCallbackQueries(target, via) {
  for (const name of queryNames(target)) {
    const original = target[name];
    target[name] = function query(hostname, ...rest) {
      if (typeof hostname !== 'string') return original.call(this, hostname, ...rest);
      const event = decided({ kind: 'dns', via: `${via}.${name}`, ...hostFields(hostname) });
      record(event);
      if (event.action !== REFUSED) return original.call(this, hostname, ...rest);
      announce(event.host, `dns.${name}`);
      const callback = rest.at(-1);
      const error = Object.assign(refusalError(event.host, `dns.${name}`), { hostname });
      if (typeof callback === 'function') process.nextTick(callback, error);
      return undefined;
    };
  }
}

function patchPromiseQueries(target, via) {
  for (const name of queryNames(target)) {
    const original = target[name];
    target[name] = function query(hostname, ...rest) {
      if (typeof hostname !== 'string') return original.call(this, hostname, ...rest);
      const event = decided({ kind: 'dns', via: `${via}.${name}`, ...hostFields(hostname) });
      record(event);
      if (event.action !== REFUSED) return original.call(this, hostname, ...rest);
      announce(event.host, `dns.promises.${name}`);
      return Promise.reject(Object.assign(refusalError(event.host, `dns.promises.${name}`), { hostname }));
    };
  }
}

function installDnsHooks() {
  patchCallbackQueries(dns, 'dns');
  patchCallbackQueries(dns.Resolver.prototype, 'dns.Resolver');
  patchPromiseQueries(dns.promises, 'dns.promises');
  patchPromiseQueries(dns.promises.Resolver.prototype, 'dns.promises.Resolver');
}

// ---------------------------------------------------------------- requests

/** The destination a request through a proxy names: a CONNECT target or an absolute-form URL. */
function proxiedHost(method, path) {
  if (typeof path !== 'string') return undefined;
  if (method === 'CONNECT') return path.replace(/:\d+$/, '').replace(/^\[(.*)\]$/, '$1');
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(path)) return undefined;
  try {
    return new URL(path).hostname;
  } catch {
    return undefined;
  }
}

function hostOfOrigin(origin) {
  try {
    return new URL(String(origin)).hostname;
  } catch {
    return String(origin);
  }
}

function recordUndiciRequest({ request }) {
  const origin = String(request.origin ?? '');
  const method = request.method;
  const path = request.path;
  record({ kind: 'request', via: 'undici', method, url: `${origin}${path ?? ''}`, ...hostFields(hostOfOrigin(origin)), action: RECORDED });
  // undici gives no safe way to fail a request from this channel, so a
  // proxied undici request is recorded only; the proxy's own process refuses it.
  const target = proxiedHost(method, path);
  if (target !== undefined) record({ kind: 'request', via: 'undici-proxied', method, url: path, ...hostFields(target), action: RECORDED });
}

const seenRequests = new WeakSet();

function recordHttpRequest({ request }) {
  if (seenRequests.has(request)) return;
  seenRequests.add(request);
  const host = request.host ?? 'localhost';
  const method = request.method;
  const path = request.path;
  const protocol = request.protocol ?? 'http:';
  record({ kind: 'request', via: 'http', method, url: `${protocol}//${host}${path ?? ''}`, ...hostFields(host), action: RECORDED });
  const target = proxiedHost(method, path);
  if (target === undefined) return;
  const event = decided({ kind: 'request', via: 'http-proxied', method, url: path, ...hostFields(target) });
  record(event);
  if (event.action !== REFUSED) return;
  // The socket to the proxy is still connecting, so nothing has been written.
  announce(event.host, 'a request through a proxy');
  const error = refusalError(event.host, 'a request through a proxy');
  process.nextTick(() => request.destroy(error));
}

function installRequestChannels() {
  diagnosticsChannel.subscribe('undici:request:create', recordUndiciRequest);
  diagnosticsChannel.subscribe('http.client.request.created', recordHttpRequest);
  diagnosticsChannel.subscribe('http.client.request.start', recordHttpRequest);
}

// ---------------------------------------------------------------- workers

const SELF_URL = import.meta.url;
const SELF_PATH = fileURLToPath(SELF_URL);
const USE_STRICT = /^(\s*(['"])use strict\2;?[ \t]*\n?)/;

/** Eval source that loads the recorder first. Only CommonJS has `require`; ESM source already ran the preload. */
function withRecorderPrefix(source) {
  const prefix = `typeof require === 'function' && require(${JSON.stringify(SELF_PATH)});\n`;
  const directive = USE_STRICT.exec(source)?.[1];
  if (directive === undefined) return `${prefix}${source}`;
  const separator = directive.endsWith('\n') ? '' : '\n';
  return `${directive}${separator}${prefix}${source.slice(directive.length)}`;
}

/**
 * The arguments a worker is built with, so it loads the recorder too. Node
 * skips `--import` preloads in a worker built from CommonJS `eval` source, and
 * in one given its own `execArgv` without them.
 */
function recordedWorkerArguments(source, options) {
  const isCommonJsEval = options?.eval === true && typeof source === 'string';
  const recordedSource = isCommonJsEval ? withRecorderPrefix(source) : source;
  const hasOwnExecArgv = Array.isArray(options?.execArgv) && !options.execArgv.includes(SELF_URL);
  const recordedOptions = hasOwnExecArgv ? { ...options, execArgv: [...options.execArgv, '--import', SELF_URL] } : options;
  return [recordedSource, recordedOptions];
}

function installWorkerHook() {
  const Original = workerThreads.Worker;
  class RecordedWorker extends Original {
    constructor(source, options) {
      super(...recordedWorkerArguments(source, options));
    }
  }
  Object.defineProperty(RecordedWorker, 'name', { value: Original.name });
  workerThreads.Worker = RecordedWorker;
}

// ---------------------------------------------------------------- install

function install() {
  if (globalThis[INSTALLED]) return;
  globalThis[INSTALLED] = true;
  installSocketHook();
  installDnsHooks();
  installRequestChannels();
  installWorkerHook();
  // `import { lookup } from 'node:dns'` and `import { Worker } from
  // 'node:worker_threads'` read the patched exports too.
  syncBuiltinESMExports();
  record({ kind: 'start', via: 'node-egress' });
}

install();
