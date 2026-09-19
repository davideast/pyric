import { connectRemoteSandbox } from '../../../dist/remote/index.js';

const [url, role = 'editor'] = process.argv.slice(2);
const hasNoUrl = url === undefined;
if (hasNoUrl) throw new Error('Usage: node set-claims.mjs <serve-url> [editor|viewer]');
const control = await connectRemoteSandbox({ url });
try {
  await control.auth.updateUser('red-user', { customClaims: { role } });
  console.log(`red-user role is now ${role}; click Refresh token in its browser.`);
} finally {
  control.close();
}
