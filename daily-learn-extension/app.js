import { Cache, clearCache, deleteReport, getReport, listReports, pruneCache, saveReport, studiedTopics } from "./lib/cache.js";
import { LEVELS, PROFILES, PROVIDERS, buildConfig, loadSettings, normalizeBaseUrl, saveSettings } from "./lib/config.js";
import { pickTopic, readInterests } from "./lib/daily.js";
import { listModels, testModel } from "./lib/llm.js";
import { applyNetRules } from "./lib/netrules.js";
import { generateBriefing } from "./lib/pipeline.js";
import { finalize, renderAnki, renderBodyHtml, renderHtml, renderMarkdown, slugify, sourcesJson } from "./lib/render.js";
import { runCtx, todayISO } from "./lib/util.js";

const $ = (sel, root = document) => root.querySelector(sel);

/** Tiny DOM builder. Text children are always text nodes, never HTML. */
function h(tag, attrs = {}, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v === false || v == null) continue;
    if (k === "class") el.className = v;
    else if (k.startsWith("on") && typeof v === "function") el.addEventListener(k.slice(2).toLowerCase(), v);
    else if (k === "value") el.value = v;
    else if (k === "checked") el.checked = !!v;
    else el.setAttribute(k, v === true ? "" : v);
  }
  for (const c of kids.flat()) if (c != null && c !== false) el.append(c.nodeType ? c : document.createTextNode(String(c)));
  return el;
}

const S = {
  settings: null, reports: [], modelLists: {}, health: {}, view: "home",
  run: null, currentId: null, editProvider: null, search: "",
};

// ---- small UI helpers --------------------------------------------------------------------------------
let toastTimer;
function toast(msg) {
  const t = $("#toast");
  t.textContent = msg; t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (t.hidden = true), 2600);
}

function ask({ title, body, actions }) {
  return new Promise((resolve) => {
    const d = $("#dialog");
    d.replaceChildren(h("h3", {}, title), h("p", {}, body),
      h("div", { class: "actions" }, actions.map((a) => h("button", { class: "btn " + (a.primary ? "primary" : "ghost"), type: "button", onclick: () => { d.close(); resolve(a.value); } }, a.label))));
    d.addEventListener("close", () => resolve(null), { once: true });
    d.showModal();
  });
}

function download(name, text, type) {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const a = h("a", { href: url, download: name });
  document.body.append(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

let saveTimer;
async function persist({ rules = false } = {}) {
  await saveSettings(S.settings);
  if (rules) await applyNetRules(S.settings);
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => toast("Saved"), 150);
}

function showView(name) {
  S.view = name;
  for (const v of ["home", "run", "report", "settings"]) $("#view-" + v).hidden = v !== name;
  $("#main").scrollTo(0, 0);
  renderLibrary();
}

function applyTheme() {
  const t = S.settings.theme;
  if (t === "auto") document.documentElement.removeAttribute("data-theme");
  else document.documentElement.dataset.theme = t;
  $("#themeBtn").title = `Theme: ${t} (click to change)`;
}

function segmented(container, options, value, onChange) {
  container.replaceChildren(...options.map(([key, label]) =>
    h("button", { type: "button", "aria-pressed": String(key === value), onclick: () => onChange(key) }, label)));
}

// ---- library sidebar ---------------------------------------------------------------------------------
function renderLibrary() {
  const nav = $("#library");
  const q = S.search.trim().toLowerCase();
  const items = S.reports.filter((r) => !q || r.topic.toLowerCase().includes(q));
  if (!items.length) {
    nav.replaceChildren(h("div", { class: "lib-empty" }, S.reports.length ? "No matches." : "Your briefings will appear here."));
    return;
  }
  nav.replaceChildren(...items.map((r) => h("button", {
    type: "button", class: "lib-item" + (S.view === "report" && S.currentId === r.id ? " active" : ""),
    onclick: () => openReport(r.id),
  }, h("b", {}, r.topic), h("span", {}, `${r.date} · ${r.level} · ${r.citedCount} sources`))));
}

// ---- home --------------------------------------------------------------------------------------------
const estCalls = (depth, transcripts) => 1 + depth.sections.length + 1 + (transcripts ? depth.transcripts : 0) + 3;

function renderHome() {
  const s = S.settings;
  segmented($("#levelSeg"), LEVELS.map((l) => [l, l[0].toUpperCase() + l.slice(1)]), s.level, (v) => { s.level = v; persist(); renderHome(); });
  segmented($("#depthSeg"), Object.keys(PROFILES).map((d) => [d, d[0].toUpperCase() + d.slice(1)]), s.depth, (v) => { s.depth = v; persist(); renderHome(); });
  const d = PROFILES[s.depth];
  $("#depthHint").textContent = `About ${s.useLLM ? estCalls(d, s.videos && s.transcripts) : 0} model calls · up to ${d.webPages} web pages, ${d.wikiArticles} Wikipedia articles, ${d.videos} videos.`;
  for (const [id, key] of [["optLLM", "useLLM"], ["optVideos", "videos"], ["optTranscripts", "transcripts"], ["optVerify", "verify"]]) {
    const el = $("#" + id);
    el.checked = !!s[key];
    el.onchange = () => { s[key] = el.checked; persist(); renderHome(); };
  }
  $("#optTranscripts").disabled = !s.videos;
  renderModel();
  renderBanner();
  const recent = S.reports.slice(0, 6);
  $("#recentWrap").hidden = !recent.length;
  $("#recentChips").replaceChildren(...recent.map((r) => h("button", { class: "chip", type: "button", onclick: () => openReport(r.id) }, r.topic)));
}

function modelOptions(type) {
  const p = S.settings.providers[type];
  let list = S.modelLists[type] || [];
  if (type === "openrouter" && p.freeOnly) list = list.filter((m) => m.free);
  const chain = p.models.map((id) => list.find((m) => m.id === id) || { id, label: id });
  const rest = list.filter((m) => !p.models.includes(m.id));
  return { chain, rest };
}

function renderModel() {
  const s = S.settings, type = s.provider, p = s.providers[type];
  segmented($("#providerSeg"), Object.entries(PROVIDERS).map(([k, v]) => [k, v.label]), type, (v) => {
    s.provider = v; persist(); renderHome(); refreshModels(v);
  });
  const { chain, rest } = modelOptions(type);
  const sel = $("#modelSelect");
  const opt = (m) => h("option", { value: m.id, selected: m.id === p.models[0] }, m.id + (type === "openrouter" && m.free ? "  · free" : ""));
  if (!chain.length && !rest.length) {
    sel.replaceChildren(h("option", { value: "" }, S.health[type]?.state === "checking" ? "Loading models…" : "No models yet (see Settings)"));
    sel.disabled = true;
  } else {
    sel.disabled = false;
    const groups = [];
    if (chain.length) groups.push(h("optgroup", { label: "In your fallback chain" }, chain.map(opt)));
    if (rest.length) groups.push(h("optgroup", { label: "Available" }, rest.slice(0, 400).map(opt)));
    sel.replaceChildren(...groups);
    if (!chain.length) sel.value = "";
  }
  sel.onchange = () => {
    if (!sel.value) return;
    p.models = [sel.value, ...p.models.filter((m) => m !== sel.value)];
    persist(); renderHome();
  };

  const hl = S.health[type] || {};
  const st = $("#modelStatus");
  let cls = "", text = "";
  if (type === "openrouter" && !p.apiKey.trim()) { cls = "warn"; text = "Key needed"; }
  else if (hl.state === "checking") text = "Checking…";
  else if (hl.state === "ok") { cls = "ok"; text = type === "openrouter" ? "Ready" : `Connected · ${hl.count} model${hl.count === 1 ? "" : "s"}`; }
  else if (hl.state === "err") { cls = "err"; text = "Unreachable"; }
  st.className = "status " + cls; st.textContent = text;

  $("#modelHint").textContent =
    type === "openrouter" && !p.apiKey.trim() ? "Add a free OpenRouter key in Settings to use hosted models." :
    hl.state === "err" ? hl.message :
    p.models.length > 1 ? `If “${p.models[0]}” fails, it falls back to ${p.models.length - 1} more.` :
    PROVIDERS[type].blurb + ".";
}

function renderBanner() {
  const s = S.settings, cfg = buildConfig(s), el = $("#banner");
  if (!s.useLLM || cfg.llmAvailable || S.health[s.provider]?.state === "checking" ||
      (s.provider !== "openrouter" && (S.modelLists[s.provider] || []).length)) { el.replaceChildren(); return; }
  const msg = s.provider === "openrouter"
    ? "No OpenRouter key yet. Add a free key to write briefings, or switch to LM Studio or Ollama to run fully local."
    : `${PROVIDERS[s.provider].label} has no model selected${S.health[s.provider]?.state === "err" ? " and could not be reached" : ""}. Open Settings to connect it.`;
  el.replaceChildren(h("div", { class: "banner" }, h("p", {}, msg), h("button", { class: "btn primary small", type: "button", onclick: () => openSettings() }, "Open settings")));
}

async function refreshModels(type) {
  const cfg = buildConfig(S.settings, { provider: type }).provider;
  S.health[type] = { state: "checking" };
  if (type === S.settings.provider) renderModel();
  try {
    const list = await listModels(cfg);
    S.modelLists[type] = list;
    S.health[type] = { state: "ok", count: list.length };
    const p = S.settings.providers[type];
    if (type !== "openrouter" && !p.models.length && list.length) { // first run with a local server: pick something sensible
      p.models = [list[0].id];
      await saveSettings(S.settings);
      toast(`Selected ${list[0].id}`);
    }
  } catch (e) {
    S.modelLists[type] = [];
    S.health[type] = { state: "err", message: e.message };
  }
  if (S.view === "home") renderHome();
  if (S.view === "settings") renderSettings();
}

// ---- running a briefing ---------------------------------------------------------------------------------------
const STAGES = [["plan", "Plan"], ["gather", "Gather"], ["write", "Write"], ["save", "Save"]];
const SOURCE_NAMES = {
  wikipedia: "Wikipedia", web: "Web pages", arxiv: "arXiv", openalex: "OpenAlex", pubmed: "PubMed",
  google_news: "Google News", gdelt: "GDELT", videos: "YouTube",
};

function setBar(pct) { $("#bar").style.width = Math.min(100, Math.max(0, pct)) + "%"; }

function setStage(key) {
  const idx = key === "done" ? STAGES.length : STAGES.findIndex(([k]) => k === key);
  [...$("#stages").children].forEach((li, i) => { li.className = i < idx ? "done" : i === idx ? "active" : ""; });
}

function addLog(level, message) {
  const t = Math.round((Date.now() - S.run.startedAt) / 1000);
  $("#log").append(h("div", { class: level === "warn" ? "warn" : level === "err" ? "err" : "" }, `[${String(Math.floor(t / 60)).padStart(2, "0")}:${String(t % 60).padStart(2, "0")}] ${message}`));
  $("#log").scrollTop = 1e9;
}

function onEvent(ev) {
  const R = S.run;
  if (!R) return;
  if (ev.type === "stage") {
    setStage(ev.stage);
    $("#stepLabel").textContent = { plan: "Planning search queries…", gather: "Gathering free sources in parallel…", write: "Writing…" }[ev.stage] || "";
    if (ev.stage === "plan") setBar(4);
  } else if (ev.type === "source") {
    let chip = R.chips[ev.name];
    if (!chip) {
      chip = R.chips[ev.name] = h("div", { class: "src run" }, h("span", { class: "dot" }), h("div", {}, h("div", {}, SOURCE_NAMES[ev.name] || ev.name), h("small", {}, "searching…")));
      $("#srcGrid").append(chip);
      R.srcTotal++;
    }
    if (ev.status !== "start") {
      R.srcDone++;
      chip.className = "src " + ev.status;
      $(".dot", chip).textContent = ev.status === "ok" ? "✓" : "✕";
      $("small", chip).textContent = ev.status === "ok" ? `${ev.count} found` : (ev.error || "failed").slice(0, 70);
      chip.title = ev.error || "";
      if (ev.status === "fail") addLog("warn", `${SOURCE_NAMES[ev.name] || ev.name}: ${ev.error}`);
    }
    setBar(6 + 28 * (R.srcDone / Math.max(1, R.srcTotal)));
  } else if (ev.type === "step") {
    $("#stepLabel").textContent = ev.label;
    setBar(35 + 62 * (ev.done / Math.max(1, ev.total)));
    addLog("info", ev.label);
  } else if (ev.type === "log") addLog(ev.level, ev.message);
}

async function startRun(rawTopic) {
  const topic = (rawTopic || "").trim();
  if (!topic) { $("#topic").focus(); return; }
  if (S.run) { toast("A briefing is already being built."); return; }
  const s = S.settings;
  let cfg = buildConfig(s);

  if (s.useLLM && !cfg.llmAvailable) {
    const why = s.provider === "openrouter" && !cfg.provider.apiKey
      ? "There's no OpenRouter API key yet, so no model can write the briefing."
      : `No model is selected for ${PROVIDERS[s.provider].label}.`;
    const choice = await ask({
      title: "No model ready", body: `${why} You can continue with sourced excerpts only, or set one up first.`,
      actions: [{ label: "Open settings", value: "settings" }, { label: "Continue without a model", value: "go", primary: true }],
    });
    if (choice === "settings") return openSettings();
    if (choice !== "go") return;
  }

  S.run = { topic, startedAt: Date.now(), abort: new AbortController(), chips: {}, srcTotal: 0, srcDone: 0, timer: null };
  $("#runTopic").textContent = topic;
  $("#runModel").textContent = cfg.useLLM && cfg.llmAvailable ? `${cfg.provider.label} · ${cfg.provider.models[0]}` : "No language model: sourced excerpts only";
  $("#srcGrid").replaceChildren(); $("#log").replaceChildren(); $("#runError").hidden = true;
  $("#cancelBtn").hidden = false; $("#cancelBtn").disabled = false;
  $("#stages").replaceChildren(...STAGES.map(([, label]) => h("li", {}, label)));
  setStage("plan"); setBar(2); $("#stepLabel").textContent = "Starting…";
  S.run.timer = setInterval(() => { $("#elapsed").textContent = Math.round((Date.now() - S.run.startedAt) / 1000) + "s"; }, 1000);
  showView("run");

  try {
    const report = await generateBriefing(topic, cfg, { emit: onEvent, signal: S.run.abort.signal });
    setStage("save"); setBar(98); $("#stepLabel").textContent = "Saving…";
    const final = finalize(report);
    const rec = {
      id: `${report.generatedAt}-${slugify(topic, 40)}-${Date.now().toString(36)}`, topic, date: report.generatedAt,
      level: report.level, depth: report.depth, mode: report.mode, models: report.modelsUsed,
      citedCount: final.refs.length, totalCount: report.sources.length, seconds: report.seconds, createdAt: Date.now(), report,
    };
    await saveReport(rec);
    S.reports = await listReports();
    setStage("done"); setBar(100);
    await openReport(rec.id);
  } catch (e) {
    if (e.name === "AbortError") { toast("Cancelled"); showView("home"); renderHome(); }
    else {
      addLog("err", e.message);
      const box = $("#runError");
      box.replaceChildren(h("strong", {}, "Couldn't build this briefing"), h("p", {}, e.message),
        h("button", { class: "btn ghost", type: "button", onclick: () => { showView("home"); $("#topic").value = topic; } }, "Back"));
      box.hidden = false; $("#cancelBtn").hidden = true;
    }
  } finally {
    clearInterval(S.run?.timer);
    S.run = null;
    runCtx.signal = null;
  }
}

async function surprise() {
  if (S.run) return;
  const btn = $("#surpriseBtn");
  btn.disabled = true; btn.textContent = "Picking a topic…";
  try {
    const [topic, why] = await pickTopic(await studiedTopics(), readInterests(S.settings.interests), new Cache());
    $("#topic").value = topic;
    toast(`Today's topic: ${topic} (${why})`);
    btn.disabled = false; btn.textContent = "✨ Surprise me with today's topic";
    await startRun(topic);
  } catch (e) {
    toast("Couldn't pick a topic: " + e.message);
  } finally {
    btn.disabled = false; btn.textContent = "✨ Surprise me with today's topic";
  }
}

// ---- report view ------------------------------------------------------------------------------------------------
async function openReport(id) {
  const rec = await getReport(id);
  if (!rec) { toast("That briefing is no longer in your library."); return showView("home"); }
  S.currentId = id;
  const final = finalize(rec.report);
  const art = $("#report");
  art.innerHTML = renderBodyHtml(final); // every dynamic value is escaped by render.js; links are http(s) only

  art.querySelectorAll("ul.next li").forEach((li) => {
    const topic = li.querySelector("strong")?.textContent;
    if (topic) li.append(h("button", { class: "btn small ghost", type: "button", onclick: () => { showView("home"); $("#topic").value = topic; startRun(topic); } }, "Learn this →"));
  });
  const heads = [...art.querySelectorAll("h2")];
  $("#toc").replaceChildren(h("b", {}, "On this page"), ...heads.map((hd) =>
    h("a", { href: "#" + hd.id, onclick: (e) => { e.preventDefault(); hd.scrollIntoView({ behavior: "smooth", block: "start" }); } }, hd.textContent)));
  showView("report");
}

function currentRecord() { return S.reports.find((r) => r.id === S.currentId); }

async function exportAs(kind) {
  const rec = currentRecord();
  if (!rec) return;
  const final = finalize(rec.report), base = `${rec.date}-${slugify(rec.topic)}`;
  if (kind === "md") download(`${base}-briefing.md`, renderMarkdown(final), "text/markdown");
  else if (kind === "html") download(`${base}-briefing.html`, renderHtml(final), "text/html");
  else if (kind === "anki") download(`${base}-flashcards.tsv`, renderAnki(final), "text/tab-separated-values");
  else if (kind === "json") download(`${base}-sources.json`, JSON.stringify(sourcesJson(final), null, 2) + "\n", "application/json");
  else if (kind === "copy") { await navigator.clipboard.writeText(renderMarkdown(final)); toast("Markdown copied"); }
  else if (kind === "print") window.print();
}

// ---- settings ---------------------------------------------------------------------------------------------------------
function openSettings(tab) {
  S.editProvider = tab || S.editProvider || S.settings.provider;
  renderSettings();
  showView("settings");
  if (!S.modelLists[S.editProvider] && S.health[S.editProvider]?.state !== "checking") refreshModels(S.editProvider);
}

function field(label, input, help) {
  return h("div", { class: "field" }, h("label", {}, label), input, help ? h("small", {}, help) : null);
}

function bind(input, obj, key, { number = false, rules = false, normalize = null, after = null } = {}) {
  input.addEventListener("change", async () => {
    let v = input.type === "checkbox" ? input.checked : input.value;
    if (number) v = Number(v) || 0;
    if (normalize) { v = normalize(v); input.value = v; }
    obj[key] = v;
    await persist({ rules });
    if (after) after();
  });
  return input;
}

function chainEditor(type) {
  const p = S.settings.providers[type];
  const wrap = h("div", { class: "field" });
  const list = h("ol", { class: "chain-list" });
  const dl = h("datalist", { id: "models-" + type });
  const input = h("input", { type: "text", list: "models-" + type, placeholder: type === "openrouter" ? "Type to search, e.g. meta-llama/…:free" : "Model name" });
  const add = () => {
    const v = input.value.trim();
    if (!v || p.models.includes(v)) { input.value = ""; return; }
    p.models.push(v); input.value = ""; persist(); draw();
  };
  const move = (i, d) => { const j = i + d; if (j < 0 || j >= p.models.length) return; [p.models[i], p.models[j]] = [p.models[j], p.models[i]]; persist(); draw(); };
  function draw() {
    const known = new Map((S.modelLists[type] || []).map((m) => [m.id, m]));
    const all = type === "openrouter" && p.freeOnly ? (S.modelLists[type] || []).filter((m) => m.free) : S.modelLists[type] || [];
    dl.replaceChildren(...all.slice(0, 600).map((m) => h("option", { value: m.id }, m.label !== m.id ? m.label : "")));
    list.replaceChildren(...(p.models.length ? p.models.map((id, i) => h("li", {},
      h("span", { class: "tag" }, i === 0 ? "primary" : "fallback " + i),
      h("code", { title: id }, id),
      type === "openrouter" && known.get(id)?.free ? h("span", { class: "tag free" }, "free") : null,
      h("button", { type: "button", title: "Move up", onclick: () => move(i, -1) }, "↑"),
      h("button", { type: "button", title: "Move down", onclick: () => move(i, 1) }, "↓"),
      h("button", { type: "button", title: "Remove", onclick: () => { p.models.splice(i, 1); persist(); draw(); } }, "✕"))) :
      [h("li", {}, h("span", { class: "muted" }, "No models yet. Load the list below or type a model id."))]));
  }
  input.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); add(); } });
  draw();
  wrap.append(h("label", {}, "Model chain"), list,
    h("div", { class: "inline", style: "margin-top:10px" }, input, h("button", { class: "btn ghost", type: "button", onclick: add }, "Add")),
    dl, h("small", {}, "Tried in order: if the primary model errors or is rate-limited, the next one takes over."));
  wrap.redraw = draw;
  return wrap;
}

function providerCard() {
  const s = S.settings, type = S.editProvider, p = s.providers[type], meta = PROVIDERS[type];
  const card = h("div", { class: "card" });
  const tabs = h("div", { class: "seg", style: "margin-bottom:18px" });
  segmented(tabs, Object.entries(PROVIDERS).map(([k, v]) => [k, v.label]), type, (k) => openSettings(k));
  const active = s.provider === type;
  card.append(h("div", { class: "set-head" }, h("h2", {}, "Language model"),
    active ? h("span", { class: "status ok" }, "Active provider")
           : h("button", { class: "btn small primary", type: "button", onclick: () => { s.provider = type; persist(); renderSettings(); } }, `Use ${meta.label}`)),
    h("p", {}, "Pick where briefings are written. Search and sources stay free whichever you choose."), tabs);

  if (type === "openrouter") {
    const key = bind(h("input", { type: "password", value: p.apiKey, placeholder: "sk-or-v1-…", autocomplete: "off", spellcheck: "false" }), p, "apiKey", { after: () => { renderModel(); } });
    card.append(
      field("API key", h("div", { class: "inline" }, key, h("button", { class: "btn ghost", type: "button", onclick: (e) => { key.type = key.type === "password" ? "text" : "password"; e.target.textContent = key.type === "password" ? "Show" : "Hide"; } }, "Show")),
        "Free models need no payment method. Stored only in this browser profile and sent only to OpenRouter."),
      h("div", { class: "field" }, h("a", { href: "https://openrouter.ai/keys", target: "_blank", rel: "noopener noreferrer" }, "Get a free key at openrouter.ai/keys ↗")),
      field("", h("label", { class: "check", style: "margin:0" }, bind(h("input", { type: "checkbox", checked: p.freeOnly }), p, "freeOnly", { after: () => { renderSettings(); } }), h("span", {}, "Only list free models", h("small", {}, "Hides paid models from the pickers")))),
    );
  } else if (type === "lmstudio") {
    card.append(field("Server address", bind(h("input", { type: "text", value: p.baseUrl, spellcheck: "false" }), p, "baseUrl", { rules: true, normalize: (v) => normalizeBaseUrl("lmstudio", v), after: () => refreshModels("lmstudio") }),
      "In LM Studio open the Developer tab, load a model and start the server (default http://localhost:1234/v1)."));
  } else {
    card.append(field("Server address", bind(h("input", { type: "text", value: p.baseUrl, spellcheck: "false" }), p, "baseUrl", { rules: true, normalize: (v) => normalizeBaseUrl("ollama", v), after: () => refreshModels("ollama") }),
      "Default http://localhost:11434. No OLLAMA_ORIGINS setting is needed: the extension handles that for you."),
      field("Context window (num_ctx)", bind(h("input", { type: "number", min: "2048", step: "1024", value: p.numCtx }), p, "numCtx", { number: true }),
        "Ollama's own default is small and silently truncates long prompts. 8192 suits the default evidence size; raise it if you have the memory."));
  }
  const chain = chainEditor(type);
  const out = h("div", { class: "test-out" });
  const load = h("button", { class: "btn ghost", type: "button" }, type === "openrouter" ? "Load model list" : "Detect models");
  load.onclick = async () => {
    load.disabled = true; load.textContent = "Loading…"; out.className = "test-out"; out.textContent = "";
    await persist();
    await refreshModels(type);
    const hl = S.health[type];
    out.className = "test-out " + (hl.state === "ok" ? "ok" : "err");
    out.textContent = hl.state === "ok" ? `Found ${hl.count} model${hl.count === 1 ? "" : "s"}.` : hl.message;
    load.disabled = false; load.textContent = type === "openrouter" ? "Load model list" : "Detect models";
    chain.redraw();
  };
  const test = h("button", { class: "btn ghost", type: "button" }, "Test connection");
  test.onclick = async () => {
    const cfg = buildConfig(s, { provider: type }).provider;
    if (!cfg.models.length) { out.className = "test-out err"; out.textContent = "Add a model to the chain first."; return; }
    if (type === "openrouter" && !cfg.apiKey) { out.className = "test-out err"; out.textContent = "Enter your API key first."; return; }
    test.disabled = true; test.textContent = "Testing…"; out.className = "test-out"; out.textContent = `Asking ${cfg.models[0]}…`;
    runCtx.signal = null;
    try {
      const r = await testModel(cfg, cfg.models[0]);
      out.className = "test-out ok"; out.textContent = `✓ ${r.served} answered in ${(r.ms / 1000).toFixed(1)}s`;
    } catch (e) { out.className = "test-out err"; out.textContent = "✕ " + e.message; }
    test.disabled = false; test.textContent = "Test connection";
  };
  card.append(chain, h("div", { class: "inline", style: "margin-top:12px" }, load, test), out);

  const adv = h("div", { class: "field-row" },
    field("Seconds between calls", bind(h("input", { type: "number", min: "0", step: "0.5", value: p.minInterval }), p, "minInterval", { number: true }),
      type === "openrouter" ? "Free tiers rate-limit hard. Raise this if you see 429 errors." : "0 is fine for a local model."),
    field("Evidence per call (characters)", bind(h("input", { type: "number", min: "2000", step: "1000", value: p.contextChars }), p, "contextChars", { number: true }),
      "Lower this for small local models (try 6000)."));
  card.append(adv);
  return card;
}

function settingsCards() {
  const s = S.settings;
  const sources = h("div", { class: "card" }, h("h2", {}, "Sources"),
    h("p", {}, "Wikipedia, arXiv, OpenAlex, PubMed, Google News, GDELT, DuckDuckGo and YouTube. No keys needed."),
    field("Contact email (optional)", bind(h("input", { type: "text", value: s.contactEmail, placeholder: "you@example.com", autocomplete: "off" }), s, "contactEmail"),
      "Sent to OpenAlex and PubMed only, which gives you their faster, polite-pool service."));

  const daily = h("div", { class: "card" }, h("h2", {}, "Daily topic"),
    h("p", {}, "“Surprise me” works through your list first, then Wikipedia's featured article, on-this-day and random articles. It never repeats a topic you've studied."),
    field("Topics you want to learn (one per line)", bind(h("textarea", { rows: "5", placeholder: "How vaccines train the immune system\nThe history of zero\nPublic-key cryptography" }, s.interests), s, "interests")),
    h("div", { class: "field" }, h("label", { class: "check", style: "margin:0" },
      bind(h("input", { type: "checkbox", checked: s.daily.enabled }), s.daily, "enabled"),
      h("span", {}, "Remind me with a daily topic", h("small", {}, "A notification appears at the time below while Chrome is open; click it to generate. Generation needs the app tab open, so it never runs unattended.")))),
    field("Time", bind(h("input", { type: "time", value: s.daily.time, style: "max-width:160px" }), s.daily, "time")));

  const clear = h("button", { class: "btn ghost", type: "button", onclick: async () => { await clearCache(); toast("Cache cleared"); } }, "Clear cache");
  const exportAll = h("button", { class: "btn ghost", type: "button", onclick: async () => {
    download(`daily-learn-library-${todayISO()}.json`, JSON.stringify(await listReports(), null, 2), "application/json");
  } }, "Export library (JSON)");
  const data = h("div", { class: "card" }, h("h2", {}, "Data"),
    h("p", {}, `${S.reports.length} briefing${S.reports.length === 1 ? "" : "s"} stored locally in this browser. The cache holds downloaded pages and model replies so a failed run can resume without spending your free quota again.`),
    h("div", { class: "inline" }, clear, exportAll));
  return [sources, daily, data];
}

function renderSettings() {
  S.editProvider = S.editProvider || S.settings.provider;
  $("#view-settings").replaceChildren(
    h("div", { class: "set-head" }, h("h1", {}, "Settings"), h("button", { class: "btn primary", type: "button", onclick: () => { showView("home"); renderHome(); } }, "Done")),
    providerCard(), ...settingsCards());
}

// ---- init ---------------------------------------------------------------------------------------------------------------
async function init() {
  S.settings = await loadSettings();
  applyTheme();
  await applyNetRules(S.settings);
  pruneCache().catch(() => {});
  S.reports = await listReports();

  $("#topicForm").addEventListener("submit", (e) => { e.preventDefault(); startRun($("#topic").value); });
  $("#surpriseBtn").addEventListener("click", surprise);
  $("#newBtn").addEventListener("click", () => { showView("home"); renderHome(); $("#topic").focus(); });
  $("#backBtn").addEventListener("click", () => { showView("home"); renderHome(); $("#topic").focus(); });
  $("#settingsBtn").addEventListener("click", () => openSettings());
  $("#cancelBtn").addEventListener("click", () => { S.run?.abort.abort(); $("#cancelBtn").disabled = true; $("#stepLabel").textContent = "Cancelling…"; });
  $("#libSearch").addEventListener("input", (e) => { S.search = e.target.value; renderLibrary(); });
  $("#themeBtn").addEventListener("click", () => {
    const order = ["auto", "light", "dark"];
    S.settings.theme = order[(order.indexOf(S.settings.theme) + 1) % 3];
    applyTheme(); persist();
  });
  $("#exportBtn").addEventListener("click", (e) => { e.stopPropagation(); $("#exportMenu").hidden = !$("#exportMenu").hidden; });
  document.addEventListener("click", () => { $("#exportMenu").hidden = true; });
  $("#exportMenu").addEventListener("click", (e) => { const x = e.target.closest("[data-x]")?.dataset.x; if (x) exportAs(x); });
  $("#deleteBtn").addEventListener("click", async () => {
    const rec = currentRecord();
    if (!rec) return;
    const ok = await ask({ title: "Delete this briefing?", body: `“${rec.topic}” will be removed from your library. This can't be undone.`,
      actions: [{ label: "Cancel", value: false }, { label: "Delete", value: true, primary: true }] });
    if (!ok) return;
    await deleteReport(rec.id);
    S.reports = await listReports(); S.currentId = null;
    showView("home"); renderHome(); toast("Deleted");
  });
  window.addEventListener("beforeunload", (e) => { if (S.run) { e.preventDefault(); e.returnValue = ""; } });

  showView("home");
  renderHome();
  refreshModels(S.settings.provider);

  const q = new URLSearchParams(location.search);
  history.replaceState(null, "", location.pathname);
  if (q.get("open")) await openReport(q.get("open"));
  else if (q.get("welcome")) openSettings();
  else if (q.get("start") && q.get("daily")) surprise();
  else if (q.get("start") && q.get("topic")) { $("#topic").value = q.get("topic"); startRun(q.get("topic")); }
}

init().catch((e) => { console.error(e); document.body.prepend(h("pre", { style: "padding:20px;color:#c0392b" }, "Daily Learn failed to start: " + e.message)); });
