// declarativeNetRequest rules that only touch requests made BY this extension:
//  - Ollama rejects browser requests whose Origin is chrome-extension://... (403) unless OLLAMA_ORIGINS is set.
//    Dropping the Origin header on requests to your local servers makes it work with no server configuration.
//  - DuckDuckGo and YouTube get a normal same-site Origin/Referer, like a request from their own pages.
import { normalizeBaseUrl } from "./config.js";

const safeOrigin = (u) => { try { return new URL(u).origin; } catch { return null; } };

export async function applyNetRules(settings) {
  const dnr = globalThis.chrome?.declarativeNetRequest;
  if (!dnr?.updateDynamicRules) return;
  const initiator = chrome.runtime.id;
  const rules = [];
  let id = 1;

  for (const type of ["lmstudio", "ollama"]) {
    const origin = safeOrigin(normalizeBaseUrl(type, settings.providers[type].baseUrl));
    if (!origin) continue;
    rules.push({
      id: id++, priority: 1,
      action: { type: "modifyHeaders", requestHeaders: [{ header: "Origin", operation: "remove" }] },
      condition: { urlFilter: `|${origin}/`, resourceTypes: ["xmlhttprequest"], initiatorDomains: [initiator] },
    });
  }
  const sameSite = (origin, filter) => ({
    id: id++, priority: 1,
    action: {
      type: "modifyHeaders",
      requestHeaders: [
        { header: "Origin", operation: "set", value: origin },
        { header: "Referer", operation: "set", value: origin + "/" },
      ],
    },
    condition: { urlFilter: filter, resourceTypes: ["xmlhttprequest"], initiatorDomains: [initiator] },
  });
  rules.push(sameSite("https://html.duckduckgo.com", "|https://html.duckduckgo.com/"));
  rules.push(sameSite("https://lite.duckduckgo.com", "|https://lite.duckduckgo.com/"));
  rules.push(sameSite("https://www.youtube.com", "|https://www.youtube.com/youtubei/"));

  try {
    const existing = await dnr.getDynamicRules();
    await dnr.updateDynamicRules({ removeRuleIds: existing.map((r) => r.id), addRules: rules });
  } catch (e) {
    console.warn("Daily Learn: could not install network rules", e);
  }
}
