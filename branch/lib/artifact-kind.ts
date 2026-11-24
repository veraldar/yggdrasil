/** What an artifact is, by its extension, and the one glyph its row shows — shared by the
 *  artifacts page and a computer's artifacts tab (/roots/[root]) so both lists read alike. */

export type ArtifactKind = 'image' | 'html' | 'md' | 'text' | 'pdf' | 'audio' | 'video';

// prettier-ignore
const KIND: Record<string, ArtifactKind> = {
  png: 'image', jpg: 'image', jpeg: 'image', gif: 'image', webp: 'image', svg: 'image',
  html: 'html',
  md: 'md',
  txt: 'text', json: 'text', csv: 'text', log: 'text', xml: 'text',
  yaml: 'text', yml: 'text', toml: 'text', ini: 'text', conf: 'text',
  css: 'text', js: 'text', mjs: 'text', ts: 'text', tsx: 'text', jsx: 'text',
  py: 'text', sh: 'text', rb: 'text', go: 'text', rs: 'text', java: 'text',
  c: 'text', h: 'text', cpp: 'text', diff: 'text', patch: 'text',
  pdf: 'pdf',
  wav: 'audio', mp3: 'audio',
  mp4: 'video',
};

export function kindOf(name: string): ArtifactKind {
  return KIND[name.split('.').pop()?.toLowerCase() || ''] || 'text';
}

export function glyphOf(name: string): string {
  const k = kindOf(name);
  if (k === 'image') return '▣';
  if (k === 'html') return '▤';
  if (k === 'audio') return '♪';
  if (k === 'video') return '♪';
  if (k === 'pdf') return '▦';
  if (k === 'md') return '¶';
  return '·';
}
