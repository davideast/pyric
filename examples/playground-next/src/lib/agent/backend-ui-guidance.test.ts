/**
 * Regression pins for the no-in-app-backend guidance (SF-S1, the #575
 * identity-switcher lesson generalized — plans/app-spec.md §3.6). The
 * first live draft-validate run (Gemini 3.5 Flash, session 0ddf0362) baked
 * a client-side `setDoc(menuItems)` seed button into App.tsx because the
 * cage left it no host surface to ask for setup. The fix is twofold:
 * de-cage the draft (give it the seed tool — see draft-then-validate.ts)
 * AND forbid in-app backend/seed/admin code in protected prompt guidance.
 *
 * `BACKEND_UI_GUIDANCE` is the ONE source of truth: the react loop inherits
 * it via `buildSystemPrompt`, and draft-then-validate inherits it via
 * `composeDraftSystemPrompt` (which folds the same constant into its draft
 * prompt). These tests pin the load-bearing strings in BOTH composed
 * prompts so neither layer can silently drop the rule.
 */
import { describe, expect, test } from 'bun:test';
import { BACKEND_UI_GUIDANCE, buildSystemPrompt } from './system-prompt';
import { composeDraftSystemPrompt } from './strategies/draft-then-validate';

// The load-bearing strings — asserted verbatim against every prompt the
// guidance feeds. Keep in sync with BACKEND_UI_GUIDANCE in system-prompt.ts.
const PINS = [
  'NO IN-APP BACKEND/SEED/ADMIN CODE',
  "The app UI renders the END-USER's product ONLY",
  'Apps NEVER write fixture/seed/admin data',
  'no client-side seeding',
  'no `setDoc`/`addDoc` to populate demo data',
  'no admin bootstrap',
  'Seeding, identity setup, and fixture data are HOST surfaces',
  'CALL `seed_firestore_data_as_admin`',
  'A seed button in App.tsx is a security smell',
] as const;

describe('backend-UI guidance — single source of truth', () => {
  test('BACKEND_UI_GUIDANCE carries every pinned string', () => {
    for (const pin of PINS) expect(BACKEND_UI_GUIDANCE).toContain(pin);
  });
});

describe('react loop inherits the guidance (buildSystemPrompt)', () => {
  const prompt = buildSystemPrompt({ diagnosticsEnabled: false });

  test('forbids in-app seeding / admin code', () => {
    for (const pin of PINS) expect(prompt).toContain(pin);
  });

  test('the whole guidance block is present verbatim', () => {
    expect(prompt).toContain(BACKEND_UI_GUIDANCE);
  });
});

describe('draft-validate inherits the SAME guidance (composeDraftSystemPrompt)', () => {
  // The draft prompt is self-contained — an empty host prompt still carries
  // the guidance (it is folded into DRAFT_GUIDANCE, not the host excerpt).
  const draftPrompt = composeDraftSystemPrompt('');

  test('forbids in-app seeding / admin code', () => {
    for (const pin of PINS) expect(draftPrompt).toContain(pin);
  });

  test('the whole guidance block is present verbatim (one source of truth)', () => {
    expect(draftPrompt).toContain(BACKEND_UI_GUIDANCE);
  });

  test('points the de-caged draft at the host seed tool, not in-app UI', () => {
    expect(draftPrompt).toContain('seed_firestore_data_as_admin');
    expect(draftPrompt).toContain('NEVER bake seeding into App.tsx');
  });
});
