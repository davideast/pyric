/**
 * Firebase Installation ID (FID) registration state and listener fan-out for
 * `register`, `unregister`, `onRegistered`, `onUnregistered`, and `deleteToken`
 * (`@firebase/messaging` >= 0.13.0 / `firebase` >= 12.19.0).
 */
import type { TokenRecord } from './persistence.js';
import { FID_SHAPE_RE, mintFid } from './tokens.js';

export type FidHandler = (fid: string) => void;

export interface FidMutationCallbacks {
  tokenRecords: Map<string, TokenRecord>;
  legacyRegistrations: Map<string, string>;
  onChanged: () => void;
  onEmit: (op: 'token_minted' | 'token_deleted', path: string, registrationId: string) => void;
}

export class FidRegistrationStore {
  /** registrationId -> installation FID (stable across register/unregister cycles). */
  private readonly installationFids = new Map<string, string>();
  /** registrationId -> currently registered FID. */
  private readonly activeFids = new Map<string, string>();
  private readonly registeredHandlers = new Map<FidHandler, string>();
  private readonly unregisteredHandlers = new Map<FidHandler, string>();

  clear(): void {
    this.installationFids.clear();
    this.activeFids.clear();
  }

  restoreToken(token: string, record: TokenRecord): boolean {
    if (!FID_SHAPE_RE.test(token)) {
      return false;
    }
    this.installationFids.set(record.registrationId, token);
    if (record.state === 'active') {
      this.activeFids.set(record.registrationId, token);
    }
    return true;
  }

  clearStoredFidMetadata(registrationId: string): void {
    this.activeFids.delete(registrationId);
  }

  private resolveInstallationFid(registrationId: string): string {
    const existing = this.installationFids.get(registrationId);
    if (existing !== undefined) {
      return existing;
    }
    const minted = mintFid();
    this.installationFids.set(registrationId, minted);
    return minted;
  }

  registerFor(
    registrationId: string,
    recipientId: string,
    hooks: FidMutationCallbacks,
  ): string {
    const fid = this.resolveInstallationFid(registrationId);
    // Upstream dbSetFidRegistration clears the local legacy token store entry.
    hooks.legacyRegistrations.delete(registrationId);
    const previousRecord = hooks.tokenRecords.get(fid);
    const shouldMintOrRefresh = previousRecord === undefined || previousRecord.state !== 'active';
    this.activeFids.set(registrationId, fid);
    hooks.tokenRecords.set(fid, { registrationId, recipientId, state: 'active' });
    if (shouldMintOrRefresh) {
      hooks.onChanged();
      hooks.onEmit('token_minted', fid, registrationId);
    }
    this.notify(this.registeredHandlers, recipientId, fid);
    return fid;
  }

  unregisterFor(
    registrationId: string,
    recipientId: string,
    hooks: FidMutationCallbacks,
  ): string {
    const storedFid = this.activeFids.get(registrationId);
    const fid = storedFid ?? this.resolveInstallationFid(registrationId);
    const record = hooks.tokenRecords.get(fid);
    const notifyRecipient = record?.recipientId ?? recipientId;
    this.activeFids.delete(registrationId);
    // Upstream unregister() also scrubs legacy token details from local storage.
    hooks.legacyRegistrations.delete(registrationId);
    hooks.tokenRecords.set(fid, {
      registrationId,
      recipientId: notifyRecipient,
      state: 'unregistered',
    });
    hooks.onChanged();
    hooks.onEmit('token_deleted', fid, registrationId);
    this.notify(this.unregisteredHandlers, notifyRecipient, fid);
    return fid;
  }

  revokeIfStored(
    registrationId: string,
    fallbackRecipientId: string,
    hooks: FidMutationCallbacks,
  ): boolean {
    const fid = this.activeFids.get(registrationId);
    if (fid === undefined) {
      return false;
    }
    this.activeFids.delete(registrationId);
    const record = hooks.tokenRecords.get(fid);
    const notifyRecipient = record?.recipientId ?? fallbackRecipientId;
    if (record !== undefined) {
      record.state = 'unregistered';
    }
    hooks.onChanged();
    hooks.onEmit('token_deleted', fid, registrationId);
    this.notify(this.unregisteredHandlers, notifyRecipient, fid);
    return true;
  }

  onRegistered(handler: FidHandler, recipientId: string): () => void {
    this.registeredHandlers.set(handler, recipientId);
    return () => {
      this.registeredHandlers.delete(handler);
    };
  }

  onUnregistered(handler: FidHandler, recipientId: string): () => void {
    this.unregisteredHandlers.set(handler, recipientId);
    return () => {
      this.unregisteredHandlers.delete(handler);
    };
  }

  private notify(map: Map<FidHandler, string>, recipientId: string, fid: string): void {
    for (const [handler, registeredRecipient] of [...map]) {
      if (registeredRecipient !== recipientId) {
        continue;
      }
      try {
        handler(fid);
      } catch (err) {
        // Consumer listener errors must not abort registration mutations.
        void err;
      }
    }
  }
}
