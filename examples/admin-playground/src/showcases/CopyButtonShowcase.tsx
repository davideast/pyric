import { CopyButton } from '@pyric/ui/primitives';

export function CopyButtonShowcase() {
  return (
    <div className="space-y-6">
      <Block title="Default">
        <CopyButton text="users/alice" className="showcase-copy-btn" />
      </Block>
      <Block title="Custom children">
        <CopyButton text="hello-world" className="showcase-copy-btn">
          📋 Copy id
        </CopyButton>
      </Block>
      <Block title="Long text + fast reset">
        <CopyButton
          text={'the quick brown fox jumps over the lazy dog'}
          resetMs={400}
          className="showcase-copy-btn"
        >
          Copy line
        </CopyButton>
      </Block>
      <Snippet>
        {`<CopyButton text="users/alice" className="showcase-copy-btn" />`}
      </Snippet>
    </div>
  );
}

function Block({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div>
      <div className="text-[12px] text-muted-gray mb-1.5">{title}</div>
      {children}
    </div>
  );
}

function Snippet({ children }: { children: React.ReactNode }) {
  return (
    <pre className="bg-panel-bg border border-border-soft rounded p-3 text-[12px] font-mono text-soft-gray overflow-x-auto">
      {children}
    </pre>
  );
}
