/**
 * The AI Logic local mirror control tool.
 *
 * No method here sends a prompt anywhere. `script`, `clearScripts`, and
 * `scripts` reach only the local scripted answer engine, not the engine a
 * project has actually configured; when that engine is the gemini
 * production-passthrough one, those three methods are refused, and `status`
 * says so. `status` never returns a key value, a key prefix, or a key
 * length: only whether one is configured.
 */
import type { ToolRecord } from '../method-types.js';

export default {
  order: 80,
  intro:
    "AI Logic's local mirror in the sandbox: script deterministic responses on the scripted answer engine, clear or list what is queued, and read the resolved engine's mode, model, upstream, and whether a key is configured. Nothing here sends a prompt anywhere, and status never returns the key itself.",
} satisfies ToolRecord;
