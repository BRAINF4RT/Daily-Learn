// Small shared helpers.
export const runCtx = { signal: null }; // the current run's AbortSignal, read by http.js and llm.js

export function abortError() {
  const e = new Error("Cancelled");
  e.name = "AbortError";
  return e;
}

export const sleep = (ms, signal = runCtx.signal) =>
  new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(abortError());
    const t = setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => { clearTimeout(t); reject(abortError()); }, { once: true });
  });

export async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i], i);
    }
  });
  await Promise.all(workers);
  return out;
}

export function withTimeout(promise, ms, label = "task") {
  let timer;
  const timeout = new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`${label} timed out`)), ms); });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

export function htmlToText(html) {
  const doc = new DOMParser().parseFromString(html || "", "text/html");
  return (doc.documentElement.textContent || "").replace(/\s+/g, " ").trim();
}

const ENT = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
export const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ENT[c]);

export const todayISO = () => new Date().toISOString().slice(0, 10);

export function hostOf(url) {
  try { return new URL(url).host.toLowerCase(); } catch { return ""; }
}
