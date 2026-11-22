/** Roles and engines (roles rework 11-22): the brain's GET/PUT /agent/:name shape, shared
 *  by /agents (the roles page), /agents/[name] and the session settings' "what changes".
 *  The word on screen is ROLE (the brain keeps the field name `agent`). A role runs by default
 *  on an ENGINE — the root (lots to customize) or a harness: Claude Code, Antigravity, opencode,
 *  Codex, which brings its own tools — and any session can take another engine in its settings. */

export type Rule = { permission: string; pattern: string; action: string };

export type AgentDetail = {
  name: string;
  description: string;
  builtin: boolean;
  harness: string; // root | claude | opencode | codex | antigravity
  model: string | null;
  variant: string | null; // high | low | off | null (model default)
  prompt: string | null;
  prompt_lite?: string | null; // what lite models read instead (null = the prompt)
  steps: number | null;
  sessions: boolean; // manages sessions (session_* tools)
  tools: Record<string, boolean>;
  rules: Rule[] | null; // custom pattern rules — toggling a tool replaces them
  locked: string[];
  customizable: string[];
  models: string[]; // the models this root serves
  /** everything the model reads before the conversation (per tier when this root serves a lite model) */
  system?: { tier: string; models: string[]; text: string }[];
};

/** one row of GET /api/agents */
export type AgentRow = {
  name: string;
  description: string;
  harness?: string | null; // null = runs on the root
  model?: string | null;
};

export const HARNESSES = ['root', 'claude', 'opencode', 'codex', 'antigravity'] as const;
const LABEL: Record<string, string> = {
  root: 'root',
  claude: 'Claude Code',
  opencode: 'opencode',
  codex: 'Codex',
  antigravity: 'Antigravity', // Google's Antigravity CLI (agy) — it replaced Gemini CLI (11-14)
};
export const harnessLabel = (h?: string | null) => LABEL[h || 'root'] || String(h);

/** what each harness lets you set — the brain answers `customizable` for an
 *  existing agent; a new one has no answer yet */
export const CUSTOMIZABLE: Record<string, string[]> = {
  root: ['description', 'model', 'variant', 'prompt', 'tools', 'steps', 'sessions'],
  claude: ['description', 'model', 'prompt'],
  opencode: ['description', 'model'],
  codex: ['description', 'model'],
  antigravity: ['description', 'model'],
};

export const TOOLS = ['read', 'glob', 'grep', 'bash', 'write', 'edit', 'webfetch', 'todowrite'];

/** a model hint per harness (free text there — the harness knows its own) */
export const MODEL_HINT: Record<string, string> = {
  claude: 'fable · opus · sonnet · haiku',
  opencode: 'provider/model — empty = its default',
  codex: 'empty = its default',
  antigravity: 'empty = its own pick',
};

/** one row of GET /api/engines (the brain's GET /engine): what runs a session */
export type EngineRow = {
  name: string; // root | claude | antigravity | opencode | codex (in that order)
  label?: string; // root · Claude Code · Antigravity · opencode · Codex
  word?: string | null; // the grey word on a list row (none for root)
  model: string | null; // its default model (null = the engine's own pick)
  models: string[]; // the choices (["default"] = free text accepted)
  labels?: Record<string, string>; // {model: short label}
  more?: boolean; // opencode and Codex: only behind a "more engines" fold
};

/** the engines, in the brain's order; opencode and Codex stay behind a "more engines" fold */
export const ENGINES = ['root', 'claude', 'antigravity', 'opencode', 'codex'] as const;
export const MORE_ENGINES = new Set(['opencode', 'codex']);
/** an engine's name on screen: root · Claude Code · Antigravity · opencode · Codex */
export const engineLabel = harnessLabel;
const WORD: Record<string, string> = {
  claude: 'claude',
  antigravity: 'agy',
  opencode: 'opencode',
  codex: 'codex',
};
/** the small grey word at the right of a list row: the engine (none on the root) */
export const engineWord = (e?: string | null) => (e && WORD[e]) || '';
/** what each engine is, in one line (the roles page's engines block) */
export const ENGINE_NOTE: Record<string, string> = {
  root: "this computer's own models · tools checked by the brain",
  claude: "Anthropic's CLI · its own tools · 5-hour quota",
  antigravity: "Google's CLI · its own tools and quota",
  opencode: 'its own tools and providers',
  codex: "OpenAI's CLI · its own tools",
};

type HarnessLike = { kind?: unknown; attached?: unknown } | string | null | undefined;
/** the owner's own terminal conversation, continued here: a list row carries its kind as
 *  `harness` (null otherwise), a session summary the brain's {kind, attached} */
export const isAttached = (h: HarnessLike) =>
  typeof h === 'string' ? !!h : !!h && typeof h === 'object' && h.attached === true;

/** the engine a brain session runs on: its `engine`, else (a proxy of an older root) the
 *  harness kind — attached or not — else the root */
export function engineOf(s: { engine?: unknown; harness?: unknown }): string {
  if (typeof s.engine === 'string' && s.engine) return s.engine;
  const h = s.harness && typeof s.harness === 'object' ? (s.harness as { kind?: unknown }) : null;
  return typeof h?.kind === 'string' && h.kind ? h.kind : 'root';
}

/** an old root may still name a role `claude` / `agy`: those were engines, the work was a build */
const LEGACY = new Set(['claude', 'agy', 'agi']);
export const roleOf = (agent?: string | null) =>
  !agent || LEGACY.has(agent.toLowerCase()) ? 'build' : agent;

const firstLine = (s: string | null) => {
  const l = (s || '').trim().split('\n')[0] || '';
  return l.length > 60 ? `${l.slice(0, 59)}…` : l;
};

const toolsOn = (d: AgentDetail | null) => TOOLS.filter((t) => d?.tools?.[t]);

/** What a session taking role `to` changes, as [what, how] rows — shown before the switch.
 *  The role: the engine stays (the brain's POST /api/session/:id/agent), and so does the model —
 *  except when the session already runs on the new role's default engine and that role names a
 *  model (on the root: or a thinking level): then it takes the role's. `cur` = the role it has
 *  now (null: none — a terminal conversation); `engine` = what it runs on; `run` = its model now;
 *  `shared` = it reads only the shared prompt (a relabelled old session, a terminal
 *  conversation), so it starts reading the role's instructions. */
export function roleDiff(
  cur: AgentDetail | null,
  to: AgentDetail,
  engine: string,
  run: { modelID: string; variant: string | null } | null,
  shared: boolean
): [string, string][] {
  const rows: [string, string][] = [];
  rows.push(['role', `${cur?.name || 'none'} → ${to.name}`]);
  rows.push(['runs on', `${engineLabel(engine)} (unchanged)`]);
  if ((to.harness || 'root') === engine) {
    const was = run?.modelID || 'default';
    if (to.model && to.model !== was) rows.push(['model', `${was} → ${to.model}`]);
    const level = run?.variant || 'default';
    if (engine === 'root' && to.variant && to.variant !== level)
      rows.push(['thinking', `${level} → ${to.variant}`]);
  }
  const now = firstLine(to.prompt) || 'none';
  if (shared) rows.push(['instructions', `the shared prompt only → ${now}`]);
  else if ((cur?.prompt || '') !== (to.prompt || ''))
    rows.push(['instructions', `${now} — changed`]);
  const s = (d: AgentDetail | null) => (d?.sessions ? 'starts sub-sessions' : 'no');
  if (s(cur) !== s(to)) rows.push(['sessions', `${s(cur)} → ${s(to)}`]);
  if (engine === 'root') {
    const was = toolsOn(cur);
    const tools = toolsOn(to);
    const moves = [
      ...tools.filter((t) => !was.includes(t)).map((t) => `+${t}`),
      ...was.filter((t) => !tools.includes(t)).map((t) => `−${t}`),
    ];
    if (moves.length) rows.push(['tools', moves.join(' ')]);
  }
  return rows;
}

/** The model a session gets when it moves to engine `to` (the contract's rule): the role's own
 *  model when the role's default engine is that engine, else the engine's default. */
export function engineModel(
  role: Pick<AgentDetail, 'harness' | 'model'> | null,
  to: EngineRow | null,
  name: string
) {
  if (role && (role.harness || 'root') === name && role.model) return role.model;
  return to?.model || 'default';
}

/** What moving a session to engine `to` changes, as [what, how] rows — shown before the switch,
 *  always with the fresh-start warning (ENGINE_FRESH). The role stays. */
export function engineDiff(
  role: AgentDetail | null,
  roleName: string,
  from: string,
  to: string,
  fromModel: string,
  engines: EngineRow[]
): [string, string][] {
  const row = engines.find((e) => e.name === to) || null;
  const rows: [string, string][] = [
    ['role', `${roleName || 'none'} (unchanged)`],
    ['runs on', `${engineLabel(from)} → ${engineLabel(to)}`],
  ];
  const model = engineModel(role, row, to);
  if (model !== fromModel) rows.push(['model', `${fromModel || 'default'} → ${model}`]);
  const own = (e: string) =>
    e !== 'root'
      ? `${engineLabel(e)}'s own`
      : role
        ? `the root's: ${toolsOn(role).join(' ') || 'none'}`
        : "the root's";
  rows.push(['tools', from === to ? own(to) : `${own(from)} → ${own(to)}`]);
  if (to === 'root' && role?.sessions) rows.push(['sessions', 'starts sub-sessions directly']);
  return rows;
}

export const ENGINE_FRESH =
  '⚠ the new engine starts fresh: it sees only new messages, not this conversation';

/** a role's three-letter tag: LEA(d), BUI(ld), FIX, REV(iew), RES(earch), a custom one's first
 *  three letters — and the coordinator's is MAI wherever it shows (MAIN here, a proxy of another
 *  root's MAIN, the roles page) */
export const agentTag = (agent: string) =>
  agent === 'coordinator'
    ? 'MAI'
    : agent
        .replace(/[^a-z0-9]/gi, '')
        .slice(0, 3)
        .toUpperCase();

/** the built-in roles in the order the owner reads them (the mockup's); a custom one after */
const ROLE_ORDER = ['coordinator', 'lead', 'build', 'fix', 'review', 'research'];
export const byRole = (a: { name: string }, b: { name: string }) => {
  const i = (n: string) => (ROLE_ORDER.includes(n) ? ROLE_ORDER.indexOf(n) : ROLE_ORDER.length);
  return i(a.name) - i(b.name) || a.name.localeCompare(b.name);
};

/** a role's badge (an old root's `claude` / `agy` read as build) */
export const roleTag = (role: string) => agentTag(roleOf(role));

/** the /cc terminal page's tags: that page is about engines (CLA · AGY · OPE · COD) */
export const HARNESS_TAG: Record<string, string> = {
  claude: 'CLA',
  antigravity: 'AGY',
  opencode: 'OPE',
  codex: 'COD',
};

/** every row carries one (roles rework 11-22): the badge is the ROLE, never the engine.
 *  MAIN is MAI; the owner's own terminal conversation is TRM (never hired for a job); else
 *  the role's (LEA · BUI · FIX · REV · RES · a custom one's first three letters). */
export const sessionTag = (s: { agent?: string | null; harness?: HarnessLike }, isMain = false) =>
  isMain ? 'MAI' : isAttached(s.harness) ? 'TRM' : agentTag(roleOf(s.agent));
