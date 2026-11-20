/**
 * App Check wire operation messages for native and remote bridge clients.
 */
export type AppCheckOpMessage =
  | {
      t: 'op';
      id: string;
      method: 'appCheck.getToken';
      appId?: string;
      projectId?: string;
      provider?: string;
      forceRefresh?: boolean;
    }
  | {
      t: 'op';
      id: string;
      method: 'appCheck.getLimitedUseToken';
      appId?: string;
      projectId?: string;
      provider?: string;
    };
