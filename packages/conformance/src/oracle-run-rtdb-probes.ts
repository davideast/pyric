/**
 * RTDB probe lazy builders, interrupt-guarded in-probe rules rewrites, and
 * inert preview printer extracted from `run.ts` so `run.ts` shrinks cleanly.
 */
import { loadRtdbClimbProbes } from './capture/rtdb-climb/load-probes.ts';
import { createRtdbDisconnectProbes } from './capture/rtdb-disconnect/probes.ts';
import { formatInertPreviewFooter, stripCaptureFlags } from './capture-mode-guard.ts';
import type { OracleServiceAccount } from './oracle-credential.ts';
import type { OracleRulesSession } from './oracle-rules-session.ts';
import type { OracleWebConfig } from './oracle-run-setup.ts';
import { ORACLE_RESTORE_ATTEMPTS } from './oracle-signal-restore.ts';

interface RunProbeRecord {
  name: string;
  matrixRow: string;
  rowIds: string[];
  description: string;
  observe(): Promise<Record<string, unknown>>;
}

const INERT_PREVIEW_WEB_CONFIG: OracleWebConfig = {
  apiKey: 'inert-preview-key',
  authDomain: 'inert-preview.firebaseapp.com',
  projectId: 'inert-preview',
};

export async function buildLazyRtdbRunProbes(options: {
  runId: string;
  getLiveState: () => {
    config: OracleWebConfig;
    serviceAccount: OracleServiceAccount | null;
    rtdbAdminToken: string | null;
    rulesSession?: OracleRulesSession | null;
  };
}): Promise<RunProbeRecord[]> {
  const placeholderCtx = {
    config: { ...INERT_PREVIEW_WEB_CONFIG, databaseURL: 'https://inert-preview-rtdb.firebaseio.com' },
    rtdbAdminToken: 'inert-preview-token',
    runId: options.runId,
  };
  const climbTemplates = await loadRtdbClimbProbes(placeholderCtx);
  const disconnectTemplates = createRtdbDisconnectProbes({
    ...placeholderCtx,
    serviceAccount: {
      kind: 'application-default',
      project_id: INERT_PREVIEW_WEB_CONFIG.projectId,
      client_email: 'inert@inert-preview.iam.gserviceaccount.com',
      credential: { getAccessToken: async () => ({ access_token: '', expires_in: 0 }) },
    },
  });

  const climbProbes: RunProbeRecord[] = climbTemplates.map((template) => ({
    name: template.name,
    matrixRow: template.matrixRow,
    rowIds: template.rowIds,
    description: template.description,
    async observe() {
      const { config, serviceAccount, rtdbAdminToken, rulesSession } = options.getLiveState();
      if (!config.databaseURL || !rtdbAdminToken) {
        return {
          skipped: true,
          reason: 'dedicated oracle RTDB instance or RTDB admin token unavailable',
        };
      }
      const liveList = await loadRtdbClimbProbes({
        config: { ...config, databaseURL: config.databaseURL },
        rtdbAdminToken,
        runId: options.runId,
        serviceAccount,
        rulesSession,
      });
      const live = liveList.find((item) => item.name === template.name);
      if (!live) throw new Error(`missing RTDB climb probe '${template.name}'`);
      return live.observe();
    },
  }));

  const disconnectProbes: RunProbeRecord[] = disconnectTemplates.map((template) => ({
    name: template.name,
    matrixRow: template.matrixRow,
    rowIds: template.rowIds,
    description: template.description,
    async observe() {
      const { config, serviceAccount, rtdbAdminToken, rulesSession } = options.getLiveState();
      if (!config.databaseURL || !serviceAccount || !rtdbAdminToken) {
        return {
          skipped: true,
          reason: 'dedicated oracle RTDB instance, oracle credential, or RTDB admin token unavailable',
        };
      }
      const liveList = createRtdbDisconnectProbes({
        config: { ...config, databaseURL: config.databaseURL },
        serviceAccount,
        rtdbAdminToken,
        runId: options.runId,
        rulesSession,
      });
      const live = liveList.find((item) => item.name === template.name);
      if (!live) throw new Error(`missing RTDB disconnect probe '${template.name}'`);
      return live.observe();
    },
  }));

  return [...climbProbes, ...disconnectProbes];
}

function canonicalRulesJson(text: string): string {
  const withoutComments = text.replace(/^\s*\/\/.*$/gm, '');
  return JSON.stringify(JSON.parse(withoutComments));
}

export async function withGuardedProbeRtdbRules<T>(options: {
  session: OracleRulesSession | null;
  putUrl: string;
  readUrl?: string;
  beforeRules: Record<string, unknown>;
  nextRulesBody: Record<string, unknown>;
  fetchFn?: typeof fetch;
  body: (putRes: Response) => Promise<T>;
}): Promise<{ result: T; restoreOk: boolean; restoreStatus: number }> {
  const sendFetch = options.fetchFn ?? fetch;
  const track = <V>(promise: Promise<V>): Promise<V> => {
    if (options.session) {
      return options.session.trackMutation(promise);
    }
    return promise;
  };

  const beforeBodyText = JSON.stringify({ rules: options.beforeRules });
  const beforeCanonical = canonicalRulesJson(beforeBodyText);
  let deployAttempted = false;
  let restorePromise: Promise<void> | null = null;
  let restoreOk = false;
  let restoreStatus = 0;

  const restoreOnce = async (): Promise<void> => {
    if (!deployAttempted) return;
    if (restorePromise !== null) {
      return restorePromise;
    }
    restorePromise = (async () => {
      for (let attempt = 1; attempt <= ORACLE_RESTORE_ATTEMPTS; attempt += 1) {
        const isLast = attempt === ORACLE_RESTORE_ATTEMPTS;
        const res = await track(
          sendFetch(options.putUrl, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: beforeBodyText,
          }),
        );
        restoreOk = res.ok;
        restoreStatus = res.status;
        if (!res.ok) {
          if (isLast) {
            throw new Error(`probe RTDB rules restore failed (${res.status}): ${await res.text()}`);
          }
          continue;
        }
        if (!options.readUrl) {
          return;
        }
        const checkRes = await sendFetch(options.readUrl);
        if (checkRes.ok) {
          const checkText = await checkRes.text();
          if (canonicalRulesJson(checkText) === beforeCanonical) {
            return;
          }
        }
        if (isLast) {
          throw new Error('probe RTDB rules read-back did not match pre-probe rules');
        }
      }
    })();
    return restorePromise;
  };

  let unregister: () => void = () => undefined;
  if (options.session) {
    unregister = options.session.registerProbeCleanup(restoreOnce);
  }

  let result: T;
  try {
    deployAttempted = true;
    const putRes = await track(
      sendFetch(options.putUrl, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(options.nextRulesBody),
      }),
    );
    if (!putRes.ok) {
      deployAttempted = false;
    }
    result = await options.body(putRes);
  } finally {
    try {
      if (!options.session?.isStopping) {
        await restoreOnce();
      }
    } finally {
      unregister();
    }
  }
  return { result, restoreOk, restoreStatus };
}

export function selectFilteredRunProbes<T extends { name: string }>(
  allProbes: readonly T[],
  argv: readonly string[],
): { selected: T[]; filters: string[] } {
  const filters = stripCaptureFlags(argv).filter((arg) => !arg.startsWith('-'));
  if (filters.length === 0) {
    return { selected: [...allProbes], filters };
  }
  const selected = allProbes.filter((probe) => filters.some((f) => probe.name.includes(f)));
  return { selected, filters };
}

export function printRunInertPreview(options: {
  fbSdkVersion: string;
  totalCount: number;
  selected: readonly { name: string; matrixRow: string }[];
  filters: readonly string[];
}): void {
  console.log('[oracle] INERT preview (no --write flag): zero credential reads, zero network calls.');
  console.log(`[oracle] firebase-js-sdk ${options.fbSdkVersion}`);
  if (options.filters.length > 0) {
    console.log(
      `[oracle] filter: ${options.filters.join(', ')} -> ${options.selected.length} of ${options.totalCount} probes`,
    );
  } else {
    console.log(`[oracle] would run ${options.selected.length} probe(s):`);
  }
  for (const probe of options.selected) {
    console.log(`  - ${probe.name} (${probe.matrixRow})`);
  }
  console.log(`\n  ${formatInertPreviewFooter('packages/conformance/src/run.ts', '[probe-substring...]')}`);
}
