/**
 * Equivalence-class and cartesian-product generators for Node preload flag
 * orderings, `--` end-of-options boundaries, Worker/child option shapes,
 * post-boot environment mutations, and `createRequire` importer-origin spoofing.
 */
import { cartesian2, cartesian3 } from './combinators.js';

type RegisterSurface = 'sandbox' | 'live';
type AiModeVariant = 'sandbox' | 'production';

type PreloadFlagKind =
  | 'import-split'
  | 'import-attached'
  | 'require-split'
  | 'require-attached'
  | 'short-r'
  | 'short-r-attached';

type PreloadPosition =
  | 'caller-only'
  | 'caller-before-register'
  | 'caller-after-import-register';

type PreloadChannel =
  | 'worker-execArgv'
  | 'worker-node-options'
  | 'child-node-options'
  | 'child-cli-args'
  | 'child-fork-execArgv';

export interface PreloadOrderingCase {
  readonly id: string;
  readonly surface: RegisterSurface;
  readonly channel: PreloadChannel;
  readonly tokens: readonly string[];
  readonly nodeOptions: string;
}

export interface CanonicalizerPreloadCase {
  readonly id: string;
  readonly surface: RegisterSurface;
  readonly flagKind: PreloadFlagKind;
  readonly tokens: readonly string[];
  readonly nodeOptions: string;
}

export interface DashDashBoundaryCase {
  readonly id: string;
  readonly surface: RegisterSurface;
  readonly channel: 'worker-execArgv' | 'child-fork-execArgv' | 'child-cli-args';
  readonly tokens: readonly string[];
  readonly expectsEarlyHook: boolean;
}

type EvalTruthinessKind =
  | 'bool-true'
  | 'num-one'
  | 'str-one'
  | 'empty-obj'
  | 'non-enum-true'
  | 'proto-inherited-one';
type EvalBodyKind = 'plain-cjs' | 'hoisted-require' | 'hoisted-require-and-module';
type WorkerEnvKind = 'default' | 'null' | 'share-env' | 'custom';

interface WorkerEvalMatrixCase {
  readonly id: string;
  readonly surface: RegisterSurface;
  readonly evalKind: EvalTruthinessKind;
  readonly bodyKind: EvalBodyKind;
  readonly envKind: WorkerEnvKind;
}

type ToctouTrapKind =
  | 'getter-eval-flip-false'
  | 'proxy-eval-flip-false'
  | 'getter-execArgv-inject-r'
  | 'proxy-execArgv-inject-r'
  | 'elem-getter-execArgv-inject-r'
  | 'getter-env-inject-prod';

interface PostBootNodeEnvCase {
  readonly id: string;
  readonly surface: RegisterSurface;
  readonly carrier: 'worker-file' | 'worker-eval' | 'child-spawn' | 'child-fork';
  readonly envKind: WorkerEnvKind;
}

export type ImporterOriginKind =
  | 'app-module'
  | 'app-decoy-bridge'
  | 'app-bridge'
  | 'app-bridge-shadow'
  | 'app-check-bridge'
  | 'admin-app-check-bridge';

export const TARGET_FIREBASE_SPECIFIERS = [
  'firebase/app',
  'firebase/app-check',
  'firebase/ai',
  'firebase/firestore',
  'firebase-admin/app',
  'firebase-admin/app-check',
  'firebase-admin/firestore',
] as const;

export type TargetFirebaseSpecifier = (typeof TARGET_FIREBASE_SPECIFIERS)[number];

interface ImporterSpoofCase {
  readonly id: string;
  readonly aiMode: AiModeVariant;
  readonly importerKind: ImporterOriginKind;
  readonly specifier: TargetFirebaseSpecifier;
  readonly expectedRealUnderRequire: boolean;
  readonly expectedRealUnderEsmImport: boolean;
  readonly expectedStoppedUnderRequire: boolean;
  readonly expectedStoppedUnderEsmImport: boolean;
}

interface PostBootAiModeCase {
  readonly id: string;
  readonly mutationKind: 'mode-prod' | 'passthrough-only' | 'mode-prod-and-passthrough';
  readonly carrier:
    | 'in-process'
    | 'worker-default'
    | 'worker-share-env'
    | 'worker-custom'
    | 'child-spawn';
}

const PRELOAD_FLAG_KINDS: readonly PreloadFlagKind[] = [
  'import-split',
  'import-attached',
  'require-split',
  'require-attached',
  'short-r',
  'short-r-attached',
];

const PRELOAD_POSITIONS: readonly PreloadPosition[] = [
  'caller-only',
  'caller-before-register',
  'caller-after-import-register',
];

const PRELOAD_CHANNELS: readonly PreloadChannel[] = [
  'worker-execArgv',
  'worker-node-options',
  'child-node-options',
  'child-cli-args',
  'child-fork-execArgv',
];

function renderPreloadFlagTokens(
  flagKind: PreloadFlagKind,
  esmPreloadUrl: string,
  cjsPreloadPath: string,
): string[] {
  if (flagKind === 'import-split') return ['--import', esmPreloadUrl];
  if (flagKind === 'import-attached') return [`--import=${esmPreloadUrl}`];
  if (flagKind === 'require-split') return ['--require', cjsPreloadPath];
  if (flagKind === 'require-attached') return [`--require=${cjsPreloadPath}`];
  if (flagKind === 'short-r-attached') return [`-r=${cjsPreloadPath}`];
  return ['-r', cjsPreloadPath];
}

function composePreloadPositionTokens(
  position: PreloadPosition,
  callerTokens: readonly string[],
  registerUrl: string,
): string[] {
  if (position === 'caller-only') return [...callerTokens];
  if (position === 'caller-before-register') return [...callerTokens, '--import', registerUrl];
  return ['--import', registerUrl, ...callerTokens];
}

function serializeNodeOptionsTokens(tokens: readonly string[]): string {
  return tokens
    .map((token) => {
      if (/\s/.test(token)) return JSON.stringify(token);
      return token;
    })
    .join(' ');
}

function shouldSpawnLivePreloadCombination(
  flagKind: PreloadFlagKind,
  position: PreloadPosition,
  channel: PreloadChannel,
): boolean {
  // Node rejects `-r=<path>` on CLI/NODE_OPTIONS; verified via canonicalizer matrix.
  if (flagKind === 'short-r-attached') return false;
  if (position === 'caller-only') {
    if (channel === 'worker-execArgv') return true;
    if (channel === 'child-node-options') {
      return (
        flagKind === 'import-attached' || flagKind === 'require-split' || flagKind === 'short-r'
      );
    }
    return flagKind === 'import-split' || flagKind === 'require-attached';
  }
  if (position === 'caller-before-register') {
    return (
      (flagKind === 'short-r' && channel === 'worker-execArgv') ||
      (flagKind === 'import-split' && channel === 'worker-node-options')
    );
  }
  return (
    (flagKind === 'short-r' && channel === 'worker-execArgv') ||
    (flagKind === 'require-attached' && channel === 'child-node-options')
  );
}

export interface PreloadGeneratorInput {
  readonly sandboxRegisterUrl: string;
  readonly liveRegisterUrl: string;
  readonly sandboxEsmPreloadUrl: string;
  readonly sandboxCjsPreloadPath: string;
  readonly liveEsmPreloadUrl: string;
  readonly liveCjsPreloadPath: string;
}

/**
 * Generates the full 36-cell `surface` x `flagKind` (all 6 spellings incl. `-r=`)
 * x `position` cartesian product for pure `execArgv` and `NODE_OPTIONS`
 * canonicalizer verification (`72` total tokenizer evaluations).
 */
export function generateCanonicalizerPreloadMatrix(
  input: PreloadGeneratorInput,
): CanonicalizerPreloadCase[] {
  const surfaces: readonly RegisterSurface[] = ['sandbox', 'live'];
  return cartesian3(surfaces, PRELOAD_FLAG_KINDS, PRELOAD_POSITIONS).map(
    ([surface, flagKind, position]) => {
      const registerUrl = surface === 'sandbox' ? input.sandboxRegisterUrl : input.liveRegisterUrl;
      const esmUrl = surface === 'sandbox' ? input.sandboxEsmPreloadUrl : input.liveEsmPreloadUrl;
      const cjsPath =
        surface === 'sandbox' ? input.sandboxCjsPreloadPath : input.liveCjsPreloadPath;
      const callerTokens = renderPreloadFlagTokens(flagKind, esmUrl, cjsPath);
      const tokens = composePreloadPositionTokens(position, callerTokens, registerUrl);
      return {
        id: `${surface}-${flagKind}-${position}`,
        surface,
        flagKind,
        tokens,
        nodeOptions: serializeNodeOptionsTokens(tokens),
      };
    },
  );
}

/**
 * Generates live Node Worker/child preload combinations across all 5 channels
 * and both register surfaces, keeping subprocess V8 cold-boot count compact enough
 * to complete comfortably on 2-vCPU CI runners.
 */
export function generatePreloadOrderingMatrix(input: PreloadGeneratorInput): PreloadOrderingCase[] {
  const surfaces: readonly RegisterSurface[] = ['sandbox', 'live'];
  const out: PreloadOrderingCase[] = [];

  for (const [surface, flagKind, position] of cartesian3(
    surfaces,
    PRELOAD_FLAG_KINDS,
    PRELOAD_POSITIONS,
  )) {
    const registerUrl = surface === 'sandbox' ? input.sandboxRegisterUrl : input.liveRegisterUrl;
    const esmUrl = surface === 'sandbox' ? input.sandboxEsmPreloadUrl : input.liveEsmPreloadUrl;
    const cjsPath = surface === 'sandbox' ? input.sandboxCjsPreloadPath : input.liveCjsPreloadPath;
    const callerTokens = renderPreloadFlagTokens(flagKind, esmUrl, cjsPath);
    const tokens = composePreloadPositionTokens(position, callerTokens, registerUrl);
    const nodeOptions = serializeNodeOptionsTokens(tokens);

    for (const channel of PRELOAD_CHANNELS) {
      if (!shouldSpawnLivePreloadCombination(flagKind, position, channel)) continue;
      out.push({
        id: `${surface}-${flagKind}-${position}-${channel}`,
        surface,
        channel,
        tokens,
        nodeOptions,
      });
    }
  }
  return out;
}

/**
 * Generates `--` end-of-options boundary combinations across `Worker` `execArgv`,
 * `child_process.fork` `execArgv`, and `child_process.spawn` CLI arguments.
 */
export function generateDashDashBoundaryMatrix(input: {
  sandboxRegisterUrl: string;
  liveRegisterUrl: string;
  sandboxCjsPreloadPath: string;
  liveCjsPreloadPath: string;
}): DashDashBoundaryCase[] {
  const surfaces: readonly RegisterSurface[] = ['sandbox', 'live'];
  const channels: ReadonlyArray<DashDashBoundaryCase['channel']> = [
    'worker-execArgv',
    'child-fork-execArgv',
    'child-cli-args',
  ];
  const out: DashDashBoundaryCase[] = [];

  for (const [surface, channel] of cartesian2(surfaces, channels)) {
    const registerUrl = surface === 'sandbox' ? input.sandboxRegisterUrl : input.liveRegisterUrl;
    const cjsPath = surface === 'sandbox' ? input.sandboxCjsPreloadPath : input.liveCjsPreloadPath;

    if (channel === 'worker-execArgv') {
      out.push({
        id: `${surface}-${channel}-bare-dash-dash`,
        surface,
        channel,
        tokens: ['--'],
        expectsEarlyHook: false,
      });
      out.push({
        id: `${surface}-${channel}-decoy-register-after-dash-dash`,
        surface,
        channel,
        tokens: ['--', '--import', registerUrl],
        expectsEarlyHook: false,
      });
    }
    out.push({
      id: `${surface}-${channel}-r-before-dash-dash`,
      surface,
      channel,
      tokens: ['-r', cjsPath, '--'],
      expectsEarlyHook: true,
    });
  }
  return out;
}

/**
 * Generates Worker truthy `eval` spellings x CJS hoisting bodies x `env` shapes.
 */
export function generateWorkerEvalMatrix(): WorkerEvalMatrixCase[] {
  const surfaces: readonly RegisterSurface[] = ['sandbox', 'live'];
  const evalKinds: readonly EvalTruthinessKind[] = [
    'bool-true',
    'num-one',
    'str-one',
    'empty-obj',
    'non-enum-true',
    'proto-inherited-one',
  ];
  const bodyKinds: readonly EvalBodyKind[] = [
    'plain-cjs',
    'hoisted-require',
    'hoisted-require-and-module',
  ];
  const envKinds: readonly WorkerEnvKind[] = ['default', 'null', 'share-env', 'custom'];

  const out: WorkerEvalMatrixCase[] = [];
  for (const surface of surfaces) {
    for (let i = 0; i < evalKinds.length; i += 1) {
      const evalKind = evalKinds[i];
      const rotatedEnv = envKinds[i % envKinds.length];
      if (evalKind === undefined || rotatedEnv === undefined) continue;
      out.push({
        id: `${surface}-${evalKind}-plain-cjs-${rotatedEnv}`,
        surface,
        evalKind,
        bodyKind: 'plain-cjs',
        envKind: rotatedEnv,
      });
      if (
        (evalKind === 'non-enum-true' || evalKind === 'proto-inherited-one') &&
        rotatedEnv !== 'custom'
      ) {
        out.push({
          id: `${surface}-${evalKind}-plain-cjs-custom`,
          surface,
          evalKind,
          bodyKind: 'plain-cjs',
          envKind: 'custom',
        });
      }
    }
  }
  const hoistedEnvs: readonly WorkerEnvKind[] = ['default', 'share-env'];
  for (const [surface, bodyKind, envKind] of cartesian3(surfaces, bodyKinds, hoistedEnvs)) {
    if (bodyKind === 'plain-cjs') continue;
    out.push({
      id: `${surface}-num-one-${bodyKind}-${envKind}`,
      surface,
      evalKind: 'num-one',
      bodyKind,
      envKind,
    });
  }
  return out;
}

export const TOCTOU_TRAP_KINDS: readonly ToctouTrapKind[] = [
  'getter-eval-flip-false',
  'proxy-eval-flip-false',
  'getter-execArgv-inject-r',
  'proxy-execArgv-inject-r',
  'elem-getter-execArgv-inject-r',
  'getter-env-inject-prod',
];

/**
 * Generates post-boot `process.env.NODE_ENV = 'production'` combinations across
 * execution carriers and Worker/child env modes.
 */
export function generatePostBootNodeEnvMatrix(): PostBootNodeEnvCase[] {
  const surfaces: readonly RegisterSurface[] = ['sandbox', 'live'];
  const carriers: ReadonlyArray<PostBootNodeEnvCase['carrier']> = [
    'worker-file',
    'worker-eval',
    'child-spawn',
    'child-fork',
  ];
  const envKinds: readonly WorkerEnvKind[] = ['default', 'null', 'share-env', 'custom'];

  const out: PostBootNodeEnvCase[] = [];
  for (const [surface, carrier, envKind] of cartesian3(surfaces, carriers, envKinds)) {
    const isChild = carrier === 'child-spawn' || carrier === 'child-fork';
    if (isChild && (envKind === 'null' || envKind === 'share-env')) {
      continue;
    }
    out.push({
      id: `${surface}-${carrier}-${envKind}`,
      surface,
      carrier,
      envKind,
    });
  }
  return out;
}

function isAllowedRealSdkBySpec(
  aiMode: AiModeVariant,
  importerKind: ImporterOriginKind,
  specifier: TargetFirebaseSpecifier,
  isEsmImport: boolean,
): boolean {
  if (aiMode !== 'production') return false;
  if (specifier === 'firebase/ai') return true;
  if (!isEsmImport) return false;
  const isAppBridge = importerKind === 'app-bridge' || importerKind === 'app-bridge-shadow';
  if (isAppBridge && specifier === 'firebase/app') return true;
  if (importerKind === 'app-check-bridge' && specifier === 'firebase/app-check') return true;
  if (
    importerKind === 'admin-app-check-bridge' &&
    (specifier === 'firebase-admin/app' || specifier === 'firebase-admin/app-check')
  ) {
    return true;
  }
  return false;
}

function isStoppedDirectSdkBySpec(
  aiMode: AiModeVariant,
  importerKind: ImporterOriginKind,
  specifier: TargetFirebaseSpecifier,
  isEsmImport: boolean,
): boolean {
  if (aiMode !== 'production') return true;
  if (
    specifier === 'firebase/app' ||
    specifier === 'firebase/app-check' ||
    specifier === 'firebase/ai'
  ) {
    return false;
  }
  if (
    isEsmImport &&
    importerKind === 'admin-app-check-bridge' &&
    (specifier === 'firebase-admin/app' || specifier === 'firebase-admin/app-check')
  ) {
    return false;
  }
  return true;
}

/**
 * Generates the full 84-case cartesian product of `aiMode` x `importerKind` x `specifier`.
 */
export function generateImporterOriginMatrix(): ImporterSpoofCase[] {
  const aiModes: readonly AiModeVariant[] = ['sandbox', 'production'];
  const importers: readonly ImporterOriginKind[] = [
    'app-module',
    'app-decoy-bridge',
    'app-bridge',
    'app-bridge-shadow',
    'app-check-bridge',
    'admin-app-check-bridge',
  ];
  return cartesian3(aiModes, importers, TARGET_FIREBASE_SPECIFIERS).map(
    ([aiMode, importerKind, specifier]) => ({
      id: `${aiMode}-${importerKind}-${specifier.replace(/\//g, '_')}`,
      aiMode,
      importerKind,
      specifier,
      expectedRealUnderRequire: isAllowedRealSdkBySpec(aiMode, importerKind, specifier, false),
      expectedRealUnderEsmImport: isAllowedRealSdkBySpec(aiMode, importerKind, specifier, true),
      expectedStoppedUnderRequire: isStoppedDirectSdkBySpec(
        aiMode,
        importerKind,
        specifier,
        false,
      ),
      expectedStoppedUnderEsmImport: isStoppedDirectSdkBySpec(
        aiMode,
        importerKind,
        specifier,
        true,
      ),
    }),
  );
}

/**
 * Generates post-boot `PYRIC_AI_MODE` / `PYRIC_AI_PASSTHROUGH` env mutation
 * combinations across in-process, worker, and child execution carriers.
 */
export function generatePostBootAiModeMatrix(): PostBootAiModeCase[] {
  const mutations: ReadonlyArray<PostBootAiModeCase['mutationKind']> = [
    'mode-prod',
    'passthrough-only',
    'mode-prod-and-passthrough',
  ];
  const carriers: ReadonlyArray<PostBootAiModeCase['carrier']> = [
    'in-process',
    'worker-default',
    'worker-share-env',
    'worker-custom',
    'child-spawn',
  ];
  return cartesian2(mutations, carriers).map(([mutationKind, carrier]) => ({
    id: `${mutationKind}-${carrier}`,
    mutationKind,
    carrier,
  }));
}
