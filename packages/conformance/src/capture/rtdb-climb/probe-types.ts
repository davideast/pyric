import type { FirebaseOptions } from 'firebase/app';
import type { Auth } from 'firebase/auth';
import type { Database } from 'firebase/database';
import type { RateLimitDeps } from '../../rtdb-rules-rate-limit.ts';

export interface RtdbClimbProbe {
  name: string;
  matrixRow: string;
  rowIds: string[];
  description: string;
  observe(): Promise<Record<string, unknown>>;
}

export interface RtdbClimbContext {
  config: FirebaseOptions & { projectId: string; databaseURL: string };
  rtdbAdminToken: string;
  runId: string;
  /** Replaces the rules endpoint's fetch and back-off sleep; tests supply a fake endpoint. */
  rulesRateLimitDeps?: Partial<RateLimitDeps>;
}

export interface RtdbClimbClient {
  db: Database;
  auth: Auth;
  authToken: string;
  close(): Promise<void>;
}
