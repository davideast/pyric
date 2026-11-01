// A worker thread's connect to a catalog host. Its DNS is answered with
// 127.0.0.1 and the port is closed, so a connect the guard permits fails
// locally.
const net = require('node:net');
const { parentPort } = require('node:worker_threads');

const lookup = (_host, options, callback) => {
  if (options && options.all) callback(null, [{ address: '127.0.0.1', family: 4 }]);
  else callback(null, '127.0.0.1', 4);
};

try {
  const socket = net.connect({ host: 'firestore.googleapis.com', port: Number(process.env.SCENARIO_CLOSED_PORT), lookup });
  socket.on('error', () => {});
  socket.destroy();
  parentPort.postMessage('permitted');
} catch (error) {
  parentPort.postMessage(error.code ?? String(error));
}
