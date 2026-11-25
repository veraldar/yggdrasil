/** Artifact references the chat renders as rich inline viewers. Images stay
 *  with Streamdown's markdown images; ```html fences have their own iframe
 *  path. Everything else the agent drops into artifacts/ must arrive through
 *  the chat — the user is on the phone and cannot open paths. */

export type ViewerKind = 'html' | 'md' | 'text' | 'pdf' | 'audio';

export type ArtifactRef = {
  src: string;
  kind: ViewerKind;
  name: string;
};

export const VIEWER_KIND: Record<string, ViewerKind> = {
  html: 'html',
  md: 'md',
  txt: 'text',
  json: 'text',
  csv: 'text',
  log: 'text',
  xml: 'text',
  yaml: 'text',
  yml: 'text',
  toml: 'text',
  ini: 'text',
  conf: 'text',
  css: 'text',
  js: 'text',
  mjs: 'text',
  ts: 'text',
  tsx: 'text',
  jsx: 'text',
  py: 'text',
  sh: 'text',
  rb: 'text',
  go: 'text',
  rs: 'text',
  java: 'text',
  c: 'text',
  h: 'text',
  cpp: 'text',
  diff: 'text',
  patch: 'text',
  pdf: 'pdf',
  wav: 'audio',
  mp3: 'audio',
};

/** Clean filename from an `/api/artifact/<name>?…` URL (without query params). */
export function artifactName(src: string): string {
  return src.split('?')[0].split('/').pop() || src;
}

/** Accessible label matching the artifacts gallery's corner open-in-tab button. */
export function openInNewTabLabel(name: string): string {
  return `open ${name} in new tab`;
}

/** Extract unique supported `/api/artifact/…` references from a chat message. */
export function artifactRefs(text: string): ArtifactRef[] {
  const out: ArtifactRef[] = [];
  const seen = new Set<string>();
  // the query rides along: `?root=<r>&session=<s>` names the root a session there made it on
  const re = /\/api\/artifact\/([a-zA-Z0-9][a-zA-Z0-9._-]*)(\?[^\s)\]"'<>`]*)?/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    const name = m[1];
    const ext = (name.match(/\.([a-z0-9]+)$/i)?.[1] || '').toLowerCase();
    const kind = VIEWER_KIND[ext];
    const src = `/api/artifact/${name}${(m[2] || '').replace(/[.,;:!]+$/, '')}`;
    if (kind && !seen.has(src)) {
      seen.add(src);
      out.push({ src, kind, name });
    }
  }
  return out;
}
