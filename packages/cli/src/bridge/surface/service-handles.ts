/**
 * Service handles resolved under the surface's held identity.
 *
 * The Firestore data plane reaches the sandbox through the shared dispatcher,
 * which already resolves identity for it. Database and Storage have no
 * forwarded tool family, so their operations open a handle here, and the
 * identity decides whether that handle bypasses rules (admin and app-session)
 * or enforces them (a uid, or unauthenticated).
 */
import { getAdminDatabase, getDatabase, type Database } from 'pyric/database';
import { getStorageSandbox, type FirebaseStorage } from 'pyric/storage';
import { getAdminStorageSandbox } from 'pyric/storage/internal';
import type { SurfaceContext } from './types.js';

/** A Realtime Database handle for the held identity. */
export function databaseFor(ctx: SurfaceContext): Database {
  if (ctx.identity.bypassesRules()) return getAdminDatabase(ctx.sandbox);
  return getDatabase(ctx.sandbox.withAuth(ctx.identity.authState()));
}

/** A Cloud Storage handle for the held identity. */
export function storageFor(ctx: SurfaceContext): FirebaseStorage {
  if (ctx.identity.bypassesRules()) return getAdminStorageSandbox(ctx.sandbox);
  return getStorageSandbox(ctx.sandbox.withAuth(ctx.identity.authState()));
}

/** Bytes for a base64 payload. */
export function decodeBase64(contentBase64: string): Uint8Array {
  return new Uint8Array(Buffer.from(contentBase64, 'base64'));
}

/** Base64 for a byte payload. */
export function encodeBase64(bytes: ArrayBuffer): string {
  return Buffer.from(bytes).toString('base64');
}
