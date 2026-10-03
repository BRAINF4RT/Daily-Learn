// HTTP helpers: per-host throttling, bounded retries, caching, cancellation.
import { NULL_CACHE } from "./cache.js";
import { abortError, runCtx, sleep } from "./util.js";

export class FetchError extends Error {}

// Minimum milliseconds between requests to a host (the free APIs ask for this).
const HOST_INTERVALS = {
  "api.gdeltproject.org": 5500,
  "export.arxiv.org": 3100,
  "eutils.ncbi.nlm.nih.gov": 400,
  "api.openalex.org": 150,
  "en.wikipedia.org": 100,
  "news.google.com": 1000,
  "html.duckduckgo.com": 1500,
  "lite.duckduckgo.com": 1500,
  "www.youtube.com": 600,
};
const chains = new Map();
const lastCall = new Map();

function throttle(host) {
  const interval = HOST_INTERVALS[host] || 0;
  if (!interval) return Promise.resolve();
  const prev = chains.get(host) || Promise.resolve();
  const next = prev.then(async () => {
    const wait = interval - (Date.now() - (lastCall.get(host) || 0));
    if (wait > 0) await sleep(wait);
    lastCall.set(host, Date.now());
  }).catch(() => {});
  chains.set(host, next);
  return next;
}

function decode(buffer, contentType) {
  const m = /charset=([\w-]+)/i.exec(contentType || "");
  try { return new TextDecoder(m ? m[1] : "utf-8").decode(buffer); }
  catch { return new TextDecoder("utf-8").decode(buffer); }
}

export function withParams(url, params) {
  if (!params) return url;
  const u = new URL(url);
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== null) u.searchParams.set(k, String(v));
  return u.toString();
}

export async function getText(url, params, opts = {}) {
  const {
    cache = NULL_CACHE, ttlHours, timeout = 15000, retries = 2, headers = {}, maxBytes = 2_000_000,
    method = "GET", body, credentials = "omit",
  } = opts;
  const full = withParams(url, params);
  const key = `${method} ${full}${body ? " " + body : ""}`;
  const cached = await cache.get("http", key, ttlHours);
  if (cached != null) return cached;

  const host = new URL(full).host.toLowerCase();
  let lastErr;
  for (let attempt = 1; attempt <= retries; attempt++) {
    await throttle(host);
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(new Error("timeout")), timeout);
    const signal = runCtx.signal && AbortSignal.any ? AbortSignal.any([ac.signal, runCtx.signal]) : ac.signal;
    try {
      let response = null;
      try {
        response = await fetch(full, { method, headers, body, credentials, signal, redirect: "follow" });
      } catch (e) {
        if (runCtx.signal?.aborted) throw abortError();
        lastErr = e;
      }
      if (response) {
        const status = response.status;
        if (status === 429 || status >= 500) lastErr = new FetchError(`HTTP ${status} from ${host}`);
        else if (status >= 400) throw new FetchError(`HTTP ${status} from ${full}`);
        else {
          const buf = await response.arrayBuffer();
          const text = decode(buf.byteLength > maxBytes ? buf.slice(0, maxBytes) : buf, response.headers.get("content-type"));
          await cache.set("http", key, text);
          return text;
        }
      }
    } catch (e) {
      if (e.name === "AbortError" && runCtx.signal?.aborted) throw abortError();
      if (e instanceof FetchError) throw e;
      lastErr = e; // body read timed out or similar
    } finally {
      clearTimeout(timer);
    }
    if (attempt < retries) await sleep(1500 * attempt);
  }
  throw new FetchError(`${host} failed after ${retries} attempts: ${lastErr?.message || lastErr}`);
}

export async function getJson(url, params, opts = {}) {
  const text = await getText(url, params, opts);
  try { return JSON.parse(text); }
  catch { throw new FetchError(`${new URL(url).host} returned non-JSON: ${JSON.stringify(text.slice(0, 100))}`); }
}
