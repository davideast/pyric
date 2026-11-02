// Nothing here breaks a factory UI rule: tokens, grid track templates, variants and a marked overlay.
import { cn } from '@/lib/utils';
import { Select, SelectTrigger } from '@/components/ui/select';

export function Good() {
  return (
    <div className="grid gap-3 p-4 md:grid-cols-[minmax(0,1fr)_minmax(0,18rem)]">
      <div className="grid grid-cols-[minmax(0,1fr)_auto] gap-2">Setting</div>
      <div className="col-span-full grid grid-cols-subgrid">Row</div>
      <div className="grid-rows-[auto_1fr_auto] data-[state=open]:bg-accent">Card</div>
      <div className={cn('rounded-lg border-border bg-card text-ink-muted', '[&>svg]:size-4')}>Tokens</div>
      <div className="relative max-w-prose min-h-0">Relative is fine</div>
      {/* ui-overlay: the stretched link's hit area over the whole row */}
      <a className="absolute inset-0" href="#top">Open</a>
      <Select><SelectTrigger aria-label="Voice" /></Select>
      <p>Margins in prose such as mt-2 are not classes.</p>
    </div>
  );
}
