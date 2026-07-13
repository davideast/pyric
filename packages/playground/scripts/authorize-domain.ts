#!/usr/bin/env bun
/**
 * One-shot — add `pyric-playground.web.app` (and any extra origin
 * passed via `--domain=`) to the `blockingfun` Firebase project's
 * Auth authorized-domains list so Google sign-in popups + redirects
 * work without "auth/unauthorized-domain" errors.
 *
 * Drives the SDK's `ManageDomainsHandler` via the same service-
 * account flow the deploy script uses — no firebase CLI, no manual
 * console click-through.
 *
 * Pre-reqs:
 *   - `FIREBASE_SA_BASE64` env var = base64(service-account JSON)
 *     with `roles/firebaseauth.admin` on the target project.
 *
 * Usage:
 *   bun scripts/authorize-domain.ts
 *   bun scripts/authorize-domain.ts --domain=staging.example.com
 *   bun scripts/authorize-domain.ts --list   # just print current list
 */
import { fromServiceAccount } from '@pyric/cli/credentials/node';
import { ManageDomainsHandler } from '@pyric/cli/auth';

const DEFAULT_DOMAIN = 'pyric-playground.web.app';

const args = process.argv.slice(2);
const domainArg = args.find((a) => a.startsWith('--domain='));
const listOnly = args.includes('--list');
const domain = domainArg ? domainArg.slice('--domain='.length) : DEFAULT_DOMAIN;

const scope = await fromServiceAccount(process.env.FIREBASE_SA_BASE64 ?? '');
const handler = new ManageDomainsHandler();

if (listOnly) {
  const result = await handler.execute(scope, { action: 'list' });
  if (!result.success) {
    console.error(`List failed: ${result.error.code} — ${result.error.message}`);
    process.exit(1);
  }
  console.log('Current authorized domains:');
  for (const d of result.authorizedDomains) console.log(`  - ${d}`);
  process.exit(0);
}

const result = await handler.execute(scope, { action: 'add', domain });
if (!result.success) {
  console.error(`Add failed: ${result.error.code} — ${result.error.message}`);
  process.exit(1);
}

console.log('');
console.log(`  ✓ authorized:  ${domain}`);
console.log(`  ✓ full list:`);
for (const d of result.authorizedDomains) {
  console.log(`     - ${d}${d === domain ? '  (just added)' : ''}`);
}
if (result.warning) {
  console.log(`  ⚠ ${result.warning}`);
}
console.log('');
