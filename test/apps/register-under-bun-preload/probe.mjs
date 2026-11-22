const specifier = process.argv[2] ?? 'firebase-admin/app';
const mod = await import(specifier);
let kind = 'real firebase-admin';
if ('ADMIN_APP_TARGET' in mod) {
  kind = 'swapped';
}
const marked = globalThis[Symbol.for('pyric.register.active')] === true;
console.log(`PROBE ${JSON.stringify({ pid: process.pid, kind, marked })}`);
