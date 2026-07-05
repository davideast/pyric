import { useToast } from '@pyric/ui/primitives';

export function ToastShowcase() {
  const { toast } = useToast();

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap gap-3">
        <button
          className="showcase-copy-btn"
          onClick={() => toast({ title: 'Heads up', kind: 'info' })}
        >
          Info
        </button>
        <button
          className="showcase-copy-btn"
          onClick={() => toast({ title: 'Saved.', kind: 'success' })}
        >
          Success
        </button>
        <button
          className="showcase-copy-btn"
          onClick={() =>
            toast({
              title: 'Quota warning',
              body: 'You are nearing the daily write quota.',
              kind: 'warning',
            })
          }
        >
          Warning
        </button>
        <button
          className="showcase-copy-btn"
          onClick={() =>
            toast({
              title: 'Permission denied',
              body: 'rules deny write to users/alice for current auth.',
              kind: 'error',
              duration: 0,
            })
          }
        >
          Error (sticky)
        </button>
      </div>
      <pre className="bg-panel-bg border border-border-soft rounded p-3 text-[12px] font-mono text-soft-gray overflow-x-auto">{`const { toast } = useToast();
toast({
  title: 'Permission denied',
  body: 'rules deny write to users/alice',
  kind: 'error',
  duration: 0, // sticky
});`}</pre>
    </div>
  );
}
