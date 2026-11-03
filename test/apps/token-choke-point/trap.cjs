'use strict';
// Loaded with --require in NODE_OPTIONS, which Node runs before the register's
// --import, so the guard wraps this patch and still sees each host as the
// probe wrote it. Any connection the guard lets through to a host other than
// loopback goes to a closed local port instead, and is recorded, so nothing
// in this scenario leaves the machine whether or not the guard refuses it.
const net = require('node:net');

const CLOSED_PORT = Number(process.env.SCENARIO_CLOSED_PORT);
const LOOPBACK = new Set(['127.0.0.1', 'localhost', '::1', '[::1]']);
const trapped = [];
globalThis[Symbol.for('scenario.trapped')] = trapped;

const isPort = (value) => typeof value === 'number' || (typeof value === 'string' && /^\d+$/.test(value));

const original = net.Socket.prototype.connect;
net.Socket.prototype.connect = function (...args) {
  // net.connect hands the socket its arguments as one normalized array.
  const list = Array.isArray(args[0]) ? args[0] : args;
  const first = list[0];
  // An http.Agent's options carry the request `path` beside a TCP port; only a
  // `path` with no port is a local IPC socket.
  const isIpc = typeof first === 'object' && first !== null && first.path !== undefined && first.port === undefined;
  if (typeof first === 'object' && first !== null && !isIpc) {
    const host = first.host ?? 'localhost';
    if (!LOOPBACK.has(host)) {
      trapped.push(host);
      list[0] = { ...first, host: '127.0.0.1', port: CLOSED_PORT, lookup: undefined };
    }
  } else if (isPort(first)) {
    const host = typeof list[1] === 'string' ? list[1] : 'localhost';
    if (!LOOPBACK.has(host)) {
      trapped.push(host);
      list[0] = CLOSED_PORT;
      list[1] = '127.0.0.1';
    }
  }
  return original.apply(this, args);
};
