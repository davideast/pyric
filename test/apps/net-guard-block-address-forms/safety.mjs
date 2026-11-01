// Loaded with --import BEFORE @pyric/cli/register, so the guard wraps this
// patch and still sees each host as the probe wrote it. Any connection the
// guard lets through to a host other than loopback is sent to a local sink
// that closes it at once, and recorded, so no probe leaves the machine whether
// or not the guard refuses it.
import net from 'node:net';

const LOOPBACK = new Set(['127.0.0.1', 'localhost', '::1']);
const escaped = [];
globalThis[Symbol.for('scenario.escaped')] = escaped;

const sink = net.createServer((socket) => socket.destroy());
await new Promise((resolve) => sink.listen(0, '127.0.0.1', resolve));
sink.unref();
const SINK_PORT = sink.address().port;

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
      escaped.push(host);
      list[0] = { ...first, host: '127.0.0.1', port: SINK_PORT, lookup: undefined };
    }
  } else if (isPort(first)) {
    const host = typeof list[1] === 'string' ? list[1] : 'localhost';
    if (!LOOPBACK.has(host)) {
      escaped.push(host);
      list[0] = SINK_PORT;
      list[1] = '127.0.0.1';
    }
  }
  return original.apply(this, args);
};
