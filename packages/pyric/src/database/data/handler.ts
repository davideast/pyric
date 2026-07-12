import { get, set, update, push, remove, ref, type Database } from 'firebase/database';
import { getDatabaseWithUrl as getAdminDatabase } from 'firebase-admin/database';
import type { RtdbHost } from '../host.js';
import type { UserAuth } from '../types.js';
import type { DataOperation, DataResult } from './spec.js';

export class DataHandler {
  async execute(
    host: RtdbHost,
    operation: DataOperation,
    path: string,
    data?: unknown,
    auth?: UserAuth,
  ): Promise<DataResult> {
    try {
      if (auth) {
        return await this.executeAsUser(host, operation, path, data, auth);
      }
      return await this.executeAsAdmin(host, operation, path, data);
    } catch (e) {
      // Preserve PERMISSION_DENIED signal from firebase/database before the
      // generic READ_FAILED / WRITE_FAILED wrap loses it.
      //
      // Two shapes have been observed against the live RTDB (fb-js-sdk 12.13.0):
      //   - set/get/remove: plain Error with `.code === 'PERMISSION_DENIED'`
      //     and `.message === 'PERMISSION_DENIED: Permission denied'`
      //     (oracle: packages/conformance/observations/rtdb/rtdb-rules-denied-error-code.json)
      //   - runTransaction: plain Error with `.message === 'permission_denied'`
      //     (lowercase) and NO `.code` field
      //     (oracle: packages/conformance/observations/rtdb-modular/rtdb-modular-runtransaction-on-rules-denied-path.json)
      //
      // The lowercase message check catches both — the uppercase set/get path
      // also matches via the message (its message starts with 'PERMISSION_DENIED'),
      // but we check `.code` first because it's the more reliable signal.
      const message = e instanceof Error ? e.message : String(e);
      const errCode = (e as { code?: unknown } | null)?.code;
      const isPermissionDenied =
        errCode === 'PERMISSION_DENIED' ||
        message.toLowerCase().includes('permission_denied');
      if (isPermissionDenied) {
        return {
          success: false,
          error: { code: 'PERMISSION_DENIED', message, recoverable: false },
        };
      }
      const code = operation === 'get' ? 'READ_FAILED' : 'WRITE_FAILED';
      return {
        success: false,
        error: { code, message, recoverable: false },
      };
    }
  }

  private async executeAsUser(
    host: RtdbHost,
    operation: DataOperation,
    path: string,
    data: unknown,
    auth: UserAuth,
  ): Promise<DataResult> {
    const db = await host.getClientForUser(auth);
    const dbRef = ref(db, path);

    switch (operation) {
      case 'get': {
        const snap = await get(dbRef);
        return { success: true, data: snap.val() };
      }
      case 'set': {
        await set(dbRef, data);
        return { success: true, data: null };
      }
      case 'update': {
        await update(dbRef, data as Record<string, unknown>);
        return { success: true, data: null };
      }
      case 'push': {
        const newRef = await push(dbRef, data);
        return { success: true, data: { key: newRef.key } };
      }
      case 'remove': {
        await remove(dbRef);
        return { success: true, data: null };
      }
    }
  }

  private async executeAsAdmin(
    host: RtdbHost,
    operation: DataOperation,
    path: string,
    data?: unknown,
  ): Promise<DataResult> {
    const db = getAdminDatabase(host.databaseUrl);
    const dbRef = db.ref(path);

    switch (operation) {
      case 'get': {
        const snap = await dbRef.get();
        return { success: true, data: snap.val() };
      }
      case 'set': {
        await dbRef.set(data);
        return { success: true, data: null };
      }
      case 'update': {
        await dbRef.update(data as Record<string, unknown>);
        return { success: true, data: null };
      }
      case 'push': {
        const newRef = await dbRef.push(data);
        return { success: true, data: { key: newRef.key } };
      }
      case 'remove': {
        await dbRef.remove();
        return { success: true, data: null };
      }
    }
  }
}
