import type { Ref } from 'react';
import { LogIn, LogOut } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { initials } from './chat-format';
import type { UiUser } from './chat-types';

type PresenceBarProps = {
  ref?: Ref<HTMLDivElement>;
  user: UiUser | null;
  onlineCount: number;
  authLoading: boolean;
  onSignIn: () => void;
  onSignOut: () => void;
};

/** The foot of the sidebar: the signed-in user with the online count and a
 *  sign-out control, or a sign-in button. Its root element is the one the
 *  presence listener feeds. */
export function PresenceBar({ ref, user, onlineCount, authLoading, onSignIn, onSignOut }: PresenceBarProps) {
  return (
    <div ref={ref} className="border-t p-3">{user ? <div className="flex items-center gap-2"><div className="relative shrink-0"><div className="grid size-8 place-items-center rounded-full bg-primary text-xs font-semibold text-primary-foreground">{initials(user)}</div><span className="absolute -end-0.5 -bottom-0.5 size-2.5 rounded-full border-2 border-card bg-emerald-500" aria-hidden="true" /></div><div className="min-w-0 flex-1"><p className="truncate text-sm font-medium">{user.displayName ?? 'Signed in'}</p><p className="truncate text-xs text-muted-foreground">{onlineCount} online · {user.email}</p></div><Button variant="ghost" size="icon" aria-label="Sign out" onClick={onSignOut}><LogOut /></Button></div> : <Button className="w-full gap-2" onClick={onSignIn} disabled={authLoading}><LogIn /> Sign in to continue</Button>}</div>
  );
}
