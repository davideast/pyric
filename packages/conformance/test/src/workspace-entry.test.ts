import { describe, expect, it } from 'bun:test';
import { workspaceEntryPaths, workspaceSourceEntry } from '../../src/workspace-entry.ts';

describe('workspace entry resolution', () => {
  it('maps published workspace exports back to source for clean-checkout generation', () => {
    expect(workspaceSourceEntry('pyric/ai')).toEndWith('packages/pyric/src/ai/index.ts');
    expect(workspaceSourceEntry('pyric/messaging/sw')).toEndWith('packages/pyric/src/messaging/sw.ts');
    expect(workspaceSourceEntry('pyric-admin/messaging')).toEndWith(
      'packages/pyric-admin/src/messaging/index.ts',
    );
    expect(workspaceSourceEntry('@pyric/conformance/docs')).toBeNull();
    expect(workspaceSourceEntry('firebase/ai')).toBeNull();
  });

  it('discovers workspace package manifests instead of hard-coding mirror package names', () => {
    expect(workspaceSourceEntry('create-pyric')).toEndWith('packages/create-pyric/src/index.ts');
    expect(workspaceSourceEntry('@pyric/cli/conformance')).toEndWith('packages/cli/src/conformance/index.ts');
    expect(workspaceEntryPaths('@pyric/cli/conformance')?.built).toEndWith('packages/cli/dist/conformance/index.js');
  });
});
