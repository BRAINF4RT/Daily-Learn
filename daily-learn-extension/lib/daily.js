// Pick today's topic: your interests first, then Wikipedia's featured article / on-this-day / random, never repeating.
import { NULL_CACHE } from "./cache.js";
import { wikiFeed, wikiRandom, wikiSummary } from "./sources.js";

const EVERGREEN = [
  "How vaccines train the immune system", "The Fermi paradox", "How GPS works", "Plate tectonics",
  "CRISPR gene editing", "The Dunning-Kruger effect", "How noise-cancelling headphones work",
  "Game theory and the prisoner's dilemma", "The history of zero", "How the internet routes data",
  "Photosynthesis", "Black holes", "The placebo effect", "Public-key cryptography",
  "The Haber process", "How memory works in the brain", "The printing press", "Entropy",
  "Supply and demand", "The scientific method", "How batteries work", "The Cambrian explosion",
  "Bayes' theorem", "Quantum entanglement", "The Silk Road", "How airplanes fly",
  "Antibiotic resistance", "The Rosetta Stone", "Machine learning", "Coral reefs",
];
const BAD_TITLE = /^(List of|Lists of|Deaths in|Births in|Index of|Outline of|Timeline of|\d{3,4}( in|$))/i;

export function readInterests(text) {
  return String(text || "").split("\n").map((l) => l.trim()).filter((l) => l && !l.startsWith("#"));
}

const acceptable = (title, extract, kind, seen) =>
  !!title && kind !== "disambiguation" && !BAD_TITLE.test(title) && !seen.has(title.toLowerCase()) && (extract || "").length >= 200;

/** Returns [topic, why]. `seen` is a Set of lowercase topics already studied. */
export async function pickTopic(seen, interests, cache = NULL_CACHE, today = new Date()) {
  for (const interest of interests) if (!seen.has(interest.toLowerCase())) return [interest, "next unseen topic from your interests"];

  const candidates = [];
  try {
    const y = today.getFullYear(), m = String(today.getMonth() + 1).padStart(2, "0"), d = String(today.getDate()).padStart(2, "0");
    const feed = await wikiFeed(y, m, d, cache);
    if (feed.tfa?.title) candidates.push([feed.tfa.title.replace(/_/g, " "), "Wikipedia's featured article today"]);
    for (const event of feed.onthisday || []) {
      const page = (event.pages || [])[0];
      if (page?.title) candidates.push([page.title.replace(/_/g, " "), `on this day (${event.year ?? "?"})`]);
    }
  } catch (e) { if (e.name === "AbortError") throw e; }
  for (const [title, why] of candidates) {
    try {
      const info = await wikiSummary(title, cache);
      if (acceptable(info.title || title, info.extract, info.type, seen)) return [info.title || title, why];
    } catch (e) { if (e.name === "AbortError") throw e; }
  }
  for (let i = 0; i < 12; i++) {
    try {
      const info = await wikiRandom();
      if (acceptable(info.title || "", info.extract, info.type, seen)) return [info.title, "random Wikipedia article"];
    } catch (e) { if (e.name === "AbortError") throw e; break; }
  }
  const pool = EVERGREEN.filter((t) => !seen.has(t.toLowerCase()));
  const list = pool.length ? pool : EVERGREEN;
  const dayNumber = Math.floor(today.getTime() / 86400000);
  return [list[dayNumber % list.length], "evergreen list (Wikipedia was unreachable)"];
}
