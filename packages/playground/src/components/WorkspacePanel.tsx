/**
 * Left-panel workspace. Three top tabs:
 *
 *   Preview — the iframe App preview, full-width inside the panel
 *   Firebase — backend workbench for sandbox data/auth/rules/traffic/seed
 *   File    — whatever file is active in the Files panel, via FileEditor
 *
 * Firebase leads for the default expert sessions. Preview leads when
 * the prompt is explicitly app-building. The Files panel on the
 * right drives which file the File tab is showing.
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
import { useEffect, useRef } from 'react';

import { useFilesStore, APP_ENTRY_PATH, RULES_PATH } from '~/lib/store/files';
import { useWorkspaceStore } from '~/lib/store/workspace';
import type { AgentPromptProfile } from '~/lib/skills/registry';

import { AppPreview } from './AppPreview';
import { DeployChip } from './DeployChip';
import { FirebaseTab, type FirebaseTabProps } from './FirebaseTab';
import { FileEditor } from './FileEditor';
import { PanelTabs } from './PanelTabs';
import { RulesLintStrip } from './RulesLintStrip';
import { workspaceTabsForProfile, type WorkspaceTabId } from './workbench-tabs';
export type { WorkspaceTabId } from './workbench-tabs';

interface WorkspacePanelProps {
  /** Forwarded to AppPreview so its runtime-error view can ask the
   *  agent to repair the user's TSX in one click. */
  onFixRequest?: (prompt: string) => void;
  /** Forwarded to AppPreview so its denial banner can switch the
   *  Workspace panel to the Firebase Traffic sub-view. */
  onOpenDenials?: () => void;
  promptProfile?: AgentPromptProfile;
  activeTab: WorkspaceTabId;
  onTabChange: (tab: WorkspaceTabId) => void;
  firebaseProps: FirebaseTabProps;
}

export function WorkspacePanel({
  onFixRequest,
  onOpenDenials,
  promptProfile = 'firebase',
  activeTab,
  onTabChange,
  firebaseProps,
}: WorkspacePanelProps) {
  const activeFilePath = useFilesStore((s) => s.activeFilePath);
  const setActiveFilePath = useFilesStore((s) => s.setActiveFilePath);
  const previewEnabled = useWorkspaceStore((s) => s.preview.mode === 'react');
  const tabs = workspaceTabsForProfile(promptProfile, previewEnabled);
  const active = tabs.some((tab) => tab.id === activeTab)
    ? activeTab
    : (tabs[0]!.id as WorkspaceTabId);

  // Tab switches drive which file the FileEditor shows. The Files
  // panel can also drive it directly; clicking a file implicitly puts
  // the user in File territory.
  const handleTabChange = (id: string) => {
    const next = id as WorkspaceTabId;
    onTabChange(next);
    if (next === 'file' && !activeFilePath) setActiveFilePath(APP_ENTRY_PATH);
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
    // A file change is an explicit "I want to see this" intent.
    onTabChange('file');
  }, [activeFilePath, onTabChange]);

  return (
    <div className="flex flex-col h-full bg-content-bg min-w-0">
      <div className="flex items-center justify-between border-b border-[#2a2a35] pr-3 shrink-0">
        <div className="flex-1 min-w-0">
          <PanelTabs tabs={tabs} activeTab={active} onTabChange={handleTabChange} />
        </div>
        <DeployChip />
      </div>
      <div className="flex-1 overflow-hidden min-h-0 flex flex-col">
        {active === 'preview' ? (
          <AppPreview
            {...(onFixRequest ? { onFixRequest } : {})}
            {...(onOpenDenials ? { onOpenDenials } : {})}
          />
        ) : active === 'firebase' ? (
          <FirebaseTab {...firebaseProps} promptProfile={promptProfile} />
        ) : activeFilePath === RULES_PATH ? (
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
