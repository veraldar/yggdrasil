/** Markdown → a phone-readable HTML page, rendered at SERVE time by the
 *  artifact route. This is how an owner-facing deliverable becomes HTML by
 *  construction: a session writes a plain .md into artifacts/, the owner's
 *  phone gets a styled page at /api/artifact/<name>.md — no rule to
 *  remember, no step the writer can forget. Raw-bytes consumers (the chat's
 *  inline viewer, scripts) are untouched: they fetch without a navigation
 *  destination header and still get the markdown text itself (see serve()
 *  in app/api/artifact/[name]/route.ts).
 *
 *  Phone-safe by construction, 360px viewport:
 *  - one CSS rule does the work: max-width:100% on every block element,
 *    plus overflow-wrap:anywhere as the safety net — prose and code can
 *    never push the page wider than the screen
 *  - wide content scrolls WITHIN its own box: tables and pre blocks get
 *    overflow-x:auto (never a mid-table page split, never the whole page
 *    shoved sideways)
 *  - real tap targets: headings (scroll anchors) get touch padding.
 *  No scripts, no outside fetches: CSP sandbox on the route's navigation
 *  path already bars them; the stylesheet here adds nothing active.
 */
import { Marked } from 'marked';

/** GFM (tables, task lists, strikethrough) + hard line breaks — the phone
 *  reads what a plain editor shows. sanitize: marked already escapes raw
 *  HTML in its default (non-gfm-adjacent) mode; gfm keeps inline html, and
 *  the CSP `sandbox` on the served page neutralizes it (no scripts, no
 *  forms, no same-origin). The rendering never executes anything. */
const md = new Marked({ gfm: true, breaks: true });

const CSS = `
:root{color-scheme:dark}
html{background:#080810;-webkit-text-size-adjust:100%}
body{margin:0;background:#080810;color:#e8e8f0;font:16px/1.6 ui-sans-serif,system-ui,
  -apple-system,"Segoe UI",Roboto,sans-serif;padding:14px 14px 40px;
  overflow-wrap:anywhere;word-break:normal}
h1,h2,h3,h4,h5,h6{color:#fff;line-height:1.25;margin:1.4em 0 .5em;scroll-margin-top:8px;
  padding:4px 0;overflow-wrap:anywhere}
h1{font-size:1.5em;margin-top:.4em}h2{font-size:1.25em}h3{font-size:1.1em}
h4,h5,h6{font-size:1em}
p,ul,ol,blockquote,table,pre,img,hr{max-width:100%}
p{margin:.6em 0}
a{color:#7dd3fc;text-underline-offset:3px;overflow-wrap:anywhere}
ul,ol{padding-left:1.3em;margin:.6em 0}
li{margin:.25em 0}
li>ul,li>ol{margin:.15em 0}
blockquote{margin:.8em 0;padding:.4em .9em;border-left:3px solid #3f3f5a;
  color:#b9b9cc;background:#101020;border-radius:0 8px 8px 0}
code{font:13px/1.5 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;
  background:#16162a;border-radius:5px;padding:.15em .35em;overflow-wrap:anywhere}
pre{background:#101020;border:1px solid #26263e;border-radius:10px;
  padding:12px;overflow-x:auto;-webkit-overflow-scrolling:touch;margin:.8em 0}
pre code{background:none;padding:0;white-space:pre;overflow-wrap:normal}
table{border-collapse:collapse;margin:.8em 0;display:block;overflow-x:auto;
  -webkit-overflow-scrolling:touch;max-width:100%}
th,td{border:1px solid #3f3f5a;padding:6px 10px;text-align:left;vertical-align:top;
  overflow-wrap:anywhere}
th{background:#16162a;color:#fff;white-space:nowrap}
img{max-width:100%;height:auto;border-radius:8px}
hr{border:none;border-top:1px solid #2a2a44;margin:1.4em 0}
input[type=checkbox]{width:16px;height:16px;vertical-align:-2px;margin-right:.4em}
`.replace(/\n/g, '');

const PAGE_HEAD = (title: string) =>
  `<!doctype html><html lang="en"><head><meta charset="utf-8">` +
  `<meta name="viewport" content="width=device-width,initial-scale=1">` +
  `<meta name="color-scheme" content="dark">` +
  `<title>${title}</title><style>${CSS}</style></head>\n<body>\n`;

/** Escape the markdown source for the <title>: no markup, one line. */
function plainTitle(name: string, src: string): string {
  const first = /^#[ \t]+(.+)$/m.exec(src)?.[1] ?? name.replace(/\.[a-z]+$/i, '');
  return first.replace(/[&<>"]/g, (c) => `&#${c.charCodeAt(0)};`).slice(0, 120) || name;
}

/** The rendered page for an artifact .md, wrapped bifrost-black. Throws
 *  only if the parser itself fails — the route falls back to the plain
 *  text page it already had, so a bad file still reads. */
export function renderMdPage(name: string, src: string): string {
  return PAGE_HEAD(plainTitle(name, src)) + md.parse(src, {}) + '\n</body></html>';
}
