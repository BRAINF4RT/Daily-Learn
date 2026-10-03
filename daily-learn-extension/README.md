# Daily Learn (Chrome extension)

A port of the `daily-learn` Python tool. Type any topic and get a sourced, plainly explained briefing: key terms,
sections, a timeline, what the research says, recent news, videos with key moments, a quiz, next topics, and numbered
references. Free sources only. You choose the model: **OpenRouter**, **LM Studio** or **Ollama**.

## Install (free, no store)
1. Open `chrome://extensions` and switch on **Developer mode** (top right).
2. Click **Load unpacked** and select this `daily-learn-extension` folder (the one containing `manifest.json`).
3. Pin the extension. The setup screen opens on first install.

## Pick a model (Settings → Language model)
| Provider | What you need |
|---|---|
| **OpenRouter** | A free key from openrouter.ai/keys. Defaults to `openrouter/free`, then a free Nemotron model. Use "Load model list" to browse; "Only list free models" is on by default. |
| **LM Studio** | Load a model, open the Developer tab, start the server (`http://localhost:1234/v1`). Click "Detect models". |
| **Ollama** | `ollama serve` running (`http://localhost:11434`) and a pulled model. No `OLLAMA_ORIGINS` setup: the extension strips the Origin header on requests to your local servers. |

Each provider has an ordered **model chain**: if the first model errors or is rate-limited, the next takes over.
"Test connection" sends one tiny request to prove the key, address and model all work.
Small local models: lower "Evidence per call" (try 6000) and use **Quick** depth.

## Using it
- Toolbar popup: type a topic, or "Surprise me" (your list of interests first, then Wikipedia's featured article /
  on-this-day / random; never repeats).
- Choose level (beginner/intermediate/advanced) and depth (quick/standard/deep) on the home screen.
- Briefings are saved in your browser (IndexedDB) and listed in the sidebar. Export as Markdown, HTML, Anki TSV,
  sources JSON, copy, or print to PDF.
- Optional daily reminder (Settings → Daily topic): a notification at your chosen time; click it to generate.
  Keep the app tab open while a briefing builds (it takes a minute or two).

## What differs from the Python version
- **Web search** uses DuckDuckGo's HTML endpoint (the Python `ddgs` library isn't available in a browser). DuckDuckGo
  rate-limits; when it does, the run continues with Wikipedia, papers and news and says so under "Run note".
- **Videos** come from YouTube's results page, and transcripts from YouTube's caption data. Both are unofficial and can
  break or be blocked (consent screens, no captions); the briefing then summarises from the description and says so.
  YouTube relative dates ("2 years ago") are shown as-is.
- DuckDuckGo News was dropped (Google News RSS and GDELT remain). PubMed, arXiv, OpenAlex and Wikipedia are unchanged.
- No GitHub Actions: this runs in your browser, so nothing runs unattended.
- Everything else (BM25 evidence selection, one small call per section, citation stripping/renumbering, the lexical
  fact-check, trust labels, robots.txt) is ported as-is.

## Privacy
Your topic goes to the free sources and to the model provider you choose. With LM Studio or Ollama the model never
leaves your machine. The OpenRouter key is stored in `chrome.storage.local` in this profile only.
The extension requests access to all sites because it fetches pages and APIs directly; it only contacts them during a run.

## Files
`manifest.json`, `background.js` (reminders, network rules), `popup.*`, `app.html/.css/.js` (UI), and `lib/`:
`pipeline.js` (plan, gather, write), `sources.js`, `llm.js` (3 providers), `citations.js`, `ranking.js`, `render.js`,
`trust.js` (edit the domain lists), `cache.js`, `http.js`, `config.js`, `daily.js`, `netrules.js`.
