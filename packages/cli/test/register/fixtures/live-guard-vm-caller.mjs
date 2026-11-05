// Under Node: a `tls.connect` to a passed-through host from a function built
// with `node:vm`, run as a stand-in SDK file's callback. Node names such a
// frame `evalmachine.<anonymous>`, or the `filename` it was given, with
// `isEval()` false. Prints each outcome as JSON.
// Usage: node live-guard-vm-caller.mjs <live-net-guard.js URL> <stand-in SDK URL>
import vm from 'node:vm';

const [guardUrl, sdkUrl] = process.argv.slice(2);
const { installLiveNetGuard } = await import(guardUrl);
const sdk = await import(sdkUrl);

const HOST = 'demo-default-rtdb.firebaseio.com';
const sent = [];
const tls = { connect: () => { sent.push('tls.connect'); return {}; } };
const hooks = installLiveNetGuard({
  isLiveSdkFile: (url) => url === sdkUrl,
  passThrough: ['firebase/database'],
  scope: { [Symbol.for('undici.globalDispatcher.1')]: { dispatch: () => true } },
  env: {},
  write: () => {},
  net: { connect: () => ({}), createConnection: () => ({}) },
  tls,
  fetchScope: { fetch: async () => new Response('') },
  agentPrototypes: [],
  socketPrototypes: [],
  requestPrototypes: [],
  liveAgentPrototypes: [],
});

function outcome(connect) {
  try {
    connect();
    return 'connected';
  } catch (error) {
    return error.code;
  }
}

// The vm code hands back the callback itself, so the SDK file calls a vm
// frame directly. Never in tail position, so that frame stays on the stack.
const source = '(tls, host) => () => { const sockets = [tls.connect({ host, port: 443 })]; return sockets[0]; }';
const madeBy = (filename) => vm.runInThisContext(source, filename === undefined ? undefined : { filename });

const result = {
  fromSdk: outcome(() => sdk.sdkConnect(tls, HOST)),
  vmDefault: outcome(() => sdk.sdkCallback(madeBy(undefined)(tls, HOST))),
  vmEmptyName: outcome(() => sdk.sdkCallback(madeBy('')(tls, HOST))),
  vmNamed: outcome(() => sdk.sdkCallback(madeBy('database-sdk')(tls, HOST))),
  vmNodeName: outcome(() => sdk.sdkCallback(madeBy('node:database')(tls, HOST))),
  sent,
};
hooks.stop();
process.stdout.write(`${JSON.stringify(result)}\n`);
