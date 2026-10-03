// Every free source. Each function returns Source objects (or throws), so one failure never stops the others.
import { NULL_CACHE } from "./cache.js";
import { FetchError, getJson, getText } from "./http.js";
import { keywordTerms, termHits } from "./ranking.js";
import { domainTrust, isBlocked } from "./trust.js";
import { isExplicitSnippet } from "./safety.js";
import { htmlToText, mapLimit } from "./util.js";

export const KIND_ORDER = ["encyclopedia", "web", "academic", "news", "video"];
export const KIND_LABELS = { encyclopedia: "Encyclopedia", web: "Web page", academic: "Research paper", news: "News", video: "Video" };

export function makeSource(o) {
  return {
    kind: "web", provider: "", title: "", url: "", text: "", date: "", authors: "", publisher: "",
    trust: 0.5, relevance: 0, id: 0, extra: {}, ...o,
  };
}
export const kindLabel = (s) => KIND_LABELS[s.kind] || s.kind;
export function domainOf(url) {
  try { const h = new URL(url).hostname.toLowerCase(); return h.startsWith("www.") ? h.slice(4) : h; } catch { return ""; }
}

const xml = (text) => new DOMParser().parseFromString(text, "text/xml");
const hasParseError = (doc) => !!doc.querySelector("parsererror");
const childText = (node, name) => {
  for (const c of node.children) if (c.localName === name) return (c.textContent || "").trim();
  return "";
};
const squash = (s) => String(s || "").replace(/\s+/g, " ").trim();
const authorsLine = (names) => {
  const n = names.filter(Boolean);
  return n.slice(0, 3).join(", ") + (n.length > 3 ? " et al." : "");
};

// ---- Wikipedia ---------------------------------------------------------------------------
const WIKI_API = "https://en.wikipedia.org/w/api.php";
const TAIL_HEADINGS = /^=+\s*(See also|References|External links|Further reading|Notes|Bibliography|Sources|Citations|Footnotes|Gallery|Awards and nominations)\s*=+\s*$/im;

export function cleanWikiExtract(text, limit = 40000) {
  let t = text || "";
  const m = TAIL_HEADINGS.exec(t);
  if (m) t = t.slice(0, m.index);
  return t.replace(/\n{3,}/g, "\n\n").trim().slice(0, limit);
}

export async function wikipediaGather(queries, maxArticles, cache = NULL_CACHE) {
  const titles = [], errors = [];
  for (const q of queries.slice(0, 2)) {
    try {
      const data = await getJson(WIKI_API, { action: "query", list: "search", srsearch: q, srlimit: maxArticles + 2, srprop: "", format: "json", origin: "*" }, { cache });
      for (const r of data.query?.search || []) if (r.title && !titles.includes(r.title)) titles.push(r.title);
    } catch (e) { if (e.name === "AbortError") throw e; errors.push(e.message); }
  }
  if (!titles.length && errors.length) throw new FetchError(errors[0]);
  const out = [];
  for (const title of titles) {
    if (out.length >= maxArticles) break;
    const data = await getJson(WIKI_API, {
      action: "query", prop: "extracts|info", explaintext: 1, inprop: "url", redirects: 1, titles: title, format: "json", origin: "*",
    }, { cache });
    for (const page of Object.values(data.query?.pages || {})) {
      const extract = cleanWikiExtract(page.extract || "");
      if (!extract || extract.slice(0, 250).toLowerCase().includes("may refer to")) continue;
      const url = page.fullurl || "https://en.wikipedia.org/wiki/" + title.replace(/ /g, "_");
      out.push(makeSource({
        kind: "encyclopedia", provider: "Wikipedia", title: page.title || title, url, text: extract,
        date: String(page.touched || "").slice(0, 10), publisher: "Wikipedia", trust: domainTrust(url),
      }));
      break;
    }
  }
  return out;
}

// ---- arXiv / OpenAlex / PubMed -----------------------------------------------------------------
export async function arxivSearch(query, n, cache = NULL_CACHE) {
  const terms = keywordTerms(query, 5);
  if (!terms.length) return [];
  const text = await getText("https://export.arxiv.org/api/query", {
    search_query: terms.map((t) => `all:${t}`).join(" AND "), start: 0, max_results: n, sortBy: "relevance",
  }, { cache });
  const doc = xml(text);
  if (hasParseError(doc)) throw new FetchError("arXiv returned invalid XML");
  const out = [];
  for (const entry of doc.getElementsByTagName("entry")) {
    const title = squash(childText(entry, "title"));
    const summary = squash(childText(entry, "summary"));
    const url = childText(entry, "id").replace("http://", "https://");
    if (!(title && summary && url)) continue;
    const names = [...entry.children].filter((c) => c.localName === "author").map((a) => childText(a, "name"));
    out.push(makeSource({
      kind: "academic", provider: "arXiv", title, url, text: summary, date: childText(entry, "published").slice(0, 10),
      authors: authorsLine(names), publisher: "arXiv (preprint, not peer-reviewed)", trust: domainTrust(url), extra: { preprint: true },
    }));
  }
  return out.slice(0, n);
}

function abstractFromIndex(inv) {
  if (!inv) return "";
  const slots = [];
  for (const [word, positions] of Object.entries(inv)) for (const p of positions || []) slots[p] = word;
  return slots.filter((w) => w !== undefined).join(" ");
}

export async function openalexSearch(query, n, cache = NULL_CACHE, email = "") {
  const params = { search: query, "per-page": n * 2, filter: "has_abstract:true" };
  if (email) params.mailto = email;
  const data = await getJson("https://api.openalex.org/works", params, { cache });
  const out = [];
  for (const work of data.results || []) {
    const title = (work.display_name || work.title || "").trim();
    const abstract = abstractFromIndex(work.abstract_inverted_index);
    const loc = work.primary_location || {};
    const url = work.doi || loc.landing_page_url || work.id || "";
    if (!(title && abstract && url)) continue;
    const names = (work.authorships || []).map((a) => a.author?.display_name || "");
    out.push(makeSource({
      kind: "academic", provider: "OpenAlex", title, url, text: abstract,
      date: String(work.publication_date || work.publication_year || ""), authors: authorsLine(names),
      publisher: loc.source?.display_name || "OpenAlex", trust: Math.max(0.8, domainTrust(url)),
      extra: { cited_by: work.cited_by_count || 0, type: work.type },
    }));
  }
  out.sort((a, b) => (b.extra.cited_by || 0) - (a.extra.cited_by || 0)); // well-cited work first
  return out.slice(0, n);
}

const EUTILS = "https://eutils.ncbi.nlm.nih.gov/entrez/eutils/";
export async function pubmedSearch(query, n, cache = NULL_CACHE, email = "") {
  const base = { tool: "daily-learn-extension" };
  if (email) base.email = email;
  const found = await getJson(EUTILS + "esearch.fcgi", { ...base, db: "pubmed", term: query, retmax: n, retmode: "json", sort: "relevance" }, { cache });
  const ids = found.esearchresult?.idlist || [];
  if (!ids.length) return [];
  const text = await getText(EUTILS + "efetch.fcgi", { ...base, db: "pubmed", id: ids.join(","), retmode: "xml" }, { cache });
  const doc = xml(text);
  if (hasParseError(doc)) throw new FetchError("PubMed returned invalid XML");
  const q = (node, sel) => node.querySelector(sel);
  const out = [];
  for (const art of doc.getElementsByTagName("PubmedArticle")) {
    const pmid = (q(art, "MedlineCitation > PMID")?.textContent || "").trim();
    const title = squash(q(art, "Article > ArticleTitle")?.textContent);
    const parts = [...art.querySelectorAll("Article > Abstract > AbstractText")].map((el) => {
      const body = squash(el.textContent);
      const label = el.getAttribute("Label");
      return label && body ? `${label[0] + label.slice(1).toLowerCase()}: ${body}` : body;
    });
    const abstract = parts.filter(Boolean).join(" ");
    if (!(pmid && title && abstract)) continue;
    const year = q(art, "Article > Journal > JournalIssue > PubDate > Year")?.textContent
      || (q(art, "Article > Journal > JournalIssue > PubDate > MedlineDate")?.textContent || "").slice(0, 4);
    const names = [...art.querySelectorAll("Article > AuthorList > Author")].map((au) => {
      const last = au.querySelector("LastName")?.textContent || "", ini = au.querySelector("Initials")?.textContent || "";
      return last ? `${last} ${ini}`.trim() : "";
    });
    const url = `https://pubmed.ncbi.nlm.nih.gov/${pmid}/`;
    out.push(makeSource({
      kind: "academic", provider: "PubMed", title, url, text: abstract, date: year || "", authors: authorsLine(names),
      publisher: q(art, "Article > Journal > Title")?.textContent || "PubMed", trust: domainTrust(url), extra: { pmid },
    }));
  }
  return out.slice(0, n);
}

// ---- News (snippets only) -------------------------------------------------------------------------
export function parseDate(value) {
  if (!value) return "";
  const text = String(value).trim();
  const g = /^(\d{4})(\d{2})(\d{2})T\d{6}Z$/.exec(text);
  if (g) return `${g[1]}-${g[2]}-${g[3]}`;
  const t = Date.parse(text);
  return Number.isNaN(t) ? "" : new Date(t).toISOString().slice(0, 10);
}

export async function googleNews(query, n, days = 30, cache = NULL_CACHE) {
  const text = await getText("https://news.google.com/rss/search", { q: `${query} when:${days}d`, hl: "en-US", gl: "US", ceid: "US:en" }, { cache, ttlHours: 6 });
  const doc = xml(text);
  if (hasParseError(doc)) throw new FetchError("Google News RSS returned invalid XML");
  const out = [];
  for (const node of doc.getElementsByTagName("item")) {
    let title = childText(node, "title");
    const link = childText(node, "link");
    if (!(title && link)) continue;
    const publisher = childText(node, "source") || "Google News";
    if (publisher !== "Google News" && title.endsWith(` - ${publisher}`)) title = title.slice(0, -publisher.length - 3).trim();
    let snippet = htmlToText(childText(node, "description"));
    if (snippet.startsWith(title)) snippet = snippet.slice(title.length).replace(/^[\s\-\u2013\u2014]+|[\s\-\u2013\u2014]+$/g, "");
    if (snippet === publisher) snippet = "";
    out.push(makeSource({
      kind: "news", provider: "Google News", title, url: link, text: snippet || title,
      date: parseDate(childText(node, "pubDate")), publisher, trust: 0.6,
    }));
    if (out.length >= n) break;
  }
  return out;
}

export async function gdelt(query, n, days = 30, cache = NULL_CACHE) {
  let data;
  try {
    data = await getJson("https://api.gdeltproject.org/api/v2/doc/doc", {
      query: `${query} sourcelang:english`, mode: "artlist", maxrecords: n, format: "json", sort: "datedesc", timespan: `${days}d`,
    }, { cache, ttlHours: 6, retries: 1 });
  } catch (e) {
    if (/HTTP 429/.test(e.message)) return []; // GDELT throttles hard; Google News already covers recent items
    throw e;
  }
  const out = [];
  for (const art of (data.articles || []).slice(0, n)) {
    const url = String(art.url || "").trim(), title = String(art.title || "").trim();
    if (!(url && title)) continue;
    out.push(makeSource({
      kind: "news", provider: "GDELT", title, url, text: title, date: parseDate(art.seendate),
      publisher: String(art.domain || "GDELT"), trust: Math.max(0.5, domainTrust(url)),
    }));
  }
  return out;
}

// ---- Web: DuckDuckGo search + page extraction --------------------------------------------------------
const TRACKING = /^(utm_|fbclid|gclid|mc_|ref$|ref_|cmpid|igshid|yclid|_hs)/i;
const DEAD_MARKERS = ["page not found", "404 not found", "access denied", "enable javascript", "verify you are human",
  "captcha", "just a moment", "are you a robot", "subscribe to continue", "this page doesn't exist"];
export const MIN_TEXT_CHARS = 600;
const MAX_TEXT_CHARS = 20000;

export function isPrivateHost(url) {
  let host;
  try { host = new URL(url).hostname.toLowerCase().replace(/^\[|\]$/g, ""); } catch { return true; }
  if (!host || host === "localhost" || /\.(local|internal|localhost)$/.test(host)) return true;
  const v4 = /^(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(host);
  if (v4) {
    const [a, b] = [Number(v4[1]), Number(v4[2])];
    return a === 10 || a === 127 || a === 0 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) || a >= 224;
  }
  return host.includes(":") && (host === "::1" || host === "::" || /^(fc|fd|fe[89ab])/.test(host));
}

export function canonicalUrl(url) {
  try {
    const u = new URL(url.trim());
    const keep = [...u.searchParams.entries()].filter(([k]) => !TRACKING.test(k));
    const q = new URLSearchParams(keep).toString();
    const host = u.host.toLowerCase().replace(/^www\./, "");
    return `${u.protocol.toLowerCase()}//${host}${u.pathname.replace(/\/+$/, "") || "/"}${q ? "?" + q : ""}`;
  } catch { return url; }
}

function ddgTarget(href) {
  try {
    const u = new URL(href, "https://duckduckgo.com");
    const real = u.searchParams.get("uddg");
    return real ? real : u.toString();
  } catch { return ""; }
}

async function ddgHtml(query, cache) {
  const html = await getText("https://html.duckduckgo.com/html/", null, {
    cache, ttlHours: 12, method: "POST", retries: 2,
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ q: query, b: "", kl: "us-en", kp: "1" }).toString(), // kp=1: strict safe search
  });
  const doc = new DOMParser().parseFromString(html, "text/html");
  const rows = [];
  for (const r of doc.querySelectorAll(".result")) {
    if (r.classList.contains("result--ad")) continue;
    const a = r.querySelector("a.result__a");
    if (!a) continue;
    rows.push({ href: ddgTarget(a.getAttribute("href") || ""), title: squash(a.textContent), body: squash(r.querySelector(".result__snippet")?.textContent) });
  }
  if (!rows.length && /anomaly|captcha|unusual traffic/i.test(doc.body?.textContent || "")) {
    throw new FetchError("DuckDuckGo is asking for a captcha (rate limited)");
  }
  return rows;
}

async function ddgLite(query, cache) {
  const html = await getText("https://lite.duckduckgo.com/lite/", null, {
    cache, ttlHours: 12, method: "POST", retries: 1,
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ q: query, kl: "us-en", kp: "1" }).toString(),
  });
  const doc = new DOMParser().parseFromString(html, "text/html");
  const rows = [];
  for (const a of doc.querySelectorAll("a.result-link")) {
    const snippet = a.closest("tr")?.nextElementSibling?.querySelector(".result-snippet");
    rows.push({ href: ddgTarget(a.getAttribute("href") || ""), title: squash(a.textContent), body: squash(snippet?.textContent) });
  }
  return rows;
}

export async function webSearch(query, n, cache = NULL_CACHE) {
  let rows = [];
  try { rows = await ddgHtml(query, cache); }
  catch (e) { if (e.name === "AbortError") throw e; rows = await ddgLite(query, cache); }
  if (!rows.length) rows = await ddgLite(query, cache);
  return rows.slice(0, n);
}

// robots.txt: honour it for politeness, even though the request comes from your own browser.
const ROBOTS = new Map();
function parseRobots(text) {
  const groups = [];
  let cur = null, lastWasAgent = false;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/#.*$/, "").trim();
    const m = /^([A-Za-z-]+)\s*:\s*(.*)$/.exec(line);
    if (!m) continue;
    const field = m[1].toLowerCase(), value = m[2].trim();
    if (field === "user-agent") {
      if (!cur || !lastWasAgent) { cur = { agents: [], rules: [] }; groups.push(cur); }
      cur.agents.push(value.toLowerCase());
      lastWasAgent = true;
    } else if ((field === "allow" || field === "disallow") && cur) {
      lastWasAgent = false;
      if (value) cur.rules.push({ allow: field === "allow", pattern: value });
    } else lastWasAgent = false;
  }
  return groups;
}
function robotsAllows(groups, path) {
  const group = groups.find((g) => g.agents.includes("daily-learn")) || groups.find((g) => g.agents.includes("*"));
  if (!group) return true;
  let best = null;
  for (const r of group.rules) {
    const rx = new RegExp("^" + r.pattern.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\\\$$/, "$"));
    if (rx.test(path) && (!best || r.pattern.length > best.pattern.length || (r.pattern.length === best.pattern.length && r.allow))) best = r;
  }
  return best ? best.allow : true;
}
async function allowedByRobots(url, cache) {
  const u = new URL(url);
  const origin = u.origin;
  if (!ROBOTS.has(origin)) {
    try {
      const text = await getText(origin + "/robots.txt", null, { cache, timeout: 6000, retries: 1, maxBytes: 300_000 });
      ROBOTS.set(origin, parseRobots(text));
    } catch (e) {
      if (e.name === "AbortError") throw e;
      ROBOTS.set(origin, null);
    }
  }
  const groups = ROBOTS.get(origin);
  return groups ? robotsAllows(groups, u.pathname + u.search) : true;
}

/** Readable text from an HTML page: title, date, and headings/paragraphs/list items of the main content. */
export function extractPage(html) {
  const doc = new DOMParser().parseFromString(html, "text/html");
  let title = squash(doc.querySelector("title")?.textContent);
  const og = doc.querySelector('meta[property="og:title"]')?.getAttribute("content");
  if (og) title = squash(og);
  let date = "";
  for (const sel of ['meta[property="article:published_time"]', 'meta[name="date"]', 'meta[name="dc.date"]']) {
    const c = doc.querySelector(sel)?.getAttribute("content");
    if (c) { date = c.slice(0, 10); break; }
  }
  if (!date) date = doc.querySelector("time[datetime]")?.getAttribute("datetime")?.slice(0, 10) || "";

  doc.querySelectorAll("script,style,nav,footer,header,aside,form,noscript,svg,iframe,button,select").forEach((n) => n.remove());
  const root = doc.querySelector("article") || doc.querySelector("main") || doc.body || doc.documentElement;
  const blocks = [], seen = new Set();
  for (const el of root.querySelectorAll("h1,h2,h3,h4,p,li")) {
    const chunk = squash(el.textContent);
    if (/^H[1-4]$/.test(el.tagName)) { if (chunk) blocks.push(`== ${chunk} ==`); }
    else if (chunk.length >= 40 && !seen.has(chunk)) { seen.add(chunk); blocks.push(chunk); }
  }
  return { title, date, text: blocks.join("\n\n") };
}

export function looksDead(text) {
  if (text.length < MIN_TEXT_CHARS) return true;
  const head = text.slice(0, 500).toLowerCase();
  return DEAD_MARKERS.some((m) => head.includes(m));
}

async function scrape(url, cache) {
  if (isPrivateHost(url) || /\.(pdf|zip|mp4|mp3|png|jpe?g)$/i.test(url.split("?")[0])) return null;
  if (!(await allowedByRobots(url, cache))) return null;
  let html;
  try { html = await getText(url, null, { cache, timeout: 12000, retries: 2, maxBytes: 1_500_000 }); }
  catch (e) { if (e.name === "AbortError") throw e; return null; }
  const page = extractPage(html);
  page.text = page.text.trim().slice(0, MAX_TEXT_CHARS);
  return looksDead(page.text) ? null : page;
}

export async function webGather(queries, topicTerms, nPages, cache = NULL_CACHE, allowExplicit = false) {
  const warnings = [], candidates = new Map();
  for (const query of queries) {
    let rows = [];
    try { rows = await webSearch(query, 8, cache); }
    catch (e) {
      if (e.name === "AbortError") throw e;
      warnings.push(`web search failed for "${query}": ${e.message}`);
      continue;
    }
    for (const row of rows) {
      const url = String(row.href || "").trim();
      if (!/^https?:/i.test(url) || isBlocked(url)) continue;
      if (!allowExplicit && isExplicitSnippet(row.title, row.body)) continue;
      const key = canonicalUrl(url);
      if (candidates.has(key)) continue;
      const overlap = termHits(topicTerms, `${row.title} ${row.body}`) / Math.max(1, topicTerms.length);
      candidates.set(key, { url, title: row.title, score: 0.5 * domainTrust(url) + 0.5 * overlap });
    }
  }
  const ranked = [...candidates.values()].sort((a, b) => b.score - a.score).slice(0, nPages * 2);
  const scraped = (await mapLimit(ranked, 4, async (c) => {
    const page = await scrape(c.url, cache);
    if (!page) return null;
    return makeSource({
      kind: "web", provider: "Web", title: page.title || c.title || c.url, url: c.url, text: page.text, date: page.date,
      publisher: domainOf(c.url), trust: domainTrust(c.url),
    });
  })).filter(Boolean);
  scraped.sort((a, b) => b.trust - a.trust);
  if (!scraped.length && ranked.length) warnings.push("web pages were found but none could be read (blocked or too short)");
  return [scraped.slice(0, nPages), warnings];
}

// ---- Videos (YouTube search page) and transcripts ------------------------------------------------------
export const EDU_CHANNELS = ["khan academy", "3blue1brown", "kurzgesagt", "crashcourse", "ted", "ted-ed", "mit opencourseware",
  "veritasium", "computerphile", "numberphile", "pbs", "pbs space time", "pbs eons", "nat geo", "national geographic", "stanford",
  "yale courses", "harvard", "the royal institution", "scishow", "minutephysics", "vsauce", "smarter every day", "practical engineering",
  "real engineering", "mit", "stanford online", "oxford mathematics", "the organic chemistry tutor", "fireship", "two minute papers",
  "sixty symbols", "periodic videos", "nova pbs", "bbc earth", "nasa", "tom scott", "wendover productions", "history matters",
  "oversimplified", "fern", "ben eater"];

export function parseDuration(value) {
  if (value == null || value === "") return 0;
  if (typeof value === "number") return Math.floor(value);
  const text = String(value).trim();
  const iso = /^PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?$/.exec(text);
  if (iso) return (Number(iso[1] || 0) * 3600) + (Number(iso[2] || 0) * 60) + Number(iso[3] || 0);
  if (/^\d+(?::\d{1,2}){1,2}$/.test(text)) return text.split(":").reduce((t, p) => t * 60 + Number(p), 0);
  return /^\d+$/.test(text) ? Number(text) : 0;
}
export function fmtDuration(seconds) {
  if (!(seconds > 0)) return "length unknown";
  const h = Math.floor(seconds / 3600), m = Math.floor((seconds % 3600) / 60), s = Math.floor(seconds % 60);
  return h ? `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}` : `${m}:${String(s).padStart(2, "0")}`;
}
export const fmtTimestamp = (seconds) => (seconds >= 1 ? fmtDuration(Math.floor(seconds)) : "0:00");
export function youtubeUrl(id, seconds) {
  const base = `https://www.youtube.com/watch?v=${id}`;
  return seconds ? `${base}&t=${Math.floor(seconds)}s` : base;
}

const runsText = (x) => (x?.simpleText ?? (x?.runs || []).map((r) => r.text).join("")) || "";

function* walk(node) {
  if (Array.isArray(node)) { for (const v of node) yield* walk(v); }
  else if (node && typeof node === "object") {
    if (node.videoRenderer) yield node.videoRenderer;
    for (const v of Object.values(node)) if (v && typeof v === "object") yield* walk(v);
  }
}

function extractJsonAfter(html, marker) {
  const at = html.indexOf(marker);
  if (at < 0) return null;
  const start = html.indexOf("{", at);
  if (start < 0) return null;
  let depth = 0, inStr = false, esc = false;
  for (let i = start; i < html.length; i++) {
    const c = html[i];
    if (inStr) { if (esc) esc = false; else if (c === "\\") esc = true; else if (c === '"') inStr = false; }
    else if (c === '"') inStr = true;
    else if (c === "{") depth++;
    else if (c === "}" && --depth === 0) { try { return JSON.parse(html.slice(start, i + 1)); } catch { return null; } }
  }
  return null;
}

export function parseYouTubeResults(html) {
  const data = extractJsonAfter(html, "ytInitialData");
  if (!data) return [];
  const out = [];
  for (const v of walk(data)) {
    const id = v.videoId, title = runsText(v.title);
    if (!id || !title) continue;
    const views = Number(String(runsText(v.viewCountText)).replace(/[^\d]/g, "")) || 0;
    const desc = (v.detailedMetadataSnippets?.[0]?.snippetText ? runsText(v.detailedMetadataSnippets[0].snippetText) : runsText(v.descriptionSnippet));
    out.push(makeSource({
      kind: "video", provider: "YouTube", title, url: youtubeUrl(id), text: desc,
      date: runsText(v.publishedTimeText), // e.g. "2 years ago": shown as-is, not guessed into a date
      publisher: runsText(v.ownerText) || runsText(v.longBylineText) || "Unknown channel", trust: 0.5,
      extra: { video_id: id, duration: parseDuration(runsText(v.lengthText)), views },
    }));
  }
  return out;
}

export async function searchVideos(queries, n, cache = NULL_CACHE) {
  const warnings = [], found = new Map();
  for (const query of queries) {
    try {
      const html = await getText("https://www.youtube.com/results", { search_query: query, hl: "en", gl: "US" },
        { cache, ttlHours: 24, credentials: "include", maxBytes: 4_000_000, timeout: 20000, retries: 2 });
      const rows = parseYouTubeResults(html);
      if (!rows.length) warnings.push(`YouTube search returned no videos for "${query}" (page layout changed or consent screen)`);
      for (const s of rows.slice(0, n + 6)) if (!found.has(s.extra.video_id)) found.set(s.extra.video_id, s);
    } catch (e) {
      if (e.name === "AbortError") throw e;
      warnings.push(`YouTube search failed: ${e.message}`);
    }
  }
  return [[...found.values()], warnings];
}

export function scoreVideo(video, topicTerms) {
  const t = Math.max(1, topicTerms.length);
  const titleHits = termHits(topicTerms, video.title) / t;
  const descHits = termHits(topicTerms, video.text.slice(0, 400)) / t;
  const secs = video.extra.duration || 0;
  let length;
  if (secs === 0) length = 0;
  else if (secs < 120) length = -0.4; // shorts and clips rarely teach much
  else if (secs >= 300 && secs <= 3600) length = 0.3;
  else if (secs <= 5400) length = 0.1;
  else length = -0.2;
  const popularity = Math.min(0.2, Math.log10((video.extra.views || 0) + 1) / 40);
  const channel = video.publisher.toLowerCase();
  const edu = EDU_CHANNELS.some((c) => c === channel || channel.includes(c)) ? 0.3 : 0;
  return 0.9 * titleHits + 0.3 * descHits + length + popularity + edu + (video.url.includes("/shorts/") ? -0.5 : 0);
}

/** Top-n by score, at most one per channel, and only videos that match the topic. */
export function pickVideos(videos, topicTerms, n) {
  const scored = [...videos].sort((a, b) => scoreVideo(b, topicTerms) - scoreVideo(a, topicTerms));
  const picked = [], channels = new Set();
  for (const v of scored) {
    if (picked.length >= n) break;
    if (termHits(topicTerms, v.title + " " + v.text.slice(0, 300)) === 0) continue;
    const d = v.extra.duration || 0;
    if ((d > 0 && d < 90) || v.url.includes("/shorts/")) continue;
    const key = v.publisher.toLowerCase();
    if (channels.has(key)) continue;
    channels.add(key);
    v.relevance = Math.round(scoreVideo(v, topicTerms) * 1000) / 1000;
    picked.push(v);
  }
  return picked;
}

// Transcripts: best effort. Uses YouTube's own caption data; falls back to the video description when unavailable.
const INNERTUBE_FALLBACK_KEY = "AIzaSyAO_FJ2SlqU8Q4STEHLGCilw_Y9_11qcW8";

function parseCaptionXml(text) {
  const doc = xml(text);
  if (hasParseError(doc)) return [];
  const out = [];
  const lines = doc.getElementsByTagName("text");
  if (lines.length) {
    for (const t of lines) out.push([Number(t.getAttribute("start")) || 0, htmlToText(t.textContent || "")]);
  } else {
    for (const p of doc.getElementsByTagName("p")) { // srv3 format: times in milliseconds
      const body = [...p.getElementsByTagName("s")].map((s) => s.textContent).join("") || p.textContent || "";
      out.push([(Number(p.getAttribute("t")) || 0) / 1000, htmlToText(body)]);
    }
  }
  return out;
}

function pickTrack(tracks) {
  const en = tracks.filter((t) => /^en/i.test(t.languageCode || ""));
  return en.find((t) => t.kind !== "asr") || en[0] || null;
}

export async function fetchTranscript(videoId, cache = NULL_CACHE) {
  const cached = await cache.get("transcript", videoId, 24 * 30);
  if (cached != null) return cached.length ? cached.map(([s, t]) => [Number(s), t]) : null;
  let tracks = null;
  try {
    const watch = await getText("https://www.youtube.com/watch", { v: videoId, hl: "en" }, { cache, credentials: "include", maxBytes: 3_000_000, retries: 1, timeout: 20000 });
    const key = /"INNERTUBE_API_KEY":"([^"]+)"/.exec(watch)?.[1] || INNERTUBE_FALLBACK_KEY;
    try {
      const body = JSON.stringify({ context: { client: { clientName: "ANDROID", clientVersion: "20.10.38" } }, videoId });
      const res = await getText(`https://www.youtube.com/youtubei/v1/player?key=${key}&prettyPrint=false`, null,
        { method: "POST", headers: { "Content-Type": "application/json" }, body, retries: 1, timeout: 20000, credentials: "omit" });
      tracks = JSON.parse(res)?.captions?.playerCaptionsTracklistRenderer?.captionTracks || null;
    } catch (e) { if (e.name === "AbortError") throw e; }
    if (!tracks?.length) {
      const player = extractJsonAfter(watch, "ytInitialPlayerResponse");
      tracks = player?.captions?.playerCaptionsTracklistRenderer?.captionTracks || null;
    }
  } catch (e) { if (e.name === "AbortError") throw e; return null; }
  const track = pickTrack(tracks || []);
  if (!track?.baseUrl) return null;
  let segments = [];
  try {
    const url = track.baseUrl.replace(/&fmt=[^&]+/, "");
    segments = parseCaptionXml(await getText(url, null, { retries: 1, timeout: 20000, credentials: "omit" }));
  } catch (e) { if (e.name === "AbortError") throw e; return null; }
  segments = segments
    .map(([s, t]) => [s, t.replace(/\[[^\]]{1,20}\]/g, " ").replace(/\s+/g, " ").trim()])
    .filter(([, t]) => t);
  await cache.set("transcript", videoId, segments);
  return segments.length ? segments : null;
}

/** '[m:ss] text' lines merged into ~30s windows; evenly thinned if too long. */
export function timestampedText(segments, maxChars = 9000, windowSec = 30) {
  const lines = [];
  let curStart = null, buf = [];
  for (const [start, text] of segments) {
    if (curStart === null) curStart = start;
    buf.push(text);
    if (start - curStart >= windowSec) { lines.push([curStart, buf.join(" ")]); curStart = null; buf = []; }
  }
  if (buf.length && curStart !== null) lines.push([curStart, buf.join(" ")]);
  let rendered = lines.map(([s, t]) => `[${fmtTimestamp(s)}] ${t}`);
  const total = rendered.reduce((n, r) => n + r.length + 1, 0);
  if (total > maxChars && rendered.length) {
    const step = Math.ceil(total / maxChars);
    rendered = rendered.filter((_, i) => i % step === 0);
  }
  return rendered.join("\n").slice(0, maxChars);
}

// ---- Wikipedia topic feed (for "surprise me") ---------------------------------------------------------------
export const wikiFeed = (y, m, d, cache) => getJson(`https://en.wikipedia.org/api/rest_v1/feed/featured/${y}/${m}/${d}`, null, { cache });
export const wikiSummary = (title, cache) => getJson(`https://en.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(title.replace(/ /g, "_"))}`, null, { cache });
export const wikiRandom = () => getJson("https://en.wikipedia.org/api/rest_v1/page/random/summary", null, { retries: 2 });
