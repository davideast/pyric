import { describe, expect, it } from 'bun:test';
import { studioSectionUrl } from '../../../src/serve/runtime/studio-links.js';

describe('a Studio section address', () => {
  it('replaces the hub segment with the section and keeps the trailing slash', () => {
    expect(studioSectionUrl('/__pyric/ui/studio', 'auth')).toBe('/__pyric/ui/auth/');
    expect(studioSectionUrl('/__pyric/ui/studio/', 'traffic')).toBe('/__pyric/ui/traffic/');
    expect(studioSectionUrl('/__pyric/ui/studio', 'settings')).toBe('/__pyric/ui/settings/');
  });

  it('appends its own query after whatever query the base carried', () => {
    expect(studioSectionUrl('/__pyric/ui/studio', 'traffic', 'view=listeners'))
      .toBe('/__pyric/ui/traffic/?view=listeners');
    expect(studioSectionUrl('/__pyric/ui/studio?theme=dark', 'traffic', 'view=listeners'))
      .toBe('/__pyric/ui/traffic/?theme=dark&view=listeners');
    expect(studioSectionUrl('/__pyric/ui/studio?theme=dark', 'auth'))
      .toBe('/__pyric/ui/auth/?theme=dark');
  });

  it('treats a base that does not end at the hub as the parent of the section', () => {
    expect(studioSectionUrl('https://host/tools', 'traffic')).toBe('https://host/tools/traffic/');
  });
});
