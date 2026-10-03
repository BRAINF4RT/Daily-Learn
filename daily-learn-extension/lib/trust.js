// Transparent, heuristic source-reliability scoring. A ranking rule of thumb, not a fact-check. Edit freely.
export const TRUSTED_SUFFIXES = {
  ".gov": 0.9, ".edu": 0.9, ".ac.uk": 0.9, ".gov.uk": 0.9, ".edu.au": 0.9, ".int": 0.85,
  "nih.gov": 0.95, "nasa.gov": 0.95, "who.int": 0.95, "nature.com": 0.92, "science.org": 0.92,
  "sciencedirect.com": 0.85, "springer.com": 0.85, "wiley.com": 0.85, "cell.com": 0.9,
  "thelancet.com": 0.92, "nejm.org": 0.92, "pnas.org": 0.9, "ieee.org": 0.88, "acm.org": 0.88,
  "plos.org": 0.88, "royalsociety.org": 0.9, "britannica.com": 0.85, "mayoclinic.org": 0.88,
  "khanacademy.org": 0.85, "ocw.mit.edu": 0.92, "scientificamerican.com": 0.8,
  "nationalgeographic.com": 0.8, "smithsonianmag.com": 0.8, "reuters.com": 0.85,
  "apnews.com": 0.85, "bbc.com": 0.8, "bbc.co.uk": 0.8, "npr.org": 0.8, "pbs.org": 0.8,
  "economist.com": 0.78, "nytimes.com": 0.75, "theguardian.com": 0.75, "arstechnica.com": 0.72,
  "quantamagazine.org": 0.85, "wikipedia.org": 0.75, "wikimedia.org": 0.75,
  "arxiv.org": 0.7, "pubmed.ncbi.nlm.nih.gov": 0.9, "doi.org": 0.8, "stackexchange.com": 0.6,
};
export const LOW_QUALITY = ["pinterest.com", "quora.com", "answers.com", "ehow.com", "fandom.com", "scribd.com",
  "slideshare.net", "chegg.com", "coursehero.com", "brainly.com", "ask.com"];
export const BLOCKED = ["facebook.com", "instagram.com", "tiktok.com", "x.com", "twitter.com", "linkedin.com",
  "pinterest.com", "amazon.com", "ebay.com", "etsy.com", "walmart.com", "youtube.com", "youtu.be", "reddit.com", "t.me"];
export const DEFAULT_TRUST = 0.5;

function host(url) {
  try { const h = new URL(url).hostname.toLowerCase(); return h.startsWith("www.") ? h.slice(4) : h; } catch { return ""; }
}
const matches = (h, d) => h === d || h.endsWith("." + d) || (d.startsWith(".") && h.endsWith(d));

export const isBlocked = (url) => { const h = host(url); return BLOCKED.some((d) => matches(h, d)); };

export function domainTrust(url) {
  const h = host(url);
  if (!h) return DEFAULT_TRUST;
  if (LOW_QUALITY.some((d) => matches(h, d))) return 0.2;
  let best = DEFAULT_TRUST;
  for (const [suffix, score] of Object.entries(TRUSTED_SUFFIXES)) if (matches(h, suffix)) best = Math.max(best, score);
  return best;
}
