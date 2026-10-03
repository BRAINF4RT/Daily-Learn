// Citation hygiene: normalise, validate, renumber and lexically fact-check.
// The model cites evidence as [S3]. Everything it writes passes through here, so a citation to a source that was
// never supplied can never reach the reader, and weakly supported sentences are flagged instead of silently trusted.
import { STOPWORDS, stem, tokens } from "./ranking.js";

const GROUP = /[\[\u3010\uff3b]\s*(S\d+(?:\s*[,;/&]\s*S\d+)*)\s*[\]\u3011\uff3d]/gi;
const ONE = /\[S(\d+)\]/g;
export const SUPPORT_THRESHOLD = 0.35;
const NUMBER = /(?<![\w.])\d[\d,]*(?:\.\d+)?(?![\w])/g;
const SENTENCE = /[^\n]+?[.!?]+(?=\s|$|\[)(?:\s*\[S\d+\])*|[^\n]+$/g;

/** Rewrite '[S1, S2]' / '【S1】' variants as '[S1][S2]'. */
export function normalize(text) {
  return String(text || "").replace(GROUP, (_, inner) => [...inner.matchAll(/S(\d+)/gi)].map((m) => `[S${m[1]}]`).join(""));
}

export const findIds = (text) => [...String(text || "").matchAll(ONE)].map((m) => Number(m[1]));

/** Remove citations to sources that were never supplied. Returns [text, removedCount]. */
export function stripInvalid(text, valid) {
  let removed = 0;
  let cleaned = normalize(text).replace(ONE, (whole, id) => {
    if (valid.has(Number(id))) return whole;
    removed++;
    return "";
  });
  cleaned = cleaned.replace(/[ \t]+([.,;:!?])/g, "$1").replace(/[ \t]{2,}/g, " ");
  return [cleaned, removed];
}

/** Map internal ids to 1..N in order of first appearance across texts. */
export function renumber(texts) {
  const mapping = new Map();
  for (const t of texts) for (const id of findIds(t)) if (!mapping.has(id)) mapping.set(id, mapping.size + 1);
  return mapping;
}

export const applyMapping = (text, mapping) =>
  String(text || "").replace(ONE, (_, id) => (mapping.has(Number(id)) ? `[${mapping.get(Number(id))}]` : ""));

function describeFlag(f) {
  const bits = [];
  if (f.missingNumbers.length) bits.push("number(s) not found in cited source: " + f.missingNumbers.join(", "));
  if (f.overlap < SUPPORT_THRESHOLD) bits.push(`low word overlap with cited source (${Math.round(f.overlap * 100)}%)`);
  const snippet = f.sentence.length <= 160 ? f.sentence : f.sentence.slice(0, 157) + "...";
  return `\u201c${snippet}\u201d \u2014 ${bits.join("; ")}`;
}

const contentTokens = (sentence) => tokens(sentence.replace(ONE, "")).filter((t) => t.length >= 4 && !STOPWORDS.has(t));

/**
 * Flag cited sentences whose words/numbers barely appear in the cited sources. A lexical heuristic, not proof:
 * paraphrase lowers overlap, and a source can contain the words without supporting the claim.
 * Returns {flags, checked}.
 */
export function supportCheck(text, sources /* Map id -> source */) {
  const flags = [];
  let checked = 0;
  const bags = new Map();
  const bag = (id) => {
    if (!bags.has(id)) {
      const body = sources.get(id)?.text || "";
      bags.set(id, [new Set(tokens(body, { keepStop: true })), body]);
    }
    return bags.get(id);
  };
  for (const paragraph of normalize(text).split(/\n+/)) {
    for (const sentence of paragraph.match(SENTENCE) || []) {
      const ids = findIds(sentence).filter((i) => sources.has(i));
      if (!ids.length) continue;
      const words = contentTokens(sentence);
      if (words.length < 5) continue;
      checked++;
      const pool = new Set();
      let raw = "";
      for (const id of ids) { const [set, body] = bag(id); set.forEach((w) => pool.add(w)); raw += " " + body; }
      const overlap = words.filter((w) => pool.has(w)).length / words.length;
      const plain = sentence.replace(ONE, "");
      const rawNoComma = raw.replace(/,/g, "");
      const missing = (plain.match(NUMBER) || []).filter((n) => n.replace(/[,.]/g, "").length >= 2 && !rawNoComma.includes(n.replace(/,/g, "")));
      if (overlap < SUPPORT_THRESHOLD || missing.length) {
        const f = { sentence: plain.trim(), ids, overlap, missingNumbers: missing.slice(0, 4) };
        f.text = describeFlag(f);
        flags.push(f);
      }
    }
  }
  return { flags, checked };
}

export { stem };
