// IndexedDB: an HTTP/LLM response cache (saves free-tier quota, lets a failed run resume) and the briefing library.
const DB_NAME = "daily-learn";
let dbPromise = null;

function openDB() {
  if (dbPromise) return dbPromise;
  if (typeof indexedDB === "undefined") return (dbPromise = Promise.resolve(null));
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains("cache")) db.createObjectStore("cache");
      if (!db.objectStoreNames.contains("reports")) db.createObjectStore("reports", { keyPath: "id" });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

function run(store, mode, make) {
  return openDB().then((db) => (!db ? undefined : new Promise((resolve, reject) => {
    const t = db.transaction(store, mode);
    const r = make(t.objectStore(store));
    t.oncomplete = () => resolve(r && r.result);
    t.onerror = t.onabort = () => reject(t.error);
  })));
}

function hash(str) { // cyrb53: short, stable keys for long URLs and prompts
  let h1 = 0xdeadbeef, h2 = 0x41c6ce57;
  for (let i = 0; i < str.length; i++) {
    const ch = str.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(36) + "-" + str.length.toString(36);
}

export class Cache {
  constructor({ enabled = true, ttlHours = 24 * 7 } = {}) {
    this.enabled = enabled;
    this.ttl = ttlHours * 3600 * 1000;
  }
  async get(ns, key, ttlHours) {
    if (!this.enabled) return null;
    try {
      const blob = await run("cache", "readonly", (s) => s.get(`${ns}:${hash(key)}`));
      if (!blob) return null;
      const ttl = ttlHours == null ? this.ttl : ttlHours * 3600 * 1000;
      return Date.now() - blob.t > ttl ? null : blob.v;
    } catch { return null; }
  }
  async set(ns, key, value) {
    if (!this.enabled) return;
    try { await run("cache", "readwrite", (s) => s.put({ t: Date.now(), v: value }, `${ns}:${hash(key)}`)); } catch { /* best effort */ }
  }
}
export const NULL_CACHE = new Cache({ enabled: false });

export async function clearCache() { await run("cache", "readwrite", (s) => s.clear()); }

export async function pruneCache(maxAgeDays = 30) {
  const db = await openDB();
  if (!db) return;
  await new Promise((resolve) => {
    const t = db.transaction("cache", "readwrite");
    const cut = Date.now() - maxAgeDays * 86400000;
    t.objectStore("cache").openCursor().onsuccess = (e) => {
      const c = e.target.result;
      if (!c) return;
      if (!c.value || c.value.t < cut) c.delete();
      c.continue();
    };
    t.oncomplete = t.onerror = t.onabort = () => resolve();
  });
}

// ---- briefing library -------------------------------------------------------------
export const saveReport = (rec) => run("reports", "readwrite", (s) => s.put(rec));
export const getReport = (id) => run("reports", "readonly", (s) => s.get(id));
export const deleteReport = (id) => run("reports", "readwrite", (s) => s.delete(id));
export async function listReports() {
  const all = (await run("reports", "readonly", (s) => s.getAll())) || [];
  return all.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
}
export async function studiedTopics() {
  return new Set((await listReports()).map((r) => (r.topic || "").toLowerCase()));
}
