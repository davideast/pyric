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
import { join } from 'node:path';
import { boundedRequest } from '../../bounded-request.js';
import { discoverServe, healthyBase, canonicalServeUrl, type Discovered } from '../../serve/discovery.js';
import {
  fetchLoopbackTarget,
  inProcessSessionTokenForPort,
  probeHttpsHostUrl,
  resolveSessionTokenForTarget,
} from '../../serve/local-session-token.js';
import { callHostedMethod } from '../../cli/hosted-method.js';
import { CALLER_IDENTITY_ARG, type IdentityInput } from '../surface/identity.js';
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

async function probeHostMode(
  base: string,
  token: string | undefined,
  cwd: string,
): Promise<'sandbox' | 'live'> {
  try {
    const headers: Record<string, string> = { accept: 'application/json' };
    if (token !== undefined) headers['x-pyric-session-token'] = token;
    const healthUrl = `${base.replace(/\/$/, '')}/__pyric/health`;
    let body: { mode?: unknown; live?: unknown } | null = null;
    if (healthUrl.startsWith('https://')) {
      const response = await fetchLoopbackTarget(
        healthUrl,
        { headers, signal: AbortSignal.timeout(1_000) },
        cwd,
      );
      if (!response.ok) return 'sandbox';
      body = (await response.json()) as { mode?: unknown; live?: unknown } | null;
    } else {
      const response = await boundedRequest(healthUrl, {
        headers,
        deadlineMs: 1_000,
      });
      if (response === null || response.status !== 200) return 'sandbox';
      body = JSON.parse(response.body.toString('utf8')) as { mode?: unknown; live?: unknown } | null;
    }
    if (body !== null && typeof body === 'object') {
      if (body.mode === 'live') return 'live';
      if (typeof body.live === 'object' && body.live !== null) return 'live';
    }
  } catch {
    // Fall back to sandbox mode if health cannot be parsed.
  }
  return 'sandbox';
}

async function probeHttpsTargetBase(
  rawUrl: string,
  port: number,
  expectedId: string | null,
  cwd: string,
): Promise<{ base: string; instanceId: string | null } | null> {
  const hit = await probeHttpsHostUrl(rawUrl, cwd);
  if (hit !== null && (expectedId === null || hit.instanceId === null || hit.instanceId === expectedId)) {
    return hit;
  }
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return null;
  }
  if (parsed.protocol !== 'https:') return null;
  const candidates = [...new Set([`https://127.0.0.1:${port}`, `https://[::1]:${port}`, parsed.origin])];
  for (const base of candidates) {
    const token = resolveSessionTokenForTarget({ url: base, port, cwd });
    try {
      const res = await fetchLoopbackTarget(
        `${base}/__pyric/health`,
        {
          headers: {
            accept: 'application/json',
            ...(token !== undefined ? { 'x-pyric-session-token': token } : {}),
          },
          signal: AbortSignal.timeout(1_000),
        },
        cwd,
      );
      if (!res.ok) continue;
      const body = (await res.json()) as { mode?: unknown; instanceId?: unknown } | null;
      if (body?.mode !== 'sandbox' && body?.mode !== 'live') continue;
      const id = typeof body.instanceId === 'string' ? body.instanceId : null;
      if (expectedId !== null && id !== null && id !== expectedId) continue;
      return { base: base.replace(/\/$/, ''), instanceId: id };
    } catch {
      // Try next loopback candidate.
    }
  }
  return null;
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
  private cachedHostMode: 'sandbox' | 'live' = 'sandbox';
  private lastTarget: 'host' | 'in-process' = 'in-process';
  private lastHostMode: 'sandbox' | 'live' = 'sandbox';
  private lastInstanceId: string | null = null;

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

  getCurrentMode(): 'sandbox' | 'live' {
    return this.lastTarget === 'host' ? this.lastHostMode : 'sandbox';
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
            this.cachedHostMode = this.customCallHosted
              ? 'sandbox'
              : await probeHostMode(found.base, found.token, canonicalProjectDir);
            return found;
          }
        }
        this.cachedHost = null;
        this.cachedHostMode = 'sandbox';
        return null;
      }

      const canonicalProjectDir = safeRealPath(this.projectDir);
      const pointerPath = join(canonicalProjectDir, '.pyric', 'serve.json');
      if (!existsSync(pointerPath)) {
        this.cachedHost = null;
        this.cachedHostMode = 'sandbox';
        return null;
      }

      const raw = JSON.parse(readFileSync(pointerPath, 'utf8')) as {
        port?: number;
        url?: string;
        mcpUrl?: string;
        instanceId?: string;
        token?: string;
      };

      const port =
        raw.port ??
        (raw.mcpUrl ? Number(raw.mcpUrl.match(/:(\d{2,5})(?:\/|$)/)?.[1]) : null) ??
        (raw.url ? Number(raw.url.match(/:(\d{2,5})(?:\/|$)/)?.[1]) : null);

      if (!port) {
        this.cachedHost = null;
        this.cachedHostMode = 'sandbox';
        return null;
      }

      const expectedId =
        typeof raw.instanceId === 'string' && raw.instanceId ? raw.instanceId : null;
      const isHttpsPointer = typeof raw.url === 'string' && raw.url.startsWith('https://');
      let hit: { base: string; instanceId: string | null } | null = isHttpsPointer
        ? await probeHttpsTargetBase(raw.url!, port, expectedId, canonicalProjectDir)
        : null;
      if (!hit) {
        hit = await healthyBase(port, expectedId);
      }
      if (!hit) {
        this.cachedHost = null;
        this.cachedHostMode = 'sandbox';
        return null;
      }

      const token =
        (typeof raw.token === 'string' && raw.token.length > 0 ? raw.token : undefined) ??
        inProcessSessionTokenForPort(port) ??
        resolveSessionTokenForTarget({ url: hit.base, port, cwd: canonicalProjectDir });
      this.cachedHostMode = await probeHostMode(hit.base, token, canonicalProjectDir);
      this.cachedHost = {
        pointerProjectDir: canonicalProjectDir,
        mcpUrl: `${hit.base}/__pyric/mcp`,
        url: canonicalServeUrl(port, raw.url),
        base: hit.base,
        instanceId: hit.instanceId,
        ...(token !== undefined ? { token } : {}),
        source: `pointer ${pointerPath}`,
      };
      return this.cachedHost;
    } catch {
      this.cachedHost = null;
      this.cachedHostMode = 'sandbox';
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
      const rawOverride = ctx.callIdentityOverride;
      const heldRaw = ctx.identity.rawInput();
      const effectiveIdentity = rawOverride ?? heldRaw;
      const forwardsIdentity =
        method.operation !== 'switch_auth_identity' &&
        (rawOverride !== undefined || effectiveIdentity.mode !== 'default');
      const wireArgs: Args = forwardsIdentity
        ? { ...args, [CALLER_IDENTITY_ARG]: effectiveIdentity }
        : args;
      try {
        const hosted = await (this.customCallHosted ?? callHostedMethod)(
          host,
          method.key,
          wireArgs,
          ctx.projectDir,
          allowProduction,
        );
        if (hosted !== null) {
          currentTarget = 'host';
          this.lastHostMode = this.cachedHostMode;
          this.lastInstanceId = host.instanceId;
          if (method.operation === 'switch_auth_identity' && hosted.ok) {
            this.syncLocalIdentityFromSwitch(method, args, hosted, ctx);
          }
          result = hosted;
        } else {
          // Scope: Node host only. SharedWorker host refused (returned 404). Fall back to local.
          currentTarget = 'in-process';
          this.lastHostMode = 'sandbox';
          this.lastInstanceId = null;
          result = await this.executeLocal(method, args, ctx);
        }
      } catch (err) {
        // Failed call to host (e.g. host died mid-session, stale pointer).
        // "a failed call to a pointer that has gone stale falls back to local on the next call, not the current one."
        currentTarget = 'host';
        this.cachedHost = null;
        this.cachedHostMode = 'sandbox';
        this.lastCheckMs = 0;
        result = { ok: false, summary: thrownFailure(err).summary };
      }
    } else {
      currentTarget = 'in-process';
      this.lastHostMode = 'sandbox';
      this.lastInstanceId = null;
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

  private syncLocalIdentityFromSwitch(
    method: Method,
    args: Args,
    hosted: OperationResult,
    ctx: SurfaceContext,
  ): void {
    try {
      if (method.key === 'auth.impersonate' && typeof args.uid === 'string' && args.uid.length > 0) {
        const input: IdentityInput = { mode: 'uid', uid: args.uid };
        if (typeof args.tenant === 'string') input.tenant = args.tenant;
        if (args.claims !== null && typeof args.claims === 'object' && !Array.isArray(args.claims)) {
          input.claims = { ...(args.claims as Record<string, unknown>) };
        }
        ctx.identity.switchTo(input);
        return;
      }
      const next = (hosted.data as { identity?: IdentityInput } | undefined)?.identity;
      if (next && typeof next.mode === 'string') {
        ctx.identity.switchTo(next);
      }
    } catch {
      // Keep local identity intact if hosted response payload is non-standard.
    }
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
