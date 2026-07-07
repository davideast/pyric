export interface ProjectScope {
  readonly projectId: string;
  resolveToken(): Promise<string>;
}
