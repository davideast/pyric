import {
  resolveActiveSkills,
  resolveWorkbenchIntent,
  type FirebaseWorkbenchSubtab,
  type SkillDefinition,
  type SkillToolProfilePreference,
  type WorkbenchSurface,
} from '~/lib/skills/registry';

export type ContextLensId =
  | 'app-build'
  | 'firestore'
  | 'rtdb'
  | 'auth'
  | 'storage'
  | 'rules'
  | 'data-modeling'
  | 'queries-indexes'
  | 'seed-data'
  | 'audit';

export interface ContextLens {
  id: ContextLensId;
  label: string;
  icon: string;
}

export interface ContextSignalMatch {
  lensId: ContextLensId;
  label: string;
  icon: string;
  start: number;
  end: number;
}

export interface ResolvedAgentContext {
  promptProfile: 'firebase' | 'app-builder';
  lenses: ContextLens[];
  suggestedSkillIds: string[];
  activeSkills: SkillDefinition[];
  workbenchIntent: {
    promptProfile: 'firebase' | 'app-builder';
    primarySurface: WorkbenchSurface;
    defaultFirebaseSubtab?: FirebaseWorkbenchSubtab;
    defaultFilePath?: string;
    toolProfilePreference?: SkillToolProfilePreference;
  };
  toolProfilePreference?: SkillToolProfilePreference;
}

const LENS_META: Record<ContextLensId, ContextLens> = {
  'app-build': { id: 'app-build', label: 'App build', icon: 'web_asset' },
  firestore: { id: 'firestore', label: 'Firestore', icon: 'database' },
  rtdb: { id: 'rtdb', label: 'RTDB', icon: 'account_tree' },
  auth: { id: 'auth', label: 'Auth', icon: 'passkey' },
  storage: { id: 'storage', label: 'Storage', icon: 'folder' },
  rules: { id: 'rules', label: 'Rules', icon: 'policy' },
  'data-modeling': { id: 'data-modeling', label: 'Data model', icon: 'schema' },
  'queries-indexes': { id: 'queries-indexes', label: 'Indexes', icon: 'query_stats' },
  'seed-data': { id: 'seed-data', label: 'Seed data', icon: 'grass' },
  audit: { id: 'audit', label: 'Audit', icon: 'manage_search' },
};

const LENS_PATTERNS: Array<[ContextLensId, RegExp]> = [
  [
    'app-build',
    /\b(App\.tsx|preview|web app|application UI)\b|\b(build|create|make|implement|scaffold|prototype|modify|update)\b.{0,48}\b(app|ui|interface|screen|component|preview|website|web app|page|dashboard)\b|\b(app|ui|interface|screen|component|preview|website|web app|page|dashboard)\b.{0,48}\b(build|create|make|implement|scaffold|prototype|modify|update)\b/i,
  ],
  ['firestore', /\b(firestore|collection|collections|document|documents|doc\b|collection group|query|queries|index|indexes)\b/i],
  ['rtdb', /\b(rtdb|realtime database|database\.rules|database rules|json rules)\b/i],
  ['auth', /\b(auth|authentication|sign[- ]?in|sign[- ]?out|user|users|uid|provider|claims?|custom claims?|role|roles|member|membership)\b/i],
  ['storage', /\b(storage|bucket|object|file upload|download url|metadata)\b/i],
  ['rules', /\b(rule|rules|security|permission|permissions|allow|deny|denied|access|owner|admin|role based|role-based|membership)\b/i],
  [
    'data-modeling',
    /\b(data model|model data|model\b.{0,32}\bdata|data\b.{0,32}\bmodel|schema|shape|structure|collections?|documents?|paths?|membership|relationship|relationships)\b/i,
  ],
  ['queries-indexes', /\b(query|queries|index|indexes|orderBy|where|pagination|cursor|collection group|firestore_extract_indexes)\b/i],
  ['seed-data', /\b(seed|fixture|fixtures|sample data|test data|auth users?|populate)\b/i],
  ['audit', /\b(audit|review|inspect|assess|analyze|find gaps|vulnerab|security review)\b/i],
];

const SIGNAL_PATTERNS: Array<[ContextLensId, RegExp]> = [
  ['app-build', /\b(App\.tsx|preview|web app|application UI|app|ui|interface|screen|component|website|dashboard)\b/gi],
  ['firestore', /\b(Firestore|collection groups?|collections?|documents?|docs?)\b/gi],
  ['rtdb', /\b(RTDB|Realtime Database|database\.rules|database rules|json rules)\b/gi],
  ['auth', /\b(Auth|authentication|sign[- ]?in|sign[- ]?out|users?|uid|providers?|custom claims?|claims?)\b/gi],
  ['storage', /\b(Storage|buckets?|objects?|file uploads?|download urls?|metadata)\b/gi],
  ['rules', /\b(rules?|security|permissions?|allow|deny|denied|access|owners?|admins?|role[- ]based(?: access)?|membership)\b/gi],
  ['data-modeling', /\b(data model(?:ing)?|model data|schema|shape|structure|relationships?|paths?)\b/gi],
  ['queries-indexes', /\b(queries|query|indexes|index|orderBy|where|pagination|cursor|collection group|firestore_extract_indexes)\b/gi],
  ['seed-data', /\b(seed data|seed|fixtures?|sample data|test data|auth users?|populate)\b/gi],
  ['audit', /\b(audit|review|inspect|assess|analyze|find gaps|vulnerabilities|security review)\b/gi],
];

const GENERAL_FIREBASE_SKILL_TO_LENSES: Record<string, ContextLensId[]> = {
  'firebase-audit': ['audit'],
  'playground-firebase-auth-model': ['auth'],
  'firestore-rules-audit': ['firestore', 'rules', 'audit'],
  'playground-firestore-query-indexes': ['firestore', 'queries-indexes'],
  'rtdb-security-rules': ['rtdb', 'rules'],
  'rtdb-data-model': ['rtdb', 'data-modeling'],
};

function addLens(out: ContextLensId[], id: ContextLensId, dismissed: ReadonlySet<ContextLensId>) {
  if (dismissed.has(id)) return;
  if (!out.includes(id)) out.push(id);
}

export function detectContextLensIds(
  prompt: string,
  dismissedLensIds: readonly ContextLensId[] = [],
): ContextLensId[] {
  const dismissed = new Set(dismissedLensIds);
  const out: ContextLensId[] = [];
  for (const [id, re] of LENS_PATTERNS) {
    if (re.test(prompt)) addLens(out, id, dismissed);
  }
  return out;
}

export function contextLensById(id: ContextLensId): ContextLens {
  return LENS_META[id];
}

export function contextLensesForPrompt(
  prompt: string,
  dismissedLensIds: readonly ContextLensId[] = [],
): ContextLens[] {
  return detectContextLensIds(prompt, dismissedLensIds).map(contextLensById);
}

export function detectContextSignalMatches(prompt: string): ContextSignalMatch[] {
  if (!prompt.trim()) return [];

  const matches: ContextSignalMatch[] = [];
  for (const [lensId, pattern] of SIGNAL_PATTERNS) {
    pattern.lastIndex = 0;
    for (const match of prompt.matchAll(pattern)) {
      if (match.index === undefined || !match[0]) continue;
      const meta = contextLensById(lensId);
      matches.push({
        lensId,
        label: match[0],
        icon: meta.icon,
        start: match.index,
        end: match.index + match[0].length,
      });
    }
  }

  return matches
    .sort((a, b) => {
      if (a.start !== b.start) return a.start - b.start;
      return b.end - b.start - (a.end - a.start);
    })
    .reduce<ContextSignalMatch[]>((out, match) => {
      const previous = out[out.length - 1];
      if (previous && match.start < previous.end) return out;
      out.push(match);
      return out;
    }, []);
}

export function suggestedSkillIdsForPrompt(prompt: string): string[] {
  return /\b(game rules|turn[- ]based|multiplayer game|valid moves?|winner|tic[- ]tac[- ]toe|chess|checkers)\b/i.test(prompt) ||
    /\bgame\b.{0,40}\b(score|moves?|turns?|winner|rules?)\b/i.test(prompt) ||
    /\b(score|moves?|turns?|winner|rules?)\b.{0,40}\bgame\b/i.test(prompt)
    ? ['game-rules']
    : [];
}

export function isGeneralFirebaseSkill(skill: SkillDefinition): boolean {
  return skill.id in GENERAL_FIREBASE_SKILL_TO_LENSES;
}

export function isSpecialistSkill(skill: SkillDefinition): boolean {
  return !isGeneralFirebaseSkill(skill);
}

export function lensIdsFromSkills(skills: readonly SkillDefinition[]): ContextLensId[] {
  const out: ContextLensId[] = [];
  const none = new Set<ContextLensId>();
  for (const skill of skills) {
    for (const id of GENERAL_FIREBASE_SKILL_TO_LENSES[skill.id] ?? []) {
      addLens(out, id, none);
    }
  }
  return out;
}

function preferredWorkbenchForLenses(lenses: readonly ContextLens[]): {
  primarySurface: WorkbenchSurface;
  defaultFirebaseSubtab?: FirebaseWorkbenchSubtab;
  defaultFilePath?: string;
} {
  const ids = new Set(lenses.map((lens) => lens.id));
  if (ids.has('app-build')) return { primarySurface: 'preview' };
  if (ids.has('audit')) return { primarySurface: 'firebase', defaultFirebaseSubtab: 'sandbox' };
  if (ids.has('rules')) {
    return {
      primarySurface: 'file',
      defaultFilePath: ids.has('rtdb')
        ? '/workspace/database.rules.json'
        : '/workspace/firestore.rules',
    };
  }
  if (ids.has('auth')) return { primarySurface: 'firebase', defaultFirebaseSubtab: 'auth' };
  if (ids.has('seed-data')) return { primarySurface: 'firebase', defaultFirebaseSubtab: 'seed' };
  if (ids.has('data-modeling') || ids.has('queries-indexes') || ids.has('firestore')) {
    return { primarySurface: 'firebase', defaultFirebaseSubtab: 'data' };
  }
  return { primarySurface: 'firebase', defaultFirebaseSubtab: 'sandbox' };
}

export function resolveAgentContext({
  prompt = '',
  activeSkillIds = [],
  dismissedLensIds = [],
}: {
  prompt?: string;
  activeSkillIds?: readonly string[];
  dismissedLensIds?: readonly ContextLensId[];
} = {}): ResolvedAgentContext {
  const activeSkills = resolveActiveSkills(activeSkillIds);
  const lensIds = [
    ...detectContextLensIds(prompt, dismissedLensIds),
    ...lensIdsFromSkills(activeSkills),
  ].filter((id, index, ids) => ids.indexOf(id) === index);
  const lenses = lensIds.map(contextLensById);
  const promptProfile = lensIds.includes('app-build') ? 'app-builder' : 'firebase';
  const skillIntent = resolveWorkbenchIntent(activeSkills);
  const lensIntent = preferredWorkbenchForLenses(lenses);
  const hasSkillWorkbenchIntent = activeSkills.some(
    (skill) => skill.primarySurface || skill.defaultFirebaseSubtab || skill.defaultFilePath,
  );
  const toolProfilePreference =
    skillIntent.toolProfilePreference ??
    (promptProfile === 'firebase' || lenses.length > 0 ? 'diagnostic' : undefined);

  return {
    promptProfile,
    lenses,
    suggestedSkillIds: suggestedSkillIdsForPrompt(prompt).filter(
      (id) => !activeSkillIds.includes(id),
    ),
    activeSkills,
    workbenchIntent: {
      promptProfile,
      primarySurface: hasSkillWorkbenchIntent ? skillIntent.primarySurface : lensIntent.primarySurface,
      ...(hasSkillWorkbenchIntent ? skillIntent.defaultFirebaseSubtab : lensIntent.defaultFirebaseSubtab
        ? {
            defaultFirebaseSubtab: hasSkillWorkbenchIntent
              ? skillIntent.defaultFirebaseSubtab
              : lensIntent.defaultFirebaseSubtab,
          }
        : {}),
      ...(hasSkillWorkbenchIntent ? skillIntent.defaultFilePath : lensIntent.defaultFilePath
        ? {
            defaultFilePath: hasSkillWorkbenchIntent
              ? skillIntent.defaultFilePath
              : lensIntent.defaultFilePath,
          }
        : {}),
      ...(toolProfilePreference ? { toolProfilePreference } : {}),
    },
    ...(toolProfilePreference ? { toolProfilePreference } : {}),
  };
}
