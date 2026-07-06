/**
 * Left-panel workspace. Three top tabs:
 *
 *   Preview — the iframe App preview, full-width inside the panel
 *   Rules   — `firestore.rules` via FileEditor + the rules-lint strip
 *   Code    — whatever file is active in the Files panel, via FileEditor
 *
 * Preview leads because the App is the most-looked-at surface in the
 * playground — landing on Preview answers "is the thing I asked for
 * working" at a glance. Rules and Code follow when the user is
 * authoring. The Files panel on the right drives which file the Code
 * tab is showing; the Rules tab always points at /workspace/firestore.rules.
 *
 * On mobile, Preview ALSO exists as its own bottom-tab (`App`) so
 * users can put the iframe full-screen on a phone without navigating
 * Workspace's top tabs.
 *
 * VFS edits flow through `notifyVfsWrite`, which mirrors the two
 * known files back to the legacy workspace store so the existing
 * compile/deploy pipeline keeps working until Phase C swaps the
 * direction.
 */
import { useEffect, useRef, useState } from 'react';

import { useFilesStore, APP_ENTRY_PATH, RULES_PATH } from '~/lib/store/files';

import { AppPreview } from './AppPreview';
import { DeployChip } from './DeployChip';
import { FileEditor } from './FileEditor';
import { PanelTabs, type Tab } from './PanelTabs';
import { RulesLintStrip } from './RulesLintStrip';

type WorkspaceTabId = 'preview' | 'rules' | 'code';

const TABS: readonly Tab[] = [
  { id: 'preview', label: 'Preview' },
  { id: 'rules', label: 'Rules' },
  { id: 'code', label: 'Code' },
];

interface WorkspacePanelProps {
  /** Forwarded to AppPreview so its runtime-error view can ask the
   *  agent to repair the user's TSX in one click. */
  onFixRequest?: (prompt: string) => void;
  /** Forwarded to AppPreview so its denial banner can switch the
   *  Agent panel to the Firestore tab + Traffic sub-view. */
  onOpenDenials?: () => void;
}

export function WorkspacePanel({ onFixRequest, onOpenDenials }: WorkspacePanelProps = {}) {
  const [active, setActive] = useState<WorkspaceTabId>('preview');
  const activeFilePath = useFilesStore((s) => s.activeFilePath);
  const setActiveFilePath = useFilesStore((s) => s.setActiveFilePath);

  // Tab switches drive which file the FileEditor shows. The Files
  // panel can also drive it directly; we don't fight that — clicking
  // a file in the panel implicitly puts the user in Code-equivalent
  // territory, and switching to the Rules tab clamps it to rules.
  const handleTabChange = (id: string) => {
    const next = id as WorkspaceTabId;
    setActive(next);
    if (next === 'rules') setActiveFilePath(RULES_PATH);
    else if (next === 'code' && !activeFilePath) setActiveFilePath(APP_ENTRY_PATH);
  };

  // Track the previous activeFilePath so the sync effect only fires
  // when the file *actually* changes, not when the workspace tab
  // changes. Without this, the effect would re-run on every tab
  // click and snap users out of Preview back to Rules whenever
  // activeFilePath was still RULES_PATH from a prior Rules visit.
  const prevActiveFile = useRef(activeFilePath);
  useEffect(() => {
    if (prevActiveFile.current === activeFilePath) return;
    prevActiveFile.current = activeFilePath;
    if (!activeFilePath) return;
    // A file change is an explicit "I want to see this" intent — even
    // when the user is currently on Preview, route them to the editor
    // tab that matches the file. Rules pin → Rules tab, anything else
    // → Code tab.
    if (activeFilePath === RULES_PATH) setActive('rules');
    else setActive('code');
  }, [activeFilePath]);

  return (
    <div className="flex flex-col h-full bg-content-bg min-w-0">
      <div className="flex items-center justify-between border-b border-[#2a2a35] pr-3 shrink-0">
        <div className="flex-1 min-w-0">
          <PanelTabs tabs={TABS} activeTab={active} onTabChange={handleTabChange} />
        </div>
        <DeployChip />
      </div>
      <div className="flex-1 overflow-hidden min-h-0 flex flex-col">
        {active === 'preview' ? (
          <AppPreview
            {...(onFixRequest ? { onFixRequest } : {})}
            {...(onOpenDenials ? { onOpenDenials } : {})}
          />
        ) : active === 'rules' ? (
          <>
            <div className="flex-1 min-h-0 overflow-hidden">
              <FileEditor />
            </div>
            <RulesLintStrip />
          </>
        ) : (
          <div className="flex-1 min-h-0 overflow-hidden">
            <FileEditor />
          </div>
        )}
      </div>
    </div>
  );
}
