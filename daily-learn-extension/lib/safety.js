// Keeps adult content out of briefings. Two layers: strict safe-search on the search requests (see sources.js),
// and this filter, which drops any source whose title/snippet/text is clearly explicit. Conservative on purpose.
// Skipped when the topic itself contains one of these words (e.g. you are studying profanity or censorship).
const EXPLICIT = new RegExp(
  "\\b(?:porn\\w*|xxx|hentai|onlyfans|blowjobs?|handjobs?|creampies?|cumshots?|gangbang\\w*|milfs?|pussy|pussies|" +
  "fuck\\w*|motherfuck\\w*|cocksuck\\w*|dildos?|sex\\s?tapes?|stepsister|stepmom|stepbro\\w*|slut\\w*|whores?|" +
  "camgirls?|bdsm|threesomes?)\\b", "gi");

const hits = (text) => (String(text || "").match(EXPLICIT) || []).length;

/** True if the topic itself is about such material, so filtering would be wrong. */
export const topicAllowsExplicit = (topic) => hits(topic) > 0;

/** Search-result level: a title or snippet with any explicit term is dropped without being fetched. */
export const isExplicitSnippet = (title, body) => hits(`${title} ${body}`) >= 1;

/** Page level: explicit term in the title, or several in the body. */
export function isExplicitSource(s) {
  if (hits(s.title) >= 1) return true;
  const head = `${s.text.slice(0, 4000)} ${s.publisher || ""}`;
  return hits(head) >= 2 || hits(s.text) >= 4;
}
