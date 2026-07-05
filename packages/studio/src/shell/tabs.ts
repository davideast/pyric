/**
 * The v1 tab set (T4): the C4 shell tabs, extended so each maps to a
 * `@pyric/ui` area where one exists.
 *
 * C4 shipped a feature-oriented nav (Action / Data / Traffic / Rules / Agent /
 * App Builder). `@pyric/ui` is organised by *service* (auth / firestore /
 * storage / traffic / agents). T4's job is to mount those surfaces. The map:
 *
 *   Action Center → (Wave 2 reducer over the event stream, no ui area yet)
 *   Data          → fans out to firestore / auth / storage ui areas
 *   Traffic       → `@pyric/ui/traffic`
 *   Rules         → (rules simulator, Wave 2; no ui area yet)
 *   Agent         → `@pyric/ui/agents`
 *   App Builder   → (workspace editor, Wave 3; no ui area yet)
 *
 * The Data tab is the natural home for the service-grid surfaces, so rather than
 * bury auth/firestore/storage we surface each as its own nav entry under a
 * "Data" group while keeping the original feature tabs. `area` is a hint for the
 * pane renderer; `group` drives the nav section headers.
 */

/** Which `@pyric/ui` surface a tab mounts, if any. */
export type UiArea =
  | 'firestore'
  | 'auth'
  | 'storage'
  | 'traffic'
  | 'agents'
  | null;

export interface StudioTab {
  id: string;
  label: string;
  /** Nav section header this tab sits under. */
  group: 'Overview' | 'Data' | 'Observe' | 'Build';
  /** The `@pyric/ui` area this tab mounts (null = bespoke / Wave-2 feature). */
  area: UiArea;
  /** What this surface does once its feature lands. */
  blurb: string;
}

/** The v1 surfaces, in nav order. */
export const TABS: readonly StudioTab[] = [
  {
    id: 'action',
    label: 'Action Center',
    group: 'Overview',
    area: null,
    blurb:
      'A live digest of what changed across every service ("10 docs added to /users", "new user signed up"), attributed to the app, an agent, or you.',
  },
  {
    id: 'firestore',
    label: 'Firestore',
    group: 'Data',
    area: 'firestore',
    blurb:
      'Browse and edit Firestore collections and documents with the admin lens. Clickable cross-references jump from a uid field to its user, a gs:// path to its object.',
  },
  {
    id: 'auth',
    label: 'Auth',
    group: 'Data',
    area: 'auth',
    blurb:
      'View, create, and edit sandbox users and their custom claims. Impersonate a user to reproduce a rules failure exactly as they hit it.',
  },
  {
    id: 'storage',
    label: 'Storage',
    group: 'Data',
    area: 'storage',
    blurb:
      'Browse the object store, preview files inline, upload, and bulk-delete. gs:// references elsewhere in Studio link straight here.',
  },
  {
    id: 'traffic',
    label: 'Traffic',
    group: 'Observe',
    area: 'traffic',
    blurb:
      'Every request against the sandbox as it happens: reads, writes, listeners, and the rule decisions behind them.',
  },
  {
    id: 'rules',
    label: 'Rules',
    group: 'Observe',
    area: null,
    blurb:
      'Why did this request get denied? See the rule that rejected it, the request.auth context, and re-run it as the attempting user or against an edited ruleset.',
  },
  {
    id: 'agent',
    label: 'Agent',
    group: 'Build',
    area: 'agents',
    blurb:
      'Describe a change in plain language; the Pyric Agent plans it, dry-runs it on a branch, and shows you the diff before anything is committed.',
  },
  {
    id: 'builder',
    label: 'App Builder',
    group: 'Build',
    area: null,
    blurb:
      'Build the app itself against this same sandbox. Edits land in the working tree; experiments run as branches you can promote or discard.',
  },
];

export const TAB_IDS: readonly string[] = TABS.map((t) => t.id);

/** Nav groups in render order, each with its tabs. */
export const TAB_GROUPS: ReadonlyArray<{
  group: StudioTab['group'];
  tabs: readonly StudioTab[];
}> = (['Overview', 'Data', 'Observe', 'Build'] as const).map((group) => ({
  group,
  tabs: TABS.filter((t) => t.group === group),
}));

export function findTab(id: string): StudioTab {
  return TABS.find((t) => t.id === id) ?? TABS[0];
}
