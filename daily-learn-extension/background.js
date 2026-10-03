// Service worker: opens the app, and (optionally) nudges you once a day with a topic to learn.
import { studiedTopics } from "./lib/cache.js";
import { loadSettings, saveSettings } from "./lib/config.js";
import { pickTopic, readInterests } from "./lib/daily.js";
import { applyNetRules } from "./lib/netrules.js";

const APP = chrome.runtime.getURL("app.html");
const ALARM = "daily-learn-daily";

function nextRun(time) {
  const [h, m] = (time || "08:00").split(":").map(Number);
  const d = new Date();
  d.setHours(h || 0, m || 0, 0, 0);
  if (d.getTime() <= Date.now()) d.setDate(d.getDate() + 1);
  return d.getTime();
}

async function schedule() {
  const s = await loadSettings();
  await chrome.alarms.clear(ALARM);
  if (s.daily.enabled) chrome.alarms.create(ALARM, { when: nextRun(s.daily.time) });
}

async function notifyToday() {
  const s = await loadSettings();
  if (!s.daily.enabled) return;
  const day = new Date().toISOString().slice(0, 10);
  if (s.daily.last === day) return;
  try {
    const [topic, why] = await pickTopic(await studiedTopics(), readInterests(s.interests));
    s.daily.last = day;
    await saveSettings(s);
    await chrome.storage.local.set({ pendingTopic: { topic, why, day } });
    chrome.notifications.create("daily-learn-topic", {
      type: "basic", iconUrl: "icons/icon128.png", title: "Today's topic: " + topic,
      message: `Picked from ${why}. Click to generate your briefing.`, priority: 1,
    });
  } catch (e) { console.warn("Daily Learn: could not pick a topic", e); }
}

chrome.runtime.onInstalled.addListener(async (details) => {
  const s = await loadSettings();
  await applyNetRules(s);
  await schedule();
  if (details.reason === "install") chrome.tabs.create({ url: APP + "?welcome=1" });
});
chrome.runtime.onStartup.addListener(async () => {
  await schedule();
  const s = await loadSettings();
  if (s.daily.enabled && s.daily.last !== new Date().toISOString().slice(0, 10)) {
    const [h, m] = (s.daily.time || "08:00").split(":").map(Number);
    const due = new Date(); due.setHours(h || 0, m || 0, 0, 0);
    if (Date.now() >= due.getTime()) await notifyToday(); // missed while the browser was closed
  }
});
chrome.alarms.onAlarm.addListener(async (a) => {
  if (a.name !== ALARM) return;
  await notifyToday();
  await schedule();
});
chrome.notifications.onClicked.addListener(async (id) => {
  if (id !== "daily-learn-topic") return;
  const { pendingTopic } = await chrome.storage.local.get("pendingTopic");
  chrome.notifications.clear(id);
  const q = pendingTopic ? `?start=1&topic=${encodeURIComponent(pendingTopic.topic)}` : "";
  chrome.tabs.create({ url: APP + q });
});
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "local" && changes.settings) schedule();
});
