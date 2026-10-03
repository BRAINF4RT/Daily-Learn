// One chat client, three backends:
//   openrouter  OpenAI-compatible, hosted (free models need a free key)
//   lmstudio    OpenAI-compatible, local server (default http://localhost:1234/v1)
//   ollama      native /api/chat so we can set num_ctx (Ollama's default context window is small)
// Tries a model chain in order; responses are cached so a failed run can resume without spending quota.
import { NULL_CACHE } from "./cache.js";
import { abortError, runCtx, sleep } from "./util.js";

export class LLMError extends Error {}

const THINK = /<think>[\s\S]*?<\/think>/gi;
const FENCE = /^\s*```(?:markdown|md|text)?\s*\n([\s\S]*?)\n```\s*$/;

export function cleanCompletion(text) {
  const t = String(text || "").replace(THINK, "").trim();
  const m = FENCE.exec(t);
  return (m ? m[1] : t).trim();
}

function timeoutSignal(ms) {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(new Error("timeout")), ms);
  const signal = runCtx.signal && AbortSignal.any ? AbortSignal.any([ac.signal, runCtx.signal]) : ac.signal;
  return { signal, done: () => clearTimeout(timer) };
}

async function errorDetail(response) {
  try {
    const raw = await response.text();
    try {
      const j = JSON.parse(raw);
      const msg = j?.error?.message || j?.error || j?.message;
      if (msg) return String(typeof msg === "string" ? msg : JSON.stringify(msg)).slice(0, 160);
    } catch { /* not JSON */ }
    return raw.slice(0, 160);
  } catch { return ""; }
}

export class LLM {
  constructor(provider, cache = NULL_CACHE) {
    this.p = provider;
    this.cache = cache;
    this.calls = 0;
    this.cacheHits = 0;
    this.used = new Map();
    this._last = 0;
    this._tail = Promise.resolve();
  }

  get modelsUsed() { return [...this.used.entries()].sort((a, b) => b[1] - a[1]).map(([m]) => m); }

  async complete(prompt, { system = null, maxTokens = 1600, temperature = 0.3, models = null } = {}) {
    const chain = models?.length ? models : this.p.models;
    const key = JSON.stringify([this.p.type, this.p.baseUrl, chain, system, prompt, temperature, maxTokens]);
    const cached = await this.cache.get("llm", key, 24 * 30);
    if (cached) { this.cacheHits++; return cached; }

    const messages = [];
    if (system) messages.push({ role: "system", content: system });
    messages.push({ role: "user", content: prompt });

    const errors = [];
    const retries = 2;
    for (const model of chain) {
      for (let attempt = 1; attempt <= retries; attempt++) {
        const out = await this._serial(() => this._call(model, messages, maxTokens, temperature));
        if (out.kind === "ok") {
          const text = cleanCompletion(out.text);
          if (text) {
            const name = out.served || model;
            this.used.set(name, (this.used.get(name) || 0) + 1);
            await this.cache.set("llm", key, text);
            return text;
          }
          errors.push(`${model}: empty reply`);
          break;
        }
        errors.push(`${model}: ${out.detail}`);
        if (out.kind === "skip") break; // bad model id, no credits, auth: next model
        await sleep(Math.min(2000 * attempt, 8000)); // transient: retry the same model
      }
    }
    throw new LLMError("All models failed: " + errors.slice(-6).join(" | "));
  }

  _serial(fn) { // one request at a time keeps free tiers (and small GPUs) happy
    const run = this._tail.then(fn);
    this._tail = run.catch(() => {});
    return run;
  }

  /** Returns {kind:"ok", text, served} | {kind:"retry"|"skip", detail}. */
  async _call(model, messages, maxTokens, temperature) {
    const wait = this.p.minIntervalMs - (Date.now() - this._last);
    if (wait > 0) await sleep(wait);
    if (runCtx.signal?.aborted) throw abortError();

    const { url, init, parse } = this._build(model, messages, maxTokens, temperature);
    const { signal, done } = timeoutSignal(this.p.timeoutMs);
    let response;
    try {
      response = await fetch(url, { ...init, signal });
    } catch (e) {
      if (runCtx.signal?.aborted) throw abortError();
      const why = e?.name === "AbortError" || /timeout/i.test(e?.message || "") ? "timed out" : "could not connect (is the server running?)";
      return { kind: "retry", detail: why };
    } finally {
      this._last = Date.now();
    }
    try {
      this.calls++;
      const status = response.status;
      if ([400, 401, 402, 403, 404].includes(status)) {
        const d = await errorDetail(response);
        return { kind: "skip", detail: `HTTP ${status}${d ? ": " + d : ""}` };
      }
      if (status === 429 || status >= 500) return { kind: "retry", detail: `HTTP ${status}` };
      let data;
      try { data = await response.json(); } catch { return { kind: "retry", detail: "malformed response" }; }
      if (data?.error) { // some gateways return errors with HTTP 200
        const code = Number(data.error.code) || 0;
        const msg = String(data.error.message || "error").slice(0, 160);
        return { kind: code === 429 || code >= 500 ? "retry" : "skip", detail: msg };
      }
      const out = parse(data);
      return out ? { kind: "ok", ...out } : { kind: "retry", detail: "malformed response" };
    } catch (e) {
      if (runCtx.signal?.aborted) throw abortError();
      return { kind: "retry", detail: "response interrupted" };
    } finally {
      done();
    }
  }

  _build(model, messages, maxTokens, temperature) {
    const headers = { "Content-Type": "application/json" };
    if (this.p.type === "ollama") {
      return {
        url: `${this.p.baseUrl}/api/chat`,
        init: {
          method: "POST", headers,
          body: JSON.stringify({
            model, messages, stream: false,
            options: { temperature, num_predict: maxTokens, num_ctx: this.p.numCtx },
          }),
        },
        parse: (d) => (typeof d?.message?.content === "string" ? { text: d.message.content, served: d.model || model } : null),
      };
    }
    if (this.p.apiKey) headers.Authorization = `Bearer ${this.p.apiKey}`;
    if (this.p.type === "openrouter") headers["X-Title"] = "Daily Learn";
    return {
      url: `${this.p.baseUrl}/chat/completions`,
      init: {
        method: "POST", headers,
        body: JSON.stringify({ model, messages, temperature, max_tokens: maxTokens, stream: false }),
      },
      parse: (d) => {
        const msg = d?.choices?.[0]?.message;
        if (!msg) return null;
        return { text: typeof msg.content === "string" ? msg.content : "", served: d.model || model };
      },
    };
  }
}

// ---- model discovery and connection test -----------------------------------------------

async function getJsonQuick(url, headers = {}, timeoutMs = 8000) {
  const { signal, done } = timeoutSignal(timeoutMs);
  try {
    const r = await fetch(url, { headers, signal });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return await r.json();
  } catch (e) {
    if (e?.name === "AbortError") throw new Error("timed out");
    throw e;
  } finally { done(); }
}

/** List models a provider offers. Returns [{id, label, free?, context?}]. Throws a readable Error. */
export async function listModels(provider) {
  try {
    if (provider.type === "openrouter") {
      const headers = provider.apiKey ? { Authorization: `Bearer ${provider.apiKey}` } : {};
      const data = await getJsonQuick(`${provider.baseUrl}/models`, headers, 15000);
      const list = (data.data || []).map((m) => {
        const free = String(m.id).endsWith(":free") ||
          (Number(m.pricing?.prompt) === 0 && Number(m.pricing?.completion) === 0 && m.pricing != null);
        return { id: m.id, label: m.name || m.id, free, context: m.context_length || 0 };
      });
      list.sort((a, b) => Number(b.free) - Number(a.free) || a.id.localeCompare(b.id));
      if (!list.some((m) => m.id === "openrouter/free")) list.unshift({ id: "openrouter/free", label: "OpenRouter free-model router", free: true, context: 0 });
      return list;
    }
    if (provider.type === "ollama") {
      const data = await getJsonQuick(`${provider.baseUrl}/api/tags`);
      return (data.models || []).map((m) => ({
        id: m.name, label: m.name, free: true,
        detail: [m.details?.parameter_size, m.details?.quantization_level].filter(Boolean).join(" · "),
      }));
    }
    const data = await getJsonQuick(`${provider.baseUrl}/models`);
    return (data.data || []).filter((m) => !/embed/i.test(m.id)).map((m) => ({ id: m.id, label: m.id, free: true }));
  } catch (e) {
    const msg = e?.message || String(e);
    if (/failed to fetch|networkerror|load failed/i.test(msg)) {
      throw new Error(provider.type === "openrouter" ? "Could not reach OpenRouter (check your connection)."
        : `Could not connect to ${provider.baseUrl}. Is ${provider.label} running with its local server enabled?`);
    }
    throw new Error(msg);
  }
}

/** One tiny completion against a specific model: proves the key, URL and model all work. */
export async function testModel(provider, model) {
  const llm = new LLM({ ...provider, models: [model], timeoutMs: Math.min(provider.timeoutMs, 120_000), minIntervalMs: 0 });
  const t0 = Date.now();
  const text = await llm.complete("Reply with the single word: ready", { maxTokens: 20, temperature: 0 });
  return { text: text.slice(0, 60), ms: Date.now() - t0, served: llm.modelsUsed[0] || model };
}
