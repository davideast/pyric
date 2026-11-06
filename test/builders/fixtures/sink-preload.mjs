// A safety net for the recorder's own tests. Loaded with --import BEFORE the
// recorder, so the recorder wraps it and still sees each host as the probe
// wrote it. Whatever the recorder lets through is sent to a local sink that
// closes it at once, and every name resolves to 127.0.0.1, so no probe leaves
// the machine whether or not the recorder refuses it. Each escape is printed
// as `SINK ESCAPED <host>` on stderr.
import dns from 'node:dns';
import net from 'node:net';
import { syncBuiltinESMExports } from 'node:module';

const LOOPBACK = new Set(['127.0.0.1', 'localhost', '::1']);

const sink = net.createServer((socket) => socket.destroy());
await new Promise((resolve) => sink.listen(0, '127.0.0.1', resolve));
sink.unref();
const SINK_PORT = sink.address().port;

const escaped = (host) => process.stderr.write(`SINK ESCAPED ${host}\n`);
const isPort = (value) => typeof value === 'number' || (typeof value === 'string' && /^\d+$/.test(value));

const originalConnect = net.Socket.prototype.connect;
net.Socket.prototype.connect = function (...args) {
  const list = Array.isArray(args[0]) ? args[0] : args;
  const first = list[0];
  const isIpc = typeof first === 'object' && first !== null && first.path !== undefined && first.port === undefined;
  if (typeof first === 'object' && first !== null && !isIpc) {
    const host = first.host ?? 'localhost';
    if (!LOOPBACK.has(host)) {
      escaped(host);
      list[0] = { ...first, host: '127.0.0.1', port: SINK_PORT, lookup: undefined };
    }
  } else if (isPort(first)) {
    const host = typeof list[1] === 'string' ? list[1] : 'localhost';
    if (!LOOPBACK.has(host)) {
      escaped(host);
      list[0] = SINK_PORT;
      list[1] = '127.0.0.1';
    }
  }
  return originalConnect.apply(this, args);
};

const localAnswer = (options, callback) => {
  if (options && options.all) callback(null, [{ address: '127.0.0.1', family: 4 }]);
  else callback(null, '127.0.0.1', 4);
};

dns.lookup = function (hostname, options, callback) {
  const done = typeof options === 'function' ? options : callback;
  if (!LOOPBACK.has(hostname)) escaped(hostname);
  process.nextTick(() => localAnswer(typeof options === 'object' ? options : {}, done));
};
dns.promises.lookup = async (hostname) => {
  if (!LOOPBACK.has(hostname)) escaped(hostname);
  return { address: '127.0.0.1', family: 4 };
};
dns.promises.resolve4 = async (hostname) => {
  escaped(hostname);
  return ['127.0.0.1'];
};
syncBuiltinESMExports();
