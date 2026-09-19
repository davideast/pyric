// Copy into an isolated installed consumer so all imports resolve its packages.
import assert from 'node:assert/strict';
import { connectRemoteSandbox } from '@pyric/cli/remote';

const url = process.argv[2];
const email = `compat-${crypto.randomUUID()}@example.test`;
const password = 'compatibility-fixture-password';
const first = await connectRemoteSandbox({ url });
try {
  await first.channel.op({ method: 'auth.createUser', email, password });
  await first.channel.op({ method: 'setDoc', path: 'shared/greeting', data: { message: 'Installed remote write' } });
} finally {
  first.close();
}
const second = await connectRemoteSandbox({ url });
try {
  await second.channel.op({ method: 'auth.signInEmail', email, password });
  const read = await second.channel.op({ method: 'getDoc', path: 'shared/greeting' });
  assert.equal(read.data.json, '{"message":"Installed remote write"}');
  const delivered = Promise.withResolvers();
  const deadline = setTimeout(() => delivered.reject(new Error('Listener did not deliver after reconnect')), 5000);
  const unsubscribe = second.channel.subscribe(
    { target: { __ref: 'doc', path: 'shared/greeting' } },
    snapshot => {
      const updated = snapshot.data?.json === '{"message":"Installed remote listener"}';
      if (updated) delivered.resolve();
    },
    delivered.reject,
  );
  try {
    await second.channel.op({ method: 'setDoc', path: 'shared/greeting', data: { message: 'Installed remote listener' } });
    await delivered.promise;
  } finally {
    clearTimeout(deadline);
    unsubscribe();
  }
  console.log('Auth, write, reconnect and listener passed');
} finally {
  second.close();
}
