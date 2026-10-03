// Depth profiles, default settings, and the settings -> run configuration step.
export const LEVELS = ["beginner", "intermediate", "advanced"];

export const PROFILES = {
  quick: {
    name: "quick", queries: 3, wikiArticles: 1, webPages: 4, papersPerSource: 2, newsItems: 4, videos: 3, transcripts: 1,
    sections: ["overview", "how"], passages: 6, words: "150-250 words", glossaryTerms: 8, quizQuestions: 4,
  },
  standard: {
    name: "standard", queries: 5, wikiArticles: 2, webPages: 8, papersPerSource: 3, newsItems: 6, videos: 4, transcripts: 2,
    sections: ["overview", "how", "examples", "history", "misconceptions", "research", "news"],
    passages: 8, words: "250-400 words", glossaryTerms: 12, quizQuestions: 6,
  },
  deep: {
    name: "deep", queries: 7, wikiArticles: 3, webPages: 14, papersPerSource: 5, newsItems: 8, videos: 6, transcripts: 3,
    sections: ["overview", "how", "examples", "history", "misconceptions", "research", "news", "advanced"],
    passages: 10, words: "400-600 words", glossaryTerms: 16, quizQuestions: 8,
  },
};

export const PROVIDERS = {
  openrouter: { label: "OpenRouter", blurb: "Hosted models, including a free tier" },
  lmstudio: { label: "LM Studio", blurb: "Local server on your machine" },
  ollama: { label: "Ollama", blurb: "Local models via Ollama" },
};

export const DEFAULT_SETTINGS = {
  provider: "openrouter",
  providers: {
    openrouter: {
      apiKey: "", baseUrl: "https://openrouter.ai/api/v1", freeOnly: true, minInterval: 3, contextChars: 12000,
      models: ["openrouter/free", "nvidia/nemotron-3-ultra-550b-a55b:free"],
    },
    lmstudio: { baseUrl: "http://localhost:1234/v1", minInterval: 0, contextChars: 8000, models: [] },
    ollama: { baseUrl: "http://localhost:11434", minInterval: 0, contextChars: 8000, numCtx: 8192, models: [] },
  },
  level: "intermediate",
  depth: "standard",
  videos: true,
  transcripts: true,
  verify: true,
  useLLM: true,
  contactEmail: "",
  interests: "",
  daily: { enabled: false, time: "08:00", last: "" },
  theme: "auto",
};

const isObj = (v) => v && typeof v === "object" && !Array.isArray(v);
function merge(base, extra) {
  const out = { ...base };
  for (const [k, v] of Object.entries(extra || {})) out[k] = isObj(v) && isObj(base[k]) ? merge(base[k], v) : v;
  return out;
}

export async function loadSettings() {
  let stored = {};
  try { stored = (await chrome.storage.local.get("settings")).settings || {}; } catch { /* not in an extension */ }
  return merge(structuredClone(DEFAULT_SETTINGS), stored);
}
export async function saveSettings(settings) {
  try { await chrome.storage.local.set({ settings }); } catch { /* not in an extension */ }
}

/** Normalise a user-typed server address so both "localhost:11434" and "http://localhost:11434/v1" work. */
export function normalizeBaseUrl(type, raw) {
  let u = String(raw || "").trim();
  if (!u) return DEFAULT_SETTINGS.providers[type].baseUrl;
  if (!/^https?:\/\//i.test(u)) u = "http://" + u;
  u = u.replace(/\/+$/, "");
  if (type === "ollama") return u.replace(/\/(v1|api)$/i, "");
  if (type === "lmstudio") return /\/v1$/i.test(u) ? u : u + "/v1";
  return u;
}

/** Turn saved settings (plus any per-run overrides) into the object the pipeline reads. */
export function buildConfig(settings, overrides = {}) {
  const s = { ...settings, ...overrides };
  const type = s.provider;
  const p = s.providers[type];
  const provider = {
    type, label: PROVIDERS[type].label,
    baseUrl: normalizeBaseUrl(type, p.baseUrl),
    apiKey: type === "openrouter" ? (p.apiKey || "").trim() : "",
    models: (p.models || []).filter(Boolean),
    minIntervalMs: Math.max(0, Number(p.minInterval) || 0) * 1000,
    timeoutMs: type === "openrouter" ? 120_000 : 600_000, // local models can be slow
    numCtx: Number(p.numCtx) || 8192,
  };
  const llmAvailable = type === "openrouter" ? !!provider.apiKey && provider.models.length > 0 : provider.models.length > 0;
  return {
    provider,
    level: s.level, depth: PROFILES[s.depth] || PROFILES.standard,
    videos: !!s.videos, transcripts: !!s.videos && !!s.transcripts, verify: !!s.verify,
    contextChars: Number(p.contextChars) || 12000,
    contactEmail: (s.contactEmail || "").trim(),
    useLLM: !!s.useLLM, llmAvailable,
    cache: true,
  };
}
