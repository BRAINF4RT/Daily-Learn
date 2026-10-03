import { listReports } from "./lib/cache.js";

const app = chrome.runtime.getURL("app.html");
const go = (qs = "") => { chrome.tabs.create({ url: app + qs }); window.close(); };

document.getElementById("f").addEventListener("submit", (e) => {
  e.preventDefault();
  const topic = document.getElementById("t").value.trim();
  if (topic) go(`?start=1&topic=${encodeURIComponent(topic)}`);
});
document.getElementById("surprise").addEventListener("click", () => go("?start=1&daily=1"));
document.getElementById("open").addEventListener("click", () => go());

listReports().then((list) => {
  if (!list.length) return;
  document.getElementById("recentLabel").hidden = false;
  const ul = document.getElementById("recent");
  for (const r of list.slice(0, 5)) {
    const li = document.createElement("li"), a = document.createElement("a");
    a.href = "#"; a.textContent = r.topic; a.title = r.topic;
    a.addEventListener("click", (e) => { e.preventDefault(); go(`?open=${encodeURIComponent(r.id)}`); });
    li.append(a); ul.append(li);
  }
}).catch(() => {});
