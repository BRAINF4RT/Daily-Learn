// Finalise citations (renumber to [1], [2], ...) and render Markdown, HTML and Anki. All output is escaped; links are http(s) only.
import * as citations from "./citations.js";
import { fmtDuration, fmtTimestamp, kindLabel, youtubeUrl } from "./sources.js";
import { esc } from "./util.js";

export function finalize(report) {
  const rep = structuredClone(report);
  const texts = [rep.tldr, ...rep.glossary.map(([, d]) => d), ...rep.sections.map((s) => s.body), ...rep.videos.map((v) => v.summary)];
  const mapping = citations.renumber(texts);
  rep.tldr = citations.applyMapping(rep.tldr, mapping);
  rep.glossary = rep.glossary.map(([t, d]) => [t, citations.applyMapping(d, mapping)]);
  for (const s of rep.sections) s.body = citations.applyMapping(s.body, mapping);
  for (const v of rep.videos) v.summary = citations.applyMapping(v.summary, mapping);
  const byId = new Map(rep.sources.map((s) => [s.id, s]));
  const refs = [...mapping.entries()].sort((a, b) => a[1] - b[1]).filter(([old]) => byId.has(old)).map(([old, n]) => [n, byId.get(old)]);
  const cited = new Set(refs.map(([, s]) => s.id));
  return { report: rep, refs, consulted: rep.sources.filter((s) => !cited.has(s.id)) };
}

export function safeUrl(url) {
  const u = String(url || "").trim();
  if (!/^https?:\/\//i.test(u)) return "";
  return u.replace(/[\s<>"'`()]/g, (c) => "%" + c.charCodeAt(0).toString(16).toUpperCase().padStart(2, "0"));
}
export const reliabilityLabel = (t) => (t >= 0.8 ? "high" : t >= 0.6 ? "medium" : "unverified");
export function slugify(text, limit = 60) {
  const slug = String(text).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  return slug.slice(0, limit).replace(/-+$/g, "") || "topic";
}

const videoMeta = (s) => {
  const bits = [s.publisher, fmtDuration(s.extra.duration || 0)];
  if (s.date) bits.push(s.date);
  if (s.extra.views) bits.push(`${s.extra.views.toLocaleString("en-US")} views`);
  return bits.filter(Boolean).join(" \u00b7 ");
};
const videoBasis = (v) => (v.basis === "transcript" ? "summary from the video's transcript" : "summary based on the video description only; transcript not available");

function refLine(n, s) {
  const bits = [`**${s.title}**`];
  const where = [s.publisher, s.date].filter(Boolean).join(", ");
  if (where) bits.push(`\u2014 ${where}`);
  if (s.authors) bits.push(`(${s.authors})`);
  const kind = s.provider && s.provider !== "Web" ? `${kindLabel(s)}, via ${s.provider}` : kindLabel(s);
  const link = safeUrl(s.url);
  const tail = `*${kind}; reliability (heuristic): ${reliabilityLabel(s.trust)}.*` + (link ? ` <${link}>` : "");
  return (n != null ? `${n}. ` : "- ") + bits.join(" ") + ". " + tail;
}

// ---- Markdown ----------------------------------------------------------------------------------------
export function renderMarkdown(final) {
  const r = final.report;
  const out = [`# ${r.topic}`, "", `*Learning briefing \u00b7 ${r.generatedAt} \u00b7 ${r.level} level \u00b7 ${r.depth} depth \u00b7 ${final.refs.length} sources cited*`, ""];
  if (r.tldr) out.push(("**TL;DR** " + r.tldr).split("\n").map((l) => (l.trim() ? "> " + l : ">")).join("\n"), "");
  if (r.glossary.length) out.push("## Key terms", "", ...r.glossary.map(([t, d]) => `- **${t}**: ${d}`), "");
  for (const s of r.sections) out.push(`## ${s.title}`, "", s.body, "");
  if (r.videos.length) {
    out.push("## Videos to watch", "");
    for (const v of r.videos) {
      const s = v.source;
      out.push(`### [${s.title.replace(/\[/g, "(").replace(/\]/g, ")")}](${safeUrl(s.url)})`, `*${videoMeta(s)} \u00b7 ${videoBasis(v)}*`, "", v.summary, "");
      if (v.keypoints.length) {
        out.push("Key moments:", "");
        for (const [sec, text] of v.keypoints) {
          const id = s.extra.video_id;
          out.push(`- ${id ? `[${fmtTimestamp(sec)}](${safeUrl(youtubeUrl(id, sec))})` : fmtTimestamp(sec)} ${text}`);
        }
        out.push("");
      }
    }
  }
  if (r.quiz.length) {
    out.push("## Test yourself", "");
    r.quiz.forEach(([q, a], i) => out.push(`${i + 1}. ${q}`, `   <details><summary>Answer</summary>${esc(a)}</details>`, ""));
  }
  if (r.nextTopics.length) out.push("## Where to go next", "", ...r.nextTopics.map(([t, why]) => `- **${t}**: ${why}`), "");
  out.push("## References", "");
  out.push(...(final.refs.length ? final.refs.map(([n, s]) => refLine(n, s)) : ["*No sources were cited.*"]), "");
  if (final.consulted.length) out.push("### Also consulted (retrieved but not cited in the text)", "", ...final.consulted.map((s) => refLine(null, s)), "");
  out.push("## About this briefing", "");
  const mode = r.mode === "llm" ? "Written by a language model from the retrieved sources only." : "Assembled as sourced excerpts, without a language model (none was available).";
  out.push(`- ${mode}` + (r.modelsUsed.length ? ` Models: ${r.modelsUsed.join(", ")}.` : ""),
    "- Every claim should carry a numbered citation. Citations to sources that were not provided are removed automatically. Source reliability labels are a rough domain-based heuristic, not a fact-check.",
    "- Paper entries are abstracts, not full texts. News entries are headlines and snippets.",
    "- Verify anything important against the linked sources before relying on it.");
  r.verification.forEach((l) => out.push(`- **Check:** ${l}`));
  r.warnings.forEach((l) => out.push(`- *Run note:* ${l}`));
  return out.join("\n").trimEnd() + "\n";
}

// ---- HTML --------------------------------------------------------------------------------------------
function inline(text, refs) {
  let t = esc(text);
  t = t.replace(/`([^`]+)`/g, "<code>$1</code>");
  t = t.replace(/\[([^\]]+)\]\((https?:\/\/[^)\s"']+)\)/g, '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>');
  t = t.replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>");
  t = t.replace(/(?<![*\w])\*(?!\s)(.+?)(?<!\s)\*(?![*\w])/g, "<em>$1</em>");
  return t.replace(/\[(\d+)\]/g, (m, n) => (refs.has(Number(n)) ? `<a class="cite" href="#ref-${n}">[${n}]</a>` : m));
}

/** Tiny, safe Markdown subset: paragraphs, bullet/numbered lists, bold, italics, code, links. */
export function mdToHtml(text, refs) {
  const out = [], para = [];
  let listTag = null;
  const flush = () => { if (para.length) { out.push("<p>" + inline(para.join(" "), refs) + "</p>"); para.length = 0; } };
  const close = () => { if (listTag) { out.push(`</${listTag}>`); listTag = null; } };
  for (const raw of String(text || "").split("\n")) {
    const line = raw.trimEnd();
    const bullet = /^\s*[-*\u2022]\s+(.*)$/.exec(line), number = /^\s*\d+[.)]\s+(.*)$/.exec(line);
    if (bullet || number) {
      flush();
      const tag = bullet ? "ul" : "ol";
      if (listTag !== tag) { close(); out.push(`<${tag}>`); listTag = tag; }
      out.push("<li>" + inline((bullet || number)[1], refs) + "</li>");
    } else if (!line.trim()) { flush(); close(); }
    else { close(); para.push(line.trim()); }
  }
  flush(); close();
  return out.join("\n");
}

function refItem(n, s) {
  const bits = [`<a href="${esc(safeUrl(s.url))}" target="_blank" rel="noopener noreferrer"><strong>${esc(s.title)}</strong></a>`];
  const where = [s.publisher, s.date].filter(Boolean).join(", ");
  if (where) bits.push("\u2014 " + esc(where));
  if (s.authors) bits.push(`(${esc(s.authors)})`);
  bits.push(`<span class="small">${esc(kindLabel(s))}${s.provider && s.provider !== "Web" ? " via " + esc(s.provider) : ""}; reliability (heuristic): ${reliabilityLabel(s.trust)}</span>`);
  return `<li${n != null ? ` id="ref-${n}"` : ""}>${bits.join(" ")}</li>`;
}

/** The briefing as an HTML fragment (used in the app and inside the standalone export). */
export function renderBodyHtml(final) {
  const r = final.report, refs = new Set(final.refs.map(([n]) => n));
  const parts = [`<h1>${esc(r.topic)}</h1>`,
    `<p class="meta">Learning briefing \u00b7 ${esc(r.generatedAt)} \u00b7 ${esc(r.level)} level \u00b7 ${esc(r.depth)} depth \u00b7 ${final.refs.length} sources cited</p>`];
  if (r.tldr) parts.push('<div class="tldr"><strong>TL;DR</strong> ' + inline(r.tldr.replace(/\n/g, " "), refs) + "</div>");
  if (r.glossary.length) parts.push('<h2 id="sec-terms">Key terms</h2><dl class="terms">' + r.glossary.map(([t, d]) => `<dt>${esc(t)}</dt><dd>${inline(d, refs)}</dd>`).join("") + "</dl>");
  r.sections.forEach((s) => parts.push(`<h2 id="sec-${esc(s.key)}">${esc(s.title)}</h2>${mdToHtml(s.body, refs)}`));
  if (r.videos.length) {
    parts.push('<h2 id="sec-videos">Videos to watch</h2>');
    for (const v of r.videos) {
      const s = v.source, id = s.extra.video_id;
      const block = [`<div class="video"><h3><a href="${esc(safeUrl(s.url))}" target="_blank" rel="noopener noreferrer">${esc(s.title)}</a></h3>`,
        `<p class="small">${esc(videoMeta(s))} \u00b7 ${esc(videoBasis(v))}</p>`, `<p>${inline(v.summary, refs)}</p>`];
      if (v.keypoints.length) {
        block.push("<p class='small'>Key moments</p><ul>" + v.keypoints.map(([sec, text]) => {
          const stamp = id ? `<a href="${esc(safeUrl(youtubeUrl(id, sec)))}" target="_blank" rel="noopener noreferrer">${fmtTimestamp(sec)}</a>` : fmtTimestamp(sec);
          return `<li>${stamp} ${esc(text)}</li>`;
        }).join("") + "</ul>");
      }
      block.push("</div>");
      parts.push(block.join(""));
    }
  }
  if (r.quiz.length) parts.push('<h2 id="sec-quiz">Test yourself</h2><ol>' + r.quiz.map(([q, a]) => `<li>${esc(q)}<details><summary>Answer</summary>${esc(a)}</details></li>`).join("") + "</ol>");
  if (r.nextTopics.length) parts.push('<h2 id="sec-next">Where to go next</h2><ul class="next">' + r.nextTopics.map(([t, why]) => `<li><strong>${esc(t)}</strong>: ${esc(why)}</li>`).join("") + "</ul>");
  parts.push("<h2 id=\"sec-refs\">References</h2><ol class='refs'>" + final.refs.map(([n, s]) => refItem(n, s)).join("") + "</ol>");
  if (final.consulted.length) parts.push("<h3>Also consulted (retrieved but not cited)</h3><ul class='refs'>" + final.consulted.map((s) => refItem(null, s)).join("") + "</ul>");
  const notes = ["Every claim should carry a numbered citation; citations to sources that were not provided are removed automatically. Reliability labels are a rough domain-based heuristic, not a fact-check.",
    "Paper entries are abstracts, news entries are headlines and snippets. Verify anything important against the linked sources."];
  if (r.modelsUsed.length) notes.push("Models: " + r.modelsUsed.join(", "));
  r.verification.forEach((l) => notes.push("Check: " + l));
  r.warnings.forEach((w) => notes.push("Run note: " + w));
  parts.push("<h2 id=\"sec-about\">About this briefing</h2><ul class='small'>" + notes.map((n) => `<li>${esc(n)}</li>`).join("") + "</ul>");
  return parts.join("");
}

const DOC_CSS = `:root{--bg:#fff;--fg:#1c1e21;--muted:#5b616b;--accent:#1d5fd1;--card:#f5f7fa;--line:#dde1e6}
@media (prefers-color-scheme:dark){:root{--bg:#14161a;--fg:#e6e8eb;--muted:#9aa1ab;--accent:#7fb0ff;--card:#1d2026;--line:#2d3139}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--fg);font:17px/1.65 Georgia,'Times New Roman',serif}
main{max-width:46rem;margin:0 auto;padding:2rem 1.2rem 5rem}h1{font:700 2.1rem/1.2 system-ui,sans-serif;margin:.2em 0}
h2{font:650 1.4rem/1.3 system-ui,sans-serif;margin:2.2em 0 .6em;border-bottom:1px solid var(--line);padding-bottom:.25em}
h3{font:600 1.1rem system-ui,sans-serif;margin:1.4em 0 .2em}a{color:var(--accent)}
.meta,.small{color:var(--muted);font:.85rem system-ui,sans-serif}.tldr{background:var(--card);border-left:4px solid var(--accent);padding:.8rem 1.1rem;border-radius:6px;margin:1.2rem 0}
a.cite{font:600 .75rem system-ui,sans-serif;text-decoration:none;vertical-align:super}dl.terms dt{font:600 1rem system-ui,sans-serif;margin-top:.8em}dl.terms dd{margin:.1em 0 0}
details{background:var(--card);border-radius:6px;padding:.5rem .9rem;margin:.4rem 0 1rem}summary{cursor:pointer;font:600 .9rem system-ui,sans-serif}
ol.refs li,ul.refs li{margin:.5em 0;font-size:.92rem}.video{border:1px solid var(--line);border-radius:8px;padding:.2rem 1rem 1rem;margin:1rem 0}
@media print{details{display:block}details>summary{display:none}a{color:inherit}}`;

export function renderHtml(final) {
  const r = final.report;
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">` +
    `<title>${esc(r.topic)} \u2013 learning briefing</title><style>${DOC_CSS}</style></head><body><main>${renderBodyHtml(final)}</main></body></html>`;
}

// ---- Anki / machine-readable ---------------------------------------------------------------------------
export function renderAnki(final) {
  const r = final.report, tag = slugify(r.topic, 30);
  const clean = (s) => s.replace(/\s*\[\d+\]/g, "").replace(/\t/g, " ").replace(/\n/g, "<br>");
  return ["#separator:tab", "#html:true", "#tags column:3",
    ...r.glossary.map(([t, d]) => `${esc(t)}\t${esc(clean(d))}\t${tag}`),
    ...r.quiz.map(([q, a]) => `${esc(clean(q))}\t${esc(clean(a))}\t${tag}`)].join("\n") + "\n";
}

export function sourcesJson(final) {
  const cited = new Map(final.refs.map(([n, s]) => [s.id, n]));
  const items = final.report.sources.map((s) => ({
    n: cited.get(s.id) ?? null, cited: cited.has(s.id), title: s.title, url: s.url, publisher: s.publisher, provider: s.provider,
    kind: s.kind, date: s.date, authors: s.authors, reliability_heuristic: reliabilityLabel(s.trust), retrieved: final.report.generatedAt,
  }));
  items.sort((a, b) => (a.n === null) - (b.n === null) || (a.n || 0) - (b.n || 0));
  return { topic: final.report.topic, generated: final.report.generatedAt, sources: items };
}
