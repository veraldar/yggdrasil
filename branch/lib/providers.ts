/** Provider registry + usage types and defensive normalizers for GET /provider,
 *  PUT /provider, and GET /usage. Never holds or echoes raw API keys — only key sources. */
import { normalizeEngineKey } from '@/lib/agents';

export type ProviderType =
  | 'zai'
  | 'openrouter'
  | 'ollama'
  | 'lmstudio'
  | 'vllm'
  | 'openai-compatible';

export const PROVIDER_TYPES: {
  value: ProviderType;
  label: string;
  defaultUrl: string;
  needsKey: boolean;
  local: boolean;
}[] = [
  {
    value: 'zai',
    label: 'z.ai',
    defaultUrl: 'https://api.z.ai/api/anthropic',
    needsKey: true,
    local: false,
  },
  {
    value: 'openrouter',
    label: 'OpenRouter',
    defaultUrl: 'https://openrouter.ai/api/v1',
    needsKey: true,
    local: false,
  },
  {
    value: 'ollama',
    label: 'Ollama',
    defaultUrl: 'http://127.0.0.1:11434',
    needsKey: false,
    local: true,
  },
  {
    value: 'lmstudio',
    label: 'LM Studio',
    defaultUrl: 'http://127.0.0.1:1234/v1',
    needsKey: false,
    local: true,
  },
  {
    value: 'vllm',
    label: 'vLLM',
    defaultUrl: 'http://127.0.0.1:8000/v1',
    needsKey: false,
    local: true,
  },
  {
    value: 'openai-compatible',
    label: 'other OpenAI-compatible',
    defaultUrl: 'https://api.example.com/v1',
    needsKey: true,
    local: false,
  },
];

export type ProviderInfo = {
  id: string;
  name: string;
  type: ProviderType;
  dialect: string;
  baseURL: string;
  keySource: string;
  keyResolved: boolean | null;
  models: string[];
  discovered: boolean;
  /** true = reachable, false = unreachable, null = not probed */
  reachable: boolean | null;
  latencyMs: number | null;
  lan: boolean;
  /** local / LAN providers have no external quota endpoint ("no quota") */
  noQuota: boolean;
  healthStatus: string | null;
  healthHeadline: string | null;
};

export type ProvidersState = {
  /** false when the brain returned 404 (older brain without /provider) */
  available: boolean;
  providers: ProviderInfo[];
  defaultModel: string | null;
  source: string | null;
};

export type UsageEntry = {
  pct: number | null;
  resetsAt: number | string | null;
  source: string | null;
};

export type UsageState = {
  available: boolean;
  byEngine: Record<string, UsageEntry>;
};

export function providerTypeLabel(t: string): string {
  return PROVIDER_TYPES.find((x) => x.value === t)?.label || t || 'OpenAI-compatible';
}

export function isLocalType(t: string): boolean {
  return t === 'ollama' || t === 'lmstudio' || t === 'vllm';
}

export function isLanUrl(url: string): boolean {
  if (!url) return false;
  try {
    const u = new URL(url);
    const h = u.hostname.toLowerCase();
    if (
      h === 'localhost' ||
      h === '127.0.0.1' ||
      h === '::1' ||
      h.endsWith('.local') ||
      h.endsWith('.lan') ||
      h.endsWith('.internal') ||
      h.endsWith('.ts.net') ||
      !h.includes('.')
    ) {
      return true;
    }
    if (/^10\./.test(h) || /^192\.168\./.test(h) || /^172\.(1[6-9]|2\d|3[01])\./.test(h)) {
      return true;
    }
    return false;
  } catch {
    return false;
  }
}

function inferType(raw: Record<string, unknown>, id: string, baseURL: string): ProviderType {
  const t = typeof raw.type === 'string' ? raw.type.toLowerCase().trim() : '';
  if (
    t === 'zai' ||
    t === 'openrouter' ||
    t === 'ollama' ||
    t === 'lmstudio' ||
    t === 'vllm' ||
    t === 'openai-compatible'
  ) {
    return t;
  }
  const lowId = id.toLowerCase();
  const lowUrl = baseURL.toLowerCase();
  if (lowId.includes('zai') || lowId === 'z.ai' || lowUrl.includes('z.ai')) return 'zai';
  if (lowId.includes('openrouter') || lowUrl.includes('openrouter.ai')) return 'openrouter';
  if (lowId.includes('ollama') || lowUrl.includes(':11434')) return 'ollama';
  if (lowId.includes('lmstudio') || lowUrl.includes(':1234')) return 'lmstudio';
  if (lowId.includes('vllm')) return 'vllm';
  return 'openai-compatible';
}

function extractModels(raw: Record<string, unknown>): { models: string[]; discovered: boolean } {
  const out: string[] = [];
  const push = (v: unknown) => {
    if (typeof v === 'string' && v.trim() && !out.includes(v.trim())) out.push(v.trim());
    else if (v && typeof v === 'object') {
      const id = (v as { id?: unknown }).id;
      if (typeof id === 'string' && id.trim() && !out.includes(id.trim())) out.push(id.trim());
    }
  };
  let discovered = false;
  const disc = raw.discovered ?? raw.discovered_models;
  if (Array.isArray(disc) && disc.length) {
    discovered = true;
    disc.forEach(push);
  }
  if (Array.isArray(raw.models)) {
    raw.models.forEach(push);
  } else if (raw.models && typeof raw.models === 'object') {
    Object.keys(raw.models as Record<string, unknown>).forEach(push);
  }
  if (raw.models_mode === 'auto' || raw.auto_discover === true) discovered = true;
  return { models: out, discovered };
}

function extractReachable(raw: Record<string, unknown>): {
  reachable: boolean | null;
  latencyMs: number | null;
} {
  const r = raw.reachable;
  const msField =
    typeof raw.latency_ms === 'number'
      ? raw.latency_ms
      : typeof raw.reachable_ms === 'number'
        ? raw.reachable_ms
        : null;
  if (typeof r === 'boolean') return { reachable: r, latencyMs: r ? msField : null };
  if (typeof r === 'number') return { reachable: true, latencyMs: r };
  if (r && typeof r === 'object') {
    const o = r as { ok?: unknown; reachable?: unknown; ms?: unknown; latency_ms?: unknown };
    const ok = typeof o.ok === 'boolean' ? o.ok : typeof o.reachable === 'boolean' ? o.reachable : null;
    const ms = typeof o.ms === 'number' ? o.ms : typeof o.latency_ms === 'number' ? o.latency_ms : msField;
    return { reachable: ok, latencyMs: ok ? ms : null };
  }
  if (raw.reachable === null && ('reachable' in raw || 'reachable_ms' in raw)) {
    return { reachable: false, latencyMs: null };
  }
  return { reachable: null, latencyMs: msField };
}

export function normalizeProvidersResponse(raw: unknown): ProvidersState {
  if (!raw || typeof raw !== 'object') {
    return { available: false, providers: [], defaultModel: null, source: null };
  }
  const obj = raw as Record<string, unknown>;
  const available = obj.available !== false;
  const listRaw = Array.isArray(raw) ? raw : Array.isArray(obj.providers) ? obj.providers : [];
  const healthMap =
    obj.health && typeof obj.health === 'object' ? (obj.health as Record<string, unknown>) : {};
  const reachMap =
    obj.reachability && typeof obj.reachability === 'object'
      ? (obj.reachability as Record<string, unknown>)
      : {};
  const discMap =
    obj.discovery && typeof obj.discovery === 'object'
      ? (obj.discovery as Record<string, unknown>)
      : {};

  const providers: ProviderInfo[] = [];
  for (const item of listRaw) {
    if (!item || typeof item !== 'object') continue;
    const p = item as Record<string, unknown>;
    const id = String(p.id || p.name || '').trim();
    if (!id) continue;
    const name = String(p.name || p.id || id).trim();
    const baseURL = String(p.baseURL || p.base_url || '').trim();
    const type = inferType(p, id, baseURL);
    const dialect = String(p.dialect || (type === 'zai' ? 'anthropic' : 'openai'));

    const keyObj = p.key && typeof p.key === 'object' ? (p.key as Record<string, unknown>) : null;
    const rawKeySource =
      (keyObj && typeof keyObj.source === 'string' && keyObj.source) ||
      (typeof p.key_source === 'string' && p.key_source) ||
      'none';
    const keySource = rawKeySource === 'none' && isLocalType(type) ? 'not needed' : rawKeySource;
    const keyResolved =
      keyObj && typeof keyObj.resolved === 'boolean' ? keyObj.resolved : null;

    const mergedRaw: Record<string, unknown> = {
      ...p,
      ...(discMap[id] && !p.discovered ? { discovered: discMap[id] } : {}),
      ...(reachMap[id] !== undefined && p.reachable === undefined ? { reachable: reachMap[id] } : {}),
    };
    const { models, discovered } = extractModels(mergedRaw);
    const { reachable, latencyMs } = extractReachable(mergedRaw);

    const lan =
      typeof p.lan === 'boolean'
        ? p.lan
        : typeof p.local === 'boolean'
          ? p.local
          : isLocalType(type) || isLanUrl(baseURL);
    const noQuota =
      typeof p.quota === 'boolean'
        ? !p.quota
        : typeof p.no_quota === 'boolean'
          ? p.no_quota
          : lan || isLocalType(type);

    const hRaw = (p.health && typeof p.health === 'object' ? p.health : healthMap[id]) as
      | Record<string, unknown>
      | undefined;
    const healthStatus = hRaw && typeof hRaw.status === 'string' ? hRaw.status : null;
    const healthHeadline = hRaw && typeof hRaw.headline === 'string' ? hRaw.headline : null;

    providers.push({
      id,
      name,
      type,
      dialect,
      baseURL,
      keySource,
      keyResolved,
      models,
      discovered,
      reachable,
      latencyMs,
      lan,
      noQuota,
      healthStatus,
      healthHeadline,
    });
  }

  return {
    available,
    providers,
    defaultModel: typeof obj.model === 'string' ? obj.model : null,
    source: typeof obj.source === 'string' ? obj.source : null,
  };
}

export function normalizeUsageResponse(raw: unknown): UsageState {
  if (!raw || typeof raw !== 'object') return { available: false, byEngine: {} };
  const obj = raw as Record<string, unknown>;
  if (obj.available === false) return { available: false, byEngine: {} };
  const byEngine: Record<string, UsageEntry> = {};

  const parseEntry = (val: unknown): UsageEntry | null => {
    if (!val || typeof val !== 'object') return null;
    const e = val as Record<string, unknown>;
    const pct =
      typeof e.pct === 'number' && Number.isFinite(e.pct)
        ? Math.round(e.pct)
        : typeof e.percentage === 'number' && Number.isFinite(e.percentage)
          ? Math.round(e.percentage)
          : null;
    const resetsAt =
      typeof e.resets_at === 'number' || typeof e.resets_at === 'string'
        ? e.resets_at
        : typeof e.resetsAt === 'number' || typeof e.resetsAt === 'string'
          ? e.resetsAt
          : null;
    const source = typeof e.source === 'string' ? e.source : null;
    if (pct === null && resetsAt === null && !source) return null;
    return { pct, resetsAt, source };
  };

  const add = (key: string, val: unknown) => {
    const entry = parseEntry(val);
    if (!entry) return;
    const k = key.toLowerCase().trim();
    if (k === 'zai' || k === 'z.ai' || k === 'yggdrasil') {
      byEngine.root = entry;
      byEngine.zai = entry;
    } else {
      byEngine[normalizeEngineKey(k)] = entry;
    }
  };

  if (Array.isArray(raw)) {
    for (const item of raw) {
      if (item && typeof item === 'object' && typeof (item as { engine?: unknown }).engine === 'string') {
        add((item as { engine: string }).engine, item);
      }
    }
  } else {
    const map =
      obj.usage && typeof obj.usage === 'object' && !Array.isArray(obj.usage)
        ? (obj.usage as Record<string, unknown>)
        : obj.engines && typeof obj.engines === 'object' && !Array.isArray(obj.engines)
          ? (obj.engines as Record<string, unknown>)
          : obj;
    for (const [k, v] of Object.entries(map)) {
      if (k === 'available' || k === 'error') continue;
      add(k, v);
    }
  }

  return { available: true, byEngine };
}

/** Check if a root model id belongs to a local / no-quota provider (e.g. mac-studio/qwen3.8-27b). */
export function providerForModel(
  modelId: string | null,
  providers: ProviderInfo[]
): ProviderInfo | null {
  if (!modelId) return null;
  const idx = modelId.indexOf('/');
  if (idx > 0) {
    const pid = modelId.slice(0, idx);
    const hit = providers.find((p) => p.id === pid || p.name === pid);
    if (hit) return hit;
  }
  return providers.find((p) => p.models.includes(modelId)) || null;
}

/** Format a usage percentage class color (plain semantic token). */
export function usageTone(pct: number | null): string {
  if (pct === null) return 'text-[var(--oz-dim)]';
  if (pct >= 90) return 'text-[var(--oz-danger)]';
  if (pct >= 75) return 'text-[var(--oz-active)]';
  return 'text-[var(--oz-success)]';
}
