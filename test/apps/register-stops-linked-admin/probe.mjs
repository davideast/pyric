const specifier = process.argv[2] ?? 'firebase-admin/app';
try {
  const mod = await import(specifier);
  let status = 'real firebase-admin';
  if ('ADMIN_APP_TARGET' in mod) {
    status = 'swapped';
  }
  console.log(`OUTCOME ${JSON.stringify({ status, code: null, message: null })}`);
} catch (error) {
  let code = null;
  if (typeof error === 'object' && error !== null && 'code' in error && typeof error.code === 'string') {
    code = error.code;
  }
  let message = String(error);
  if (error instanceof Error) {
    message = error.message;
  }
  console.log(`OUTCOME ${JSON.stringify({ status: 'stopped', code, message })}`);
}
