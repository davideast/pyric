if (process.env.PYRIC_SANDBOX !== undefined) {
  const adminApp = await import('firebase-admin/app');
  const swapped = adminApp.ADMIN_APP_TARGET === Symbol.for('pyric.admin.app.target');
  const registerActive = globalThis[Symbol.for('pyric.register.active')] === true;
  console.log(`PRELOAD_REPORT ${JSON.stringify({ kind: 'import', swapped, registerActive })}`);
}
export {};
