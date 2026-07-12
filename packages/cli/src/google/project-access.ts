/** The credential value required by hosted verification. */
export interface ProjectAccess {
  readonly projectId: string;
  resolveToken(): Promise<string>;
}
