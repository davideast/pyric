import React, { useEffect, useState } from 'react';
import { useWorkspace } from '../context/WorkspaceContext';

interface ToastItem {
  id: string;
  title: string;
  body: string;
  dataJson: string;
}

export const ToastContainer: React.FC = () => {
  const { appService } = useWorkspace();
  const [toasts, setToasts] = useState<ToastItem[]>([]);

  useEffect(() => {
    const unsubscribe = appService.onPushMessage((payload: any) => {
      const toastId = `toast_${Date.now()}_${Math.floor(Math.random() * 1000)}`;
      const hasNotif = Boolean(payload.notification);
      const title = hasNotif
        ? payload.notification.title || 'Notification'
        : '📦 Silent Data Sync Payload';
      const body = hasNotif
        ? payload.notification.body
        : 'Received payload without display notification block.';
      const dataJson = payload.data ? JSON.stringify(payload.data, null, 2) : '{}';

      const item: ToastItem = {
        id: toastId,
        title: String(title),
        body: String(body || ''),
        dataJson,
      };

      setToasts((prev) => [item, ...prev]);

      setTimeout(() => {
        setToasts((prev) => prev.filter((t) => t.id !== toastId));
      }, 8000);
    });

    return () => {
      unsubscribe();
    };
  }, [appService]);

  if (toasts.length === 0) return null;

  return (
    <div className="fixed top-4 right-4 z-[100] max-w-sm w-full pointer-events-none flex flex-col gap-2.5">
      {toasts.map((toast) => (
        <div
          key={toast.id}
          className="pointer-events-auto p-4 rounded-xl bg-zinc-900 border border-zinc-700 shadow-xl text-xs text-white flex flex-col gap-2.5 select-text cursor-text transition-all duration-300"
        >
          <div className="flex items-start justify-between gap-2">
            <div className="flex items-center gap-2">
              <span className="w-2 h-2 rounded-full bg-blue-500 animate-pulse shrink-0" />
              <strong className="text-sm font-bold text-white">{toast.title}</strong>
            </div>
            <button
              type="button"
              onClick={() => setToasts((prev) => prev.filter((t) => t.id !== toast.id))}
              className="text-zinc-400 hover:text-white font-bold px-1"
            >
              &times;
            </button>
          </div>
          <p className="text-zinc-300 leading-normal">{toast.body}</p>
          <div className="flex flex-col gap-1 pt-1.5 border-t border-zinc-800 text-[11px]">
            <div className="flex justify-between font-mono font-semibold text-zinc-400">
              <span>payload.data:</span>
              <span className="text-blue-400">route: foreground</span>
            </div>
            <pre className="p-2 rounded bg-zinc-950 border border-zinc-800 font-mono text-[10px] overflow-x-auto text-zinc-200">
              {toast.dataJson}
            </pre>
          </div>
        </div>
      ))}
    </div>
  );
};
