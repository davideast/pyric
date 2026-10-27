// Compile-time checks, run by `bun run typecheck` (tsconfig.types.json): a rule is a
// string or a boolean, as database.rules.json spells it, so no cast is needed (CS-2).
import type { PathDef } from '../../src/rules/rtdb/constraints/types.js';
import { defineRtdbRules } from '../../src/rules/rtdb/constraints/document.js';

export const closed: PathDef = { read: false, write: false, validate: false };
export const open: PathDef = { read: true, write: 'auth != null', validate: true };
export const defined = defineRtdbRules({ paths: { '/a': { write: 'true', validate: false } } });

// @ts-expect-error a rule is a string or a boolean, not a number
export const numeric: PathDef = { read: 1 };
