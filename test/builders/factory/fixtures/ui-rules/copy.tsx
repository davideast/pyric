// Visible strings of each kind, for copy-check.test.ts.
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';

export function Copy() {
  return (
    <div className="grid gap-3">
      <Button>Create playlist</Button>
      <Button>Start Narration</Button>
      <button type="button">Submit</button>
      <p className="t-card-desc">Turn written structure into something that sounds natural read aloud.</p>
      <Row label="Rewrite for the ear" description="Here you can easily manage your rewrite settings." />
      <div className="rounded-lg border border-dashed p-4">
        <p>No downloads on this device yet. Save some audio. Then listen offline.</p>
      </div>
      <p>Generating music…</p>
      <input placeholder="Search downloads..." aria-label="Search downloads" />
      <p>Locked — it stays until you unlock it.</p>
      <Button onClick={() => toast.success('Playlist created.')}>Narrate again</Button>
    </div>
  );
}
