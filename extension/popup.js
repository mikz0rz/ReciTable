// The dropdown: start a conversion, and see where the current one got to.
//
// It renders the run log the background worker writes to session storage and
// keeps no state of its own, so closing and reopening it shows the truth —
// including a failure that happened while it was shut. Chrome closes a popup
// whenever it loses focus, which is why the run also has its own tab and the
// toolbar badge: those are what you watch once you look away.

import { PROVIDERS } from "./shared/providers.js";
import { renderRunLog, runHeadline, errorDetail, diagnostics } from "./shared/runlog.js";

const goButton = document.getElementById("go");
const runBox = document.getElementById("run");
const stepList = document.getElementById("steps");
const outcome = document.getElementById("outcome");
const tools = document.getElementById("tools");
const openButton = document.getElementById("open");
const configLine = document.getElementById("config");

let latest = null;
let ticker = null;

function render(run) {
  latest = run;
  if (!run) {
    runBox.className = "";
    return;
  }
  runBox.className = "show";
  renderRunLog(stepList, run);

  outcome.className = "run-outcome";
  outcome.replaceChildren();
  tools.hidden = true;

  if (run.state === "running") {
    goButton.textContent = "Cancel";
    goButton.dataset.action = "cancel";
    goButton.disabled = false;
    outcome.className = "run-outcome show";
    outcome.textContent = "Working in a background tab — close this and carry on.";
    tools.hidden = false;
    openButton.hidden = false;
    openButton.textContent = "Watch it";
  } else {
    goButton.textContent = "Convert this recipe";
    goButton.dataset.action = "convert";
    goButton.disabled = false;
    outcome.className = run.state === "error" ? "run-outcome show error" : "run-outcome show";
    outcome.textContent = runHeadline(run);
    if (run.state === "error") {
      const why = document.createElement("span");
      why.className = "why";
      why.textContent = errorDetail(run);
      outcome.append(why);
    }
    tools.hidden = false;
    openButton.hidden = !(run.viewerId || run.progressTabId);
    openButton.textContent = "Open table";
  }

  if (run.state === "running" && !ticker) {
    ticker = setInterval(() => latest && renderRunLog(stepList, latest), 250);
  } else if (run.state !== "running" && ticker) {
    clearInterval(ticker);
    ticker = null;
  }
}

async function refreshConfig() {
  const { provider = "openrouter", keys = {}, model = "" } = await chrome.storage.local.get([
    "provider", "keys", "model",
  ]);
  const label = PROVIDERS[provider]?.label || provider;
  const hasKey = Boolean(keys[provider]);
  configLine.textContent = hasKey ? `${label} · ${model || "no model"}` : `${label} · no key`;
  if (hasKey && model) return;

  goButton.disabled = true;
  runBox.className = "show";
  outcome.className = "run-outcome show";
  outcome.textContent = hasKey ? "Pick a model in settings." : "Add an API key to get started.";
  const why = document.createElement("span");
  why.className = "why";
  why.textContent = "OpenRouter has models that cost nothing.";
  outcome.append(why);
}

/** Bring the run's own tab forward, or open the finished table in a new one. */
async function showTheRun() {
  if (!latest) return;
  if (latest.progressTabId) {
    try {
      const tab = await chrome.tabs.get(latest.progressTabId);
      await chrome.tabs.update(tab.id, { active: true });
      await chrome.windows.update(tab.windowId, { focused: true });
      return;
    } catch {
      /* it was closed; fall through */
    }
  }
  if (latest.viewerId) {
    chrome.tabs.create({ url: chrome.runtime.getURL(`viewer.html?id=${latest.viewerId}`) });
  }
}

document.getElementById("settings").addEventListener("click", (event) => {
  event.preventDefault();
  chrome.runtime.openOptionsPage();
});

openButton.addEventListener("click", showTheRun);

document.getElementById("copy").addEventListener("click", async () => {
  await navigator.clipboard.writeText(diagnostics(latest));
  const button = document.getElementById("copy");
  button.textContent = "Copied";
  setTimeout(() => (button.textContent = "Copy diagnostics"), 1200);
});

goButton.addEventListener("click", async () => {
  if (goButton.dataset.action === "cancel") {
    goButton.disabled = true;
    await chrome.runtime.sendMessage({ type: "cancel" });
    return;
  }
  goButton.disabled = true;
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) {
    render({
      id: "none",
      state: "error",
      steps: [],
      startedAt: Date.now(),
      endedAt: Date.now(),
      error: { message: "No page to read here." },
    });
    return;
  }
  // The background owns the run from here; the log drives every view of it.
  chrome.runtime.sendMessage({ type: "convert", tabId: tab.id, url: tab.url }).catch(() => {});
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "session" && changes.run) render(changes.run.newValue);
});

async function init() {
  await refreshConfig();
  // Ask the worker to mark any run that died with it, then show what is there.
  await chrome.runtime.sendMessage({ type: "reconcile" }).catch(() => {});
  const stored = await chrome.storage.session.get("run");
  if (stored.run) render(stored.run);
}

init();
