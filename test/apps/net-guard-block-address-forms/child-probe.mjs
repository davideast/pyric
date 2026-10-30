// A child Node process that probes.mjs starts. It prints one JSON line naming
// which `firebase-admin/app` it got and the network guard it runs under. Each
// child gets ./safety.mjs on its own command line, so it stays on this machine
// with or without the register.
const name = process.argv[2];
let admin;
try {
  const app = await import('firebase-admin/app');
  admin = 'ADMIN_APP_TARGET' in app ? 'swapped' : 'real firebase-admin';
} catch (error) {
  admin = error.code === 'PYRIC_REAL_SDK_STOPPED' ? 'stopped' : (error.code ?? String(error));
}
const guard = globalThis[Symbol.for('pyric.netGuard')]?.mode ?? null;
console.log(JSON.stringify({ child: name, admin, guard }));
