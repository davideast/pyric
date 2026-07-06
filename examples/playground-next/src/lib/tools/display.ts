/**
 * Per-tool display metadata. One source of truth for the user-facing
 * presentation of a tool call: the agent SDK uses camelCase
 * identifiers (`writeRules`, `runOnce`) which are programming
 * artifacts; the UI shows humanized labels + action-class icons.
 *
 * Used by the activity row in `AssistantBlock` and the drill-in
 * header in `ToolDetailView`. New tools land here once and pick up
 * the data-journalist treatment everywhere.
 */
export interface ToolDisplay {
  /** Humanized, space-split, uppercase label — treated like a data
   *  label (`WRITE RULES`, `RUN ONCE`). */
  humanLabel: string;
  /** Material-symbols icon. `edit_note` for write surfaces;
   *  `play_arrow` for execution surfaces. */
  icon: string;
  /** One-line description used in the drill-in subtitle / Explain
   *  prompt. Not shown in the activity row. */
  description: string;
}

const DISPLAY: Record<string, ToolDisplay> = {
  writeRules: {
    humanLabel: 'WRITE RULES',
    icon: 'edit_note',
    description:
      'Replaces the Firestore Security Rules editor body with the agent-authored source.',
  },
  writeCode: {
    humanLabel: 'WRITE CODE',
    icon: 'edit_note',
    description:
      'Replaces the Sandbox-tab JS body — the script `runOnce` executes against the sandbox.',
  },
  writeApp: {
    humanLabel: 'WRITE APP',
    icon: 'edit_note',
    description:
      'Replaces the App-tab TSX module the preview mounts.',
  },
  runOnce: {
    humanLabel: 'RUN ONCE',
    // `play_arrow` read as a clickable button. `terminal` signals
    // "this produced terminal-style output" — pairs with the
    // terminal rendering in `OutputTab` + the runOnce drill-in.
    icon: 'terminal',
    description:
      'Deploys the current rules to the in-browser sandbox and executes the sandbox code against them.',
  },
  bash: {
    humanLabel: 'BASH',
    icon: 'terminal',
    description:
      'Runs a command in the workspace-jailed shell — coreutils plus the test / lint-rules / man builtins.',
  },
  run_workspace_tests: {
    humanLabel: 'RUN TESTS',
    icon: 'play_arrow',
    description:
      'Runs every /workspace/tests/*.test.json against the current Firestore rules and reports pass/fail per case.',
  },
  // Track-D follow-up (logged): friendly entries for the file-authoring
  // and diagnostics surfaces that previously fell through to the
  // humanized fallback.
  write_file: {
    humanLabel: 'WRITE FILE',
    icon: 'edit_note',
    description:
      'Creates or overwrites a workspace file; rules and App.tsx writes auto-deploy and auto-validate.',
  },
  edit_file: {
    humanLabel: 'EDIT FILE',
    icon: 'edit_note',
    description:
      'Applies exact targeted replacements to a workspace file through the same validation path as write_file.',
  },
  search_file: {
    humanLabel: 'SEARCH FILE',
    icon: 'search',
    description:
      'Searches one workspace file and returns compact line-numbered snippets.',
  },
  read_file: {
    humanLabel: 'READ FILE',
    icon: 'description',
    description:
      'Reads a workspace file, preferably by line range or capped preview.',
  },
  inspect_denial: {
    humanLabel: 'INSPECT DENIAL',
    icon: 'search',
    description:
      'Investigates a sandbox rules denial and correlates it with the deployed-rules match block.',
  },
};

const FALLBACK_ICON = 'extension';

/**
 * Resolve display metadata for a tool. Unknown tools get a generic
 * `extension` icon and a humanized fallback that splits the camelCase
 * identifier on case boundaries (`fooBar` → `FOO BAR`).
 */
export function toolDisplay(name: string): ToolDisplay {
  const known = DISPLAY[name];
  if (known) return known;
  const humanLabel = name
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .replace(/[_-]+/g, ' ')
    .toUpperCase();
  return {
    humanLabel,
    icon: FALLBACK_ICON,
    description: `Tool: ${name}`,
  };
}
