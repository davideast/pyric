/**
 * Browser-native git service built on `isomorphic-git` and the
 * OPFS-backed VFS. Public surface mirrors the high-level shape of
 * git's porcelain (`clone`, `add`, `commit`, `push`, `log`, `status`)
 * — internal isomorphic-git function calls are wired to our adapter.
 *
 * Authentication: `onAuth` callbacks read the GitHub PAT from
 * IndexedDB via {@link getStoredPAT}. Username is left as the token
 * itself with password `x-oauth-basic` — the legacy form GitHub still
 * accepts for PAT-based Basic auth.
 *
 * CORS: github.com does NOT serve `Access-Control-Allow-Origin` on
 * its smart-HTTP endpoints (info/refs, git-upload-pack, git-receive-pack)
 * for arbitrary browser origins. isomorphic-git ships an `http`
 * client that supports a `corsProxy` parameter; we default to the
 * public proxy `cors.isomorphic-git.org` run by the isomorphic-git
 * team. Users running a self-hosted proxy can override via the
 * `corsProxy` argument on the operation methods, which falls back
 * to the constant below.
 */
const DEFAULT_CORS_PROXY = 'https://cors.isomorphic-git.org';

import * as git from 'isomorphic-git';
import http from 'isomorphic-git/http/web';

import { getStoredPAT } from './github-auth';
import { ensureBufferPolyfill } from './buffer-polyfill';
import { getVFS, type OPFSAdapter } from '~/lib/vfs';

export interface GitProgress {
  phase: string;
  loaded: number;
  total: number;
}

export interface CloneOptions {
  url: string;
  dir: string;
  ref?: string;
  depth?: number;
  singleBranch?: boolean;
  onProgress?: (p: GitProgress) => void;
  /** Override the default CORS proxy. Pass an empty string to disable. */
  corsProxy?: string;
}

export interface CommitOptions {
  dir: string;
  message: string;
  authorName: string;
  authorEmail: string;
}

export interface PushOptions {
  dir: string;
  remote?: string;
  ref?: string;
  remoteRef?: string;
  onProgress?: (p: GitProgress) => void;
  /** Override the default CORS proxy. Pass an empty string to disable. */
  corsProxy?: string;
}

export interface LogEntry {
  oid: string;
  message: string;
  authorName: string;
  authorEmail: string;
  timestamp: number;
}

export interface StatusRow {
  filepath: string;
  /** Working-tree state vs HEAD vs index. Matches `isomorphic-git`'s tri-state matrix. */
  head: number;
  workdir: number;
  stage: number;
}

export class GitService {
  constructor(private readonly adapter: OPFSAdapter) {}

  private get fsArg(): { promises: OPFSAdapter['promises'] } {
    // isomorphic-git accepts either a callback-style or promise-style
    // fs. We expose the latter via { promises }.
    return { promises: this.adapter.promises };
  }

  private async onAuth(): Promise<{ username: string; password: string }> {
    const token = await getStoredPAT();
    if (!token) {
      throw new Error(
        'No GitHub personal access token configured. Add one in Settings → GitHub.',
      );
    }
    // GitHub accepts the PAT as the username with any non-empty
    // password for Basic auth on the git-http endpoints.
    return { username: token, password: 'x-oauth-basic' };
  }

  async clone(opts: CloneOptions): Promise<void> {
    ensureBufferPolyfill();
    const corsProxy = opts.corsProxy ?? DEFAULT_CORS_PROXY;
    try {
      await git.clone({
        fs: this.fsArg,
        http,
        dir: opts.dir,
        url: opts.url,
        ref: opts.ref,
        depth: opts.depth ?? 1,
        singleBranch: opts.singleBranch ?? true,
        onAuth: () => this.onAuth(),
        onProgress: opts.onProgress,
        ...(corsProxy ? { corsProxy } : {}),
      });
    } catch (err) {
      throw formatGitHttpError(err, 'clone');
    }
  }

  async listFiles(dir: string, ref?: string): Promise<string[]> {
    return git.listFiles({ fs: this.fsArg, dir, ref });
  }

  async readFile(dir: string, filepath: string): Promise<string> {
    const abs = joinDirPath(dir, filepath);
    const result = await this.adapter.promises.readFile(abs, 'utf8');
    return typeof result === 'string' ? result : new TextDecoder('utf-8').decode(result);
  }

  async writeFile(dir: string, filepath: string, content: string): Promise<void> {
    const abs = joinDirPath(dir, filepath);
    await this.adapter.promises.writeFile(abs, content);
  }

  /** Stage every modified, added, or deleted file (`git add -A` equivalent). */
  async stageAll(dir: string): Promise<void> {
    const matrix = await git.statusMatrix({ fs: this.fsArg, dir });
    for (const [filepath, , workdirStatus] of matrix) {
      if (workdirStatus === 0) {
        await git.remove({ fs: this.fsArg, dir, filepath });
      } else {
        await git.add({ fs: this.fsArg, dir, filepath });
      }
    }
  }

  async commit(opts: CommitOptions): Promise<string> {
    return git.commit({
      fs: this.fsArg,
      dir: opts.dir,
      message: opts.message,
      author: { name: opts.authorName, email: opts.authorEmail },
    });
  }

  async push(opts: PushOptions): Promise<git.PushResult> {
    ensureBufferPolyfill();
    const corsProxy = opts.corsProxy ?? DEFAULT_CORS_PROXY;
    try {
      return await git.push({
        fs: this.fsArg,
        http,
        dir: opts.dir,
        remote: opts.remote ?? 'origin',
        ref: opts.ref,
        remoteRef: opts.remoteRef,
        onAuth: () => this.onAuth(),
        onProgress: opts.onProgress,
        ...(corsProxy ? { corsProxy } : {}),
      });
    } catch (err) {
      throw formatGitHttpError(err, 'push');
    }
  }

  async log(dir: string, depth?: number): Promise<LogEntry[]> {
    const commits = await git.log({ fs: this.fsArg, dir, depth });
    return commits.map((c) => ({
      oid: c.oid,
      message: c.commit.message,
      authorName: c.commit.author.name,
      authorEmail: c.commit.author.email,
      timestamp: c.commit.author.timestamp * 1000,
    }));
  }

  async status(dir: string): Promise<StatusRow[]> {
    const matrix = await git.statusMatrix({ fs: this.fsArg, dir });
    return matrix.map(([filepath, head, workdir, stage]) => ({
      filepath,
      head,
      workdir,
      stage,
    }));
  }
}

function joinDirPath(dir: string, filepath: string): string {
  const base = dir.endsWith('/') ? dir.slice(0, -1) : dir;
  const rel = filepath.startsWith('/') ? filepath.slice(1) : filepath;
  return `${base}/${rel}`;
}

function formatGitHttpError(err: unknown, op: 'clone' | 'push'): Error {
  const raw = err instanceof Error ? err.message : String(err);
  if (/401|unauthorized/i.test(raw)) {
    return new Error(
      op === 'clone'
        ? 'GitHub rejected the clone (401). Private repos need a classic PAT with the repo scope, or a fine-grained token with Contents: Read on this repository. Re-save your token in Settings → GitHub.'
        : 'GitHub rejected the push (401). Check your PAT scopes in Settings → GitHub.',
    );
  }
  if (/403|forbidden/i.test(raw)) {
    return new Error(
      `GitHub rejected the ${op} (403). Your token may lack permission for this repository.`,
    );
  }
  return err instanceof Error ? err : new Error(raw);
}

let singleton: GitService | null = null;

export function getGitService(): GitService {
  if (!singleton) singleton = new GitService(getVFS());
  return singleton;
}
