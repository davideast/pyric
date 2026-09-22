/**
 * Dynamic Target Router for in-process MCP server (ADR 0016).
 *
 * Before dispatching a tool call, the server resolves the project's host pointer.
 * If `.pyric/serve.json` names a live Node host for this project, the call runs there
 * through `callHostedMethod`. Otherwise it runs on the local in-process sandbox.
 *
 * - Pointer check is cached for 1 second.
 * - Stale pointer failures fall back to local on the NEXT call.
 * - Transitions are announced once per direction.
 * - `_pyric.target` is stamped on all MCP results ('host' | 'in-process').
 * - `--in-process` suppresses host discovery.
 */

import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { discoverServe, healthyBase, canonicalServeUrl, type Discovered } from '../../serve/discovery.js';
import { callHostedMethod } from '../../cli/hosted-method.js';
import { markDenial, thrownFailure } from '../surface/rules-verdict.js';
import type { Args, Method } from '../surface/method-types.js';
import type { OperationResult, SurfaceContext } from '../surface/types.js';

export const HOST_STARTED_NOTICE =
  'A sandbox host started for this project. Calls now run on it. Data written to the in-process sandbox earlier in this session is in .pyric/state/in-process.json and is not on the host.';

export const HOST_STOPPED_NOTICE =
  'The sandbox host stopped. Calls now run on the local in-process sandbox.';

function safeRealPath(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
}

export interface TargetRouterOptions {
  projectDir: string;
  inProcessOnly?: boolean;
  allowProduction?: boolean;
  cacheTtlMs?: number;
  discover?: typeof discoverServe;
  callHosted?: typeof callHostedMethod;
}

export class TargetRouter {
  readonly projectDir: string;
  readonly inProcessOnly: boolean;
  readonly allowProduction: boolean;
  readonly cacheTtlMs: number;
  private readonly customDiscover?: typeof discoverServe;
  private readonly customCallHosted?: typeof callHostedMethod;

  private lastCheckMs = 0;
  private cachedHost: Discovered | null = null;
  private lastTarget: 'host' | 'in-process' = 'in-process';

  constructor(options: TargetRouterOptions) {
    this.projectDir = options.projectDir;
    this.inProcessOnly = options.inProcessOnly ?? false;
    this.allowProduction = options.allowProduction ?? false;
    this.cacheTtlMs = options.cacheTtlMs ?? 1000;
    this.customDiscover = options.discover;
    this.customCallHosted = options.callHosted;
  }

  getCurrentTarget(): 'host' | 'in-process' {
    return this.lastTarget;
  }

  async resolveHost(): Promise<Discovered | null> {
    if (this.inProcessOnly) return null;
    const now = Date.now();
    if (now - this.lastCheckMs < this.cacheTtlMs && this.cachedHost !== undefined) {
      return this.cachedHost;
    }
    this.lastCheckMs = now;

    try {
      if (this.customDiscover) {
        const found = await this.customDiscover(this.projectDir);
        if (found && found.source.startsWith('pointer')) {
          const canonicalProjectDir = safeRealPath(this.projectDir);
          const pointerProjectDir = found.pointerProjectDir
            ? safeRealPath(found.pointerProjectDir)
            : canonicalProjectDir;
          if (pointerProjectDir === canonicalProjectDir) {
            this.cachedHost = found;
            return found;
          }
        }
        this.cachedHost = null;
        return null;
      }

      const canonicalProjectDir = safeRealPath(this.projectDir);
      const pointerPath = join(canonicalProjectDir, '.pyric', 'serve.json');
      if (!existsSync(pointerPath)) {
        this.cachedHost = null;
        return null;
      }

      const raw = JSON.parse(readFileSync(pointerPath, 'utf8')) as {
        port?: number;
        url?: string;
        mcpUrl?: string;
        instanceId?: string;
      };

      const port =
        raw.port ??
        (raw.mcpUrl ? Number(raw.mcpUrl.match(/:(\d{2,5})(?:\/|$)/)?.[1]) : null) ??
        (raw.url ? Number(raw.url.match(/:(\d{2,5})(?:\/|$)/)?.[1]) : null);

      if (!port) {
        this.cachedHost = null;
        return null;
      }

      const expectedId =
        typeof raw.instanceId === 'string' && raw.instanceId ? raw.instanceId : null;
      const hit = await healthyBase(port, expectedId);
      if (!hit) {
        this.cachedHost = null;
        return null;
      }

      this.cachedHost = {
        pointerProjectDir: canonicalProjectDir,
        mcpUrl: `${hit.base}/__pyric/mcp`,
        url: canonicalServeUrl(port, raw.url),
        base: hit.base,
        instanceId: hit.instanceId,
        source: `pointer ${pointerPath}`,
      };
      return this.cachedHost;
    } catch {
      this.cachedHost = null;
      return null;
    }
  }

  async dispatch(
    method: Method,
    args: Args,
    ctx: SurfaceContext,
    allowProduction: boolean,
  ): Promise<OperationResult> {
    const host = await this.resolveHost();
    let currentTarget: 'host' | 'in-process' = 'in-process';
    let result: OperationResult;

    if (host !== null) {
      try {
        const hosted = await (this.customCallHosted ?? callHostedMethod)(
          host,
          method.key,
          args,
          ctx.projectDir,
          allowProduction,
        );
        if (hosted !== null) {
          currentTarget = 'host';
          result = hosted;
        } else {
          // Scope: Node host only. SharedWorker host refused (returned 404). Fall back to local.
          currentTarget = 'in-process';
          result = await this.executeLocal(method, args, ctx);
        }
      } catch (err) {
        // Failed call to host (e.g. host died mid-session, stale pointer).
        // "a failed call to a pointer that has gone stale falls back to local on the next call, not the current one."
        currentTarget = 'host';
        this.cachedHost = null;
        this.lastCheckMs = 0;
        result = { ok: false, summary: thrownFailure(err).summary };
      }
    } else {
      currentTarget = 'in-process';
      result = await this.executeLocal(method, args, ctx);
    }

    if (currentTarget !== this.lastTarget) {
      const notice = currentTarget === 'host' ? HOST_STARTED_NOTICE : HOST_STOPPED_NOTICE;
      result = {
        ...result,
        summary: result.summary ? `${notice}\n\n${result.summary}` : notice,
      };
      this.lastTarget = currentTarget;
    }

    return result;
  }

  private async executeLocal(
    method: Method,
    args: Args,
    ctx: SurfaceContext,
  ): Promise<OperationResult> {
    try {
      return markDenial(method.tool, await method.handler(args, ctx));
    } catch (error) {
      return markDenial(method.tool, thrownFailure(error));
    }
  }
}
