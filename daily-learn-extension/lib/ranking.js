// Tokenising, passage splitting and BM25-style passage ranking (no dependencies).
export const STOPWORDS = new Set(`
a about above after again against all also am an and any are as at be because been before being below
between both but by can could did do does doing down during each few for from further had has have having
he her here hers him his how i if in into is it its just like may me more most my no nor not now of off on
once only or other our out over own same she should so some such than that the their them then there these
they this those through to too under until up very was we were what when where which while who whom why
will with would you your yours yes`.split(/\s+/).filter(Boolean));

const WORD = /[A-Za-z0-9][A-Za-z0-9'\-]*/g;
const trimEdge = (s) => s.replace(/^[-']+|[-']+$/g, "");

/** Conservative suffix folding so 'cuts'/'cutting'/'rate'/'rates' agree. Consistent, not linguistically correct. */
export function stem(token) {
  let t = token;
  if (t.length > 3) {
    if (t.endsWith("ies")) t = t.slice(0, -3) + "y";
    else if (/(sses|xes|zes|ches|shes)$/.test(t)) t = t.slice(0, -2);
    else if (t.endsWith("s") && !/(ss|us|is)$/.test(t)) t = t.slice(0, -1);
  }
  for (const suf of ["ingly", "edly", "ing", "ed"]) {
    if (t.endsWith(suf) && t.length - suf.length >= 3) { t = t.slice(0, -suf.length); break; }
  }
  if (t.length > 3 && t.endsWith("e")) t = t.slice(0, -1);
  if (t.length > 3 && t[t.length - 1] === t[t.length - 2] && !"lsz".includes(t[t.length - 1])) t = t.slice(0, -1);
  return t;
}

export function tokens(text, { keepStop = false } = {}) {
  const out = [];
  for (const m of String(text || "").matchAll(WORD)) {
    const low = trimEdge(m[0].toLowerCase());
    if (low.length < 2 || (!keepStop && STOPWORDS.has(low))) continue;
    out.push(stem(low));
  }
  return out;
}

export function keywordTerms(text, limit = 8) {
  const seen = new Set(), out = [];
  for (const m of String(text || "").matchAll(WORD)) {
    const low = trimEdge(m[0].toLowerCase());
    if (low.length < 3 || STOPWORDS.has(low) || seen.has(low)) continue;
    seen.add(low); out.push(low);
    if (out.length >= limit) break;
  }
  return out;
}

export function termHits(terms, text) {
  const hay = new Set(tokens(text, { keepStop: true }));
  return terms.reduce((n, t) => n + (hay.has(stem(t)) ? 1 : 0), 0);
}

/** Split on blank lines / headings, then pack paragraphs up to maxChars. */
export function splitPassages(text, maxChars = 900, minChars = 120) {
  const blocks = String(text || "").split(/\n\s*\n|\n(?==+ )/).map((b) => b.trim()).filter(Boolean);
  const passages = [];
  let buf = "";
  for (let block of blocks) {
    if (/^=+ .+ =+$/.test(block)) { buf = buf ? `${buf}\n${block}` : block; continue; }
    while (block.length > maxChars) {
      let cut = block.lastIndexOf(". ", maxChars);
      cut = cut > minChars ? cut + 1 : maxChars;
      if (buf) { passages.push(buf); buf = ""; }
      passages.push(block.slice(0, cut).trim());
      block = block.slice(cut).trim();
    }
    if (buf && buf.length + block.length + 1 > maxChars) { passages.push(buf); buf = block; }
    else buf = buf ? `${buf}\n${block}` : block;
  }
  if (buf) passages.push(buf);
  return passages.filter((p) => p.length >= minChars || passages.length === 1);
}

/** BM25-ranked passages across sources, capped per source and by total size. */
export function topPassages(sources, query, k, { perSource = 3, maxChars = null } = {}) {
  const corpus = [];
  for (const s of sources) splitPassages(s.text).forEach((text, index) => corpus.push({ sourceId: s.id, index, text, score: 0 }));
  if (!corpus.length) return [];
  const qTerms = [...new Set(tokens(query))];
  const docs = corpus.map((p) => { const c = new Map(); for (const t of tokens(p.text)) c.set(t, (c.get(t) || 0) + 1); return c; });
  const lengths = docs.map((d) => [...d.values()].reduce((a, b) => a + b, 0) || 1);
  const avg = lengths.reduce((a, b) => a + b, 0) / lengths.length;
  const n = docs.length, k1 = 1.5, b = 0.75;
  for (const term of qTerms) {
    const df = docs.reduce((c, d) => c + (d.has(term) ? 1 : 0), 0);
    if (!df) continue;
    const idf = Math.log(1 + (n - df + 0.5) / (df + 0.5));
    corpus.forEach((p, i) => {
      const tf = docs[i].get(term) || 0;
      if (tf) p.score += (idf * tf * (k1 + 1)) / (tf + k1 * (1 - b + (b * lengths[i]) / avg));
    });
  }
  const chosen = [], taken = new Map();
  let total = 0;
  const order = [...corpus].sort((a, b2) => b2.score - a.score || a.sourceId - b2.sourceId || a.index - b2.index);
  for (const p of order) {
    if (p.score <= 0 && chosen.length) break;
    if ((taken.get(p.sourceId) || 0) >= perSource) continue;
    if (maxChars != null && total + p.text.length > maxChars && chosen.length) continue;
    chosen.push(p);
    taken.set(p.sourceId, (taken.get(p.sourceId) || 0) + 1);
    total += p.text.length;
    if (chosen.length >= k) break;
  }
  return chosen.sort((a, b2) => a.sourceId - b2.sourceId || a.index - b2.index);
}
