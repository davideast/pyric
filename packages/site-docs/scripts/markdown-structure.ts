import GithubSlugger from 'github-slugger';

export type SourceReader = (src: string) => string;

/** Split markdown into alternating prose and fenced-code parts. */
export function splitFences(body: string): { text: string; isFence: boolean }[] {
  const parts: { text: string; isFence: boolean }[] = [];
  const lines = body.split('\n');
  let buf: string[] = [];
  let fence: string | null = null;
  let fenceBuf: string[] = [];
  for (const line of lines) {
    const open = line.match(/^\s*(```+|~~~+)/);
    if (fence === null && open) {
      parts.push({ text: buf.join('\n'), isFence: false });
      buf = [];
      fence = open[1][0].repeat(3);
      fenceBuf = [line];
    } else if (fence !== null) {
      fenceBuf.push(line);
      if (line.trim().startsWith(fence)) {
        parts.push({ text: fenceBuf.join('\n'), isFence: true });
        fenceBuf = [];
        fence = null;
      }
    } else {
      buf.push(line);
    }
  }
  if (fence !== null) parts.push({ text: fenceBuf.join('\n'), isFence: true });
  else parts.push({ text: buf.join('\n'), isFence: false });
  return parts;
}

function inlineText(md: string): string {
  return md
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/`([^`]*)`/g, '$1')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/\*([^*]+)\*/g, '$1')
    .trim();
}

export function headingsOf(src: string, readSource: SourceReader): string[] {
  const out: string[] = [];
  for (const part of splitFences(readSource(src))) {
    if (part.isFence) continue;
    for (const line of part.text.split('\n')) {
      const match = line.match(/^#{1,6}\s+(.*)$/);
      if (match) out.push(inlineText(match[1]));
    }
  }
  return out;
}

export function titleOf(src: string, readSource: SourceReader): string {
  for (const part of splitFences(readSource(src))) {
    if (part.isFence) continue;
    for (const line of part.text.split('\n')) {
      const match = line.match(/^#\s+(.*)$/);
      if (match) return inlineText(match[1]);
    }
  }
  return src.split('/').at(-1)?.replace(/\.md$/, '') ?? src;
}

export function shortTitle(title: string): string {
  return title.replace(/\s+(documentation|docs)$/i, '');
}

export function anchorsOf(src: string, readSource: SourceReader): Set<string> {
  const slugger = new GithubSlugger();
  return new Set(headingsOf(src, readSource).map((heading) => slugger.slug(heading)));
}

