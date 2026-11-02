// Every marked line breaks one factory UI rule. ui-rules.test.ts reads the markers.
import { cn } from '@/lib/utils';

export function Bad() {
  return (
    <div className="grid gap-3">
      <p className="text-[13px] text-foreground">Arbitrary size</p> {/* expect: factory-no-arbitrary-value */}
      <p className="grid-cols-[200px_1fr]">Pixel track</p> {/* expect: factory-no-arbitrary-value */}
      <aside className="w-[280px] p-4">Fixed</aside> {/* expect: factory-no-arbitrary-value factory-no-fixed-width */}
      <div className="mt-2 p-3">Margin</div> {/* expect: factory-no-margin */}
      <div className="mx-auto">Centered</div> {/* expect: factory-no-margin */}
      <div className={cn('grid', 'space-y-4')}>Stacked</div> {/* expect: factory-no-margin */}
      <div className="md:-mb-1">Negative</div> {/* expect: factory-no-margin */}
      <span className="absolute left-0 top-0">Pinned</span> {/* expect: factory-no-absolute-layout */}
      <span style={{ color: '#ff0000' }}>Red</span> {/* expect: factory-no-raw-color */}
      <span className="bg-[rgb(0,0,0)]">Black</span> {/* expect: factory-no-arbitrary-value factory-no-raw-color */}
      <select aria-label="Voice"><option>Kore</option></select> {/* expect: factory-no-native-select */}
    </div>
  );
}
