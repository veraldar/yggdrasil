/** Server half of the file routes (/api/file/*, remote artifacts): the brain's answers passed
 *  on as they are — its status and its own words (`error`), never a rewrite of them. */
import { ocRaw } from './oc';

type Raw = Awaited<ReturnType<typeof ocRaw>>;

const JSON_HEADERS = { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' };

/** the brain's JSON answer, status and body unchanged */
export async function passJson(r: Raw): Promise<Response> {
  const text = await r.text().catch(() => '');
  let body = text;
  try {
    JSON.parse(text);
  } catch {
    body = JSON.stringify({ error: text.trim().slice(0, 300) || `the brain answered ${r.status}` });
  }
  return new Response(body, { status: r.status, headers: JSON_HEADERS });
}

export function brainDown(): Response {
  return new Response(JSON.stringify({ error: 'the brain did not answer' }), {
    status: 502,
    headers: JSON_HEADERS,
  });
}

/** `filename*` for Content-Disposition: any name, safely quoted */
export function inlineName(name: string): string {
  return `inline; filename*=UTF-8''${encodeURIComponent(name.replace(/[\r\n]/g, ' '))}`;
}
