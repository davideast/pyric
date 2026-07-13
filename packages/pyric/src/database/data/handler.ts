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
      switch (operation) {
        case 'get':
          return { success: true, data: await host.data.get(path, auth) };
        case 'set':
          await host.data.set(path, data, auth);
          return { success: true, data: null };
        case 'update':
          await host.data.update(path, data as Record<string, unknown>, auth);
          return { success: true, data: null };
        case 'push':
          return { success: true, data: await host.data.push(path, data, auth) };
        case 'remove':
          await host.data.remove(path, auth);
          return { success: true, data: null };
      }
    } catch (e) {
      // Preserve a transport's PERMISSION_DENIED signal before the
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
}
