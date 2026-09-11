import type { Ref } from 'react';
import { Bell, Code2, LoaderCircle, PanelLeftOpen } from 'lucide-react';
import { Button } from '@/components/ui/button';

type ConversationHeaderProps = {
  ref?: Ref<HTMLElement>;
  title: string;
  modeLabel?: string;
  sidebarOpen: boolean;
  onOpenSidebar: () => void;
  notificationsEnabled: boolean;
  notificationsBusy: boolean;
  notificationsDisabled: boolean;
  onEnableNotifications: () => void;
  workspaceOpen: boolean;
  onToggleWorkspace: () => void;
};

/** The header above the thread: the conversation title, the current mode, and
 *  the notification and workspace controls. Its root element is the one the
 *  active-conversation listener feeds. */
export function ConversationHeader({ ref, title, modeLabel, sidebarOpen, onOpenSidebar, notificationsEnabled, notificationsBusy, notificationsDisabled, onEnableNotifications, workspaceOpen, onToggleWorkspace }: ConversationHeaderProps) {
  return (
    <header ref={ref} className="flex h-16 shrink-0 items-center gap-3 border-b px-4 sm:px-6">{!sidebarOpen && <Button variant="ghost" size="icon" aria-label="Open conversation sidebar" onClick={onOpenSidebar}><PanelLeftOpen /></Button>}<div className="min-w-0 flex-1"><p className="truncate text-sm font-semibold">{title}</p><p className="text-xs text-muted-foreground">Private thinking space · {modeLabel}</p></div><Button variant={notificationsEnabled ? 'secondary' : 'ghost'} size="icon" aria-label={notificationsEnabled ? 'Send test notification' : 'Enable notifications'} title={notificationsEnabled ? 'Send test notification' : 'Enable notifications'} disabled={notificationsDisabled} onClick={onEnableNotifications}>{notificationsBusy ? <LoaderCircle className="animate-spin" /> : <Bell />}</Button><Button variant={workspaceOpen ? 'secondary' : 'ghost'} size="icon" aria-label={workspaceOpen ? 'Workspace open' : 'Open workspace'} title="Open workspace" onClick={onToggleWorkspace}><Code2 /></Button></header>
  );
}
