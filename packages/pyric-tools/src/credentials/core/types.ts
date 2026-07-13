/**
 * Project identity plus a fresh-enough Google OAuth token resolver.
 *
 * The identity is stable for the lifetime of an operation while token
 * acquisition remains lazy so long-running commands can refresh credentials.
 */
export interface ProjectScope {
  readonly projectId: string;
  resolveToken(): Promise<string>;
}
