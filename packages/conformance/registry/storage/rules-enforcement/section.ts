import { defineRowSection } from '../../section-rows.ts';

export const section = defineRowSection({
  surface: "storage",
  order: 150,
  prefix: "## Op-level rules enforcement — a denied op throws `storage/unauthorized`\n\nThese are Storage SDK behaviors: how an upload / read / metadata / delete op\nsurfaces a rules deny verdict. The rules-engine fidelity rows\n(`parseStorageRules` / `evaluateStorageRules` vs the production Rules Test\nAPI) moved to the native `storage-rules` surface (`docs/rules/COMPAT.md`).\n",
  defaults: {
    featureKeys: ["setRules"],
    section: "Op-level rules enforcement — a denied op throws `storage/unauthorized`",
    api: "Rules enforcement",
    status: "conforms",
  },
});

export const row = section.row;
